// Docker driver: one fresh, locked-down container per compile step and per test case.
//
// Every container gets: no network, a non-root user, a read-only root
// filesystem, a small tmpfs at /tmp, all capabilities dropped,
// no-new-privileges, Docker's default seccomp profile, CPU/memory/PID limits,
// an inner `timeout -s KILL` wall clock and bounded captured output.
// Only the job's own /src (read-only) and /build folders are mounted.
import { spawn } from 'node:child_process';
import { LANGUAGES, LANGUAGE_IDS } from './languages.js';

export const CONTAINER_UID = '10001:10001';
const LABEL = 'code-arena.judge=1';

function runCli(binary, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn(binary, args, { windowsHide: true }); } catch (e) { resolve({ code: -1, out, err: e.message }); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 65536) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 65536) err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

export class DockerDriver {
  constructor({ binary = 'docker', instanceId, log = console }) {
    this.binary = binary;
    this.instanceId = instanceId;
    this.log = log;
    this.active = new Set(); // container names currently running
    this.counter = 0;
    this.name = 'docker';
  }

  async checkReady() {
    const ver = await runCli(this.binary, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8000 });
    if (ver.code !== 0) {
      const missing = ver.code === -1 && /ENOENT/.test(ver.err);
      return {
        ready: false,
        message: missing ? 'Docker is not installed or not on PATH.' : 'Docker is not running. Start Docker and the judge will recover automatically.',
        languages: Object.fromEntries(LANGUAGE_IDS.map((id) => [id, { ready: false }])),
      };
    }
    const languages = {};
    await Promise.all(LANGUAGE_IDS.map(async (id) => {
      const img = await runCli(this.binary, ['image', 'inspect', '--format', '{{.Id}}', LANGUAGES[id].image], { timeoutMs: 8000 });
      languages[id] = img.code === 0
        ? { ready: true, imageId: img.out.trim().slice(0, 19) }
        : { ready: false, message: `Image ${LANGUAGES[id].image} is missing. Run npm run judge:build.` };
    }));
    const allReady = Object.values(languages).every((l) => l.ready);
    return {
      ready: allReady,
      dockerVersion: ver.out.trim(),
      message: allReady ? 'Docker judge ready.' : 'Some judge images are missing. Run npm run judge:build.',
      languages,
    };
  }

  // Remove containers left behind by this app (for example after a crash).
  async cleanupOrphans() {
    const ps = await runCli(this.binary, ['ps', '-aq', '--filter', `label=${LABEL}`]);
    const ids = ps.code === 0 ? ps.out.split(/\s+/).filter(Boolean) : [];
    if (ids.length) {
      await runCli(this.binary, ['rm', '-f', ...ids]);
      this.log.info?.(`judge: removed ${ids.length} orphaned container(s)`);
    }
    return ids.length;
  }

  async shutdown() {
    const names = [...this.active];
    if (names.length) await runCli(this.binary, ['rm', '-f', ...names]);
  }

  async listJudgeContainers() {
    const ps = await runCli(this.binary, ['ps', '-aq', '--filter', `label=${LABEL}`]);
    return ps.out.split(/\s+/).filter(Boolean);
  }

  /**
   * Run one phase in a fresh container.
   * @returns {Promise<{exitCode:number|null, stdout:string, stderr:string, timedOut:boolean,
   *   outputExceeded:boolean, oomKilled:boolean, durationMs:number, infraError?:string}>}
   */
  runContainer({ language, phase, srcDir, buildDir, stdin = '', timeoutMs, stdoutCap, stderrCap, signal }) {
    const lang = LANGUAGES[language];
    const lim = lang.limits;
    const compile = phase === 'compile';
    const mem = compile ? lim.compileMemoryMb : lim.memoryMb;
    const name = `code-arena-${this.instanceId}-${process.pid}-${++this.counter}`;
    const seconds = (timeoutMs / 1000).toFixed(2);
    const args = [
      'run', '-i', '--name', name,
      '--label', LABEL, '--label', `code-arena.instance=${this.instanceId}`,
      '--network', 'none',
      '--user', CONTAINER_UID,
      '--read-only',
      '--tmpfs', `/tmp:rw,nosuid,nodev,size=${compile ? 512 : 32}m`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', String(compile ? Math.max(lim.pids, 128) : lim.pids),
      '--memory', `${mem}m`, '--memory-swap', `${mem}m`,
      '--cpus', String(lim.cpus),
      '--ulimit', 'fsize=67108864:67108864',
      '--ulimit', 'nofile=256:256',
      '--mount', `type=bind,source=${srcDir},target=/src,readonly`,
      '--mount', `type=bind,source=${buildDir},target=/build${compile ? '' : ',readonly'}`,
      '--workdir', '/tmp',
      '--env', 'HOME=/tmp',
      lang.image,
      'timeout', '-s', 'KILL', seconds,
      ...(compile ? lang.compile : lang.run),
    ];

    return new Promise((resolve) => {
      const started = Date.now();
      const res = { exitCode: null, stdout: '', stderr: '', timedOut: false, outputExceeded: false, oomKilled: false, durationMs: 0 };
      let outBytes = 0, errBytes = 0, settled = false, killedReason = null;
      this.active.add(name);
      let child;
      try { child = spawn(this.binary, args, { windowsHide: true }); } catch (e) {
        this.active.delete(name);
        resolve({ ...res, infraError: `cannot start docker: ${e.message}` });
        return;
      }
      const kill = (reason) => {
        if (killedReason) return;
        killedReason = reason;
        runCli(this.binary, ['kill', name], { timeoutMs: 10000 }).then(() => child.kill('SIGKILL'));
      };
      // Outer watchdog: the inner `timeout` normally fires first; this catches a hung daemon.
      const watchdog = setTimeout(() => kill('watchdog'), timeoutMs + 15000);
      const onAbort = () => kill('abort');
      signal?.addEventListener('abort', onAbort, { once: true });

      const outChunks = [], errChunks = [];
      child.stdout.on('data', (d) => {
        outBytes += d.length;
        if (outBytes > stdoutCap) { res.outputExceeded = true; kill('stdout'); return; }
        outChunks.push(d);
      });
      child.stderr.on('data', (d) => {
        errBytes += d.length;
        if (errBytes > stderrCap) { res.outputExceeded = true; kill('stderr'); return; }
        errChunks.push(d);
      });
      child.stdin.on('error', () => {}); // the program may exit without reading all input
      child.stdin.end(stdin);

      const finish = async (code, spawnErr) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        signal?.removeEventListener('abort', onAbort);
        res.exitCode = code;
        res.durationMs = Date.now() - started;
        res.stdout = Buffer.concat(outChunks).toString('utf8');
        res.stderr = Buffer.concat(errChunks).toString('utf8');
        if (spawnErr) res.infraError = `docker failed: ${spawnErr.message}`;
        else if (killedReason === 'watchdog') res.infraError = 'container did not stop in time';
        else if (killedReason === 'abort') res.infraError = 'job cancelled';
        else if (!res.outputExceeded && code !== 0) {
          // A non-zero exit can come from the program or from Docker itself (for example
          // the daemon is down: the CLI then exits 1, which must not look like a compile
          // error). Docker's own record of the container decides which it was.
          const lastErr = res.stderr.trim().split('\n').pop()?.slice(0, 200) || '';
          const ins = await runCli(this.binary, ['inspect', '--format', '{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.StartedAt}}', name]);
          const [recorded, oom, startedAt] = ins.out.trim().split(' ');
          if (ins.code !== 0 || !startedAt || startedAt.startsWith('0001-')) {
            res.infraError = `docker could not run the container (exit ${code}): ${lastErr}`;
          } else if (Number(recorded) !== code || code === 125 || code === 126 || code === 127) {
            res.infraError = `docker error (CLI exit ${code}, container exit ${recorded}): ${lastErr}`;
          } else if (code === 124) {
            res.timedOut = true;
          } else if (code === 137) {
            // SIGKILL: from the memory limit (OOM), from `timeout -s KILL` (which exits
            // 137, not 124, when it has to kill), or from the program itself.
            res.oomKilled = oom === 'true';
            // The inner timer starts after container start-up, so a timed-out run always
            // lasts at least the limit; an early self-kill stays a runtime error.
            if (!res.oomKilled && res.durationMs >= timeoutMs) res.timedOut = true;
          }
        }
        await runCli(this.binary, ['rm', '-f', name], { timeoutMs: 20000 });
        this.active.delete(name);
        resolve(res);
      };
      child.on('error', (e) => finish(null, e));
      child.on('close', (code) => finish(code));
    });
  }
}
