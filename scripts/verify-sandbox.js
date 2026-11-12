// Verifies the Docker sandbox from the inside and the outside.
//
//   npm run judge:sandbox
//
// Inside: probe programs run in real judge containers and report what they can do
// (network, user, capabilities, writable paths, mounts, process limits...).
// Outside: `docker inspect` on a live judge container confirms the applied HostConfig.
// Finally: no judge containers may be left behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../server/config.js';
import { DockerDriver } from '../server/judge/docker-driver.js';
import { LANGUAGES } from '../server/judge/languages.js';

const config = loadConfig();
if (config.judge.driver !== 'docker') { console.error('This check needs the Docker driver.'); process.exit(1); }
const driver = new DockerDriver({ binary: config.judge.dockerBinary, instanceId: 'sbx', log: { info: () => {} } });
const ready = await driver.checkReady();
if (!ready.languages.python?.ready) { console.error('Python judge image missing: run npm run judge:build'); process.exit(1); }

let failures = 0;
const check = (ok, what, detail = '') => { console.log(`  ${ok ? '✓' : '✗'}  ${what}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

function jobDirs(source, file = 'main.py') {
  fs.mkdirSync(config.scratchDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(config.scratchDir, 'sbx-'));
  const srcDir = path.join(root, 'src'), buildDir = path.join(root, 'build');
  fs.mkdirSync(srcDir); fs.mkdirSync(buildDir);
  fs.chmodSync(buildDir, 0o777);
  fs.writeFileSync(path.join(srcDir, file), source);
  return { root, srcDir, buildDir };
}
async function runPython(source, { stdin = '', timeoutMs = 8000, stdoutCap = 65536 } = {}) {
  const d = jobDirs(source);
  try {
    return await driver.runContainer({ language: 'python', phase: 'run', srcDir: d.srcDir, buildDir: d.buildDir, stdin, timeoutMs, stdoutCap, stderrCap: 65536 });
  } finally { fs.rmSync(d.root, { recursive: true, force: true }); }
}

console.log('Inside the container (Python probe):');
const probe = await runPython(String.raw`
import os, json, socket, subprocess
r = {}
r["uid"] = os.getuid(); r["gid"] = os.getgid()
st = open("/proc/self/status").read()
field = lambda k: [l.split(":",1)[1].strip() for l in st.splitlines() if l.startswith(k + ":")][0]
r["CapEff"] = field("CapEff"); r["CapPrm"] = field("CapPrm"); r["NoNewPrivs"] = field("NoNewPrivs"); r["Seccomp"] = field("Seccomp")
def can_write(p):
    try:
        with open(p, "w") as f: f.write("x")
        os.remove(p); return True
    except Exception as e: return type(e).__name__
r["write_root"] = can_write("/etc/ca-probe"); r["write_src"] = can_write("/src/ca-probe")
r["write_build"] = can_write("/build/ca-probe"); r["write_tmp"] = can_write("/tmp/ca-probe")
try:
    with open("/tmp/big", "wb") as f:
        for _ in range(64): f.write(b"\0" * (1 << 20))
    r["tmp_64mb"] = True
except Exception as e: r["tmp_64mb"] = type(e).__name__
finally:
    try: os.remove("/tmp/big")
    except Exception: pass
def net(host, port):
    try:
        s = socket.create_connection((host, port), timeout=2); s.close(); return True
    except Exception as e: return type(e).__name__
r["net_ip"] = net("1.1.1.1", 53)
try: socket.getaddrinfo("example.com", 80); r["dns"] = True
except Exception as e: r["dns"] = type(e).__name__
r["interfaces"] = sorted(os.listdir("/sys/class/net"))
r["docker_sock"] = os.path.exists("/var/run/docker.sock") or os.path.exists("/run/docker.sock")
mounts = [l.split()[1] for l in open("/proc/mounts")]
r["mounts"] = [m for m in mounts if m in ("/src", "/build", "/tmp") or m.startswith("/home") or m.startswith("/root") or "Users" in m]
r["home_entries"] = os.listdir("/home") if os.path.isdir("/home") else []
r["src_files"] = os.listdir("/src")
try: r["memory_max"] = open("/sys/fs/cgroup/memory.max").read().strip()
except Exception: r["memory_max"] = None
try: r["pids_max"] = open("/sys/fs/cgroup/pids.max").read().strip()
except Exception: r["pids_max"] = None
try: r["cpu_max"] = open("/sys/fs/cgroup/cpu.max").read().strip()
except Exception: r["cpu_max"] = None
print(json.dumps(r))
`);
let info = {};
try { info = JSON.parse(probe.stdout); } catch { console.log(probe.stdout, probe.stderr, probe.infraError); }
check(info.uid === 10001 && info.gid === 10001, 'runs as non-root user 10001:10001', `uid=${info.uid}`);
check(/^0+$/.test(info.CapEff || 'x') && /^0+$/.test(info.CapPrm || 'x'), 'all capabilities dropped', `CapEff=${info.CapEff}`);
check(info.NoNewPrivs === '1', 'no-new-privileges is set', `NoNewPrivs=${info.NoNewPrivs}`);
check(info.Seccomp === '2', 'default seccomp filter active', `Seccomp=${info.Seccomp}`);
check(info.write_root !== true, 'root filesystem is read-only', String(info.write_root));
check(info.write_src !== true, '/src is read-only', String(info.write_src));
check(info.write_build !== true, '/build is read-only while running tests', String(info.write_build));
check(info.write_tmp === true, '/tmp is writable');
check(info.tmp_64mb !== true, '/tmp is size-limited (64 MB write fails)', String(info.tmp_64mb));
check(info.net_ip !== true && info.dns !== true, 'no network (IP connect and DNS both fail)', `${info.net_ip} / ${info.dns}`);
check(JSON.stringify(info.interfaces) === '["lo"]', 'only the loopback interface exists', JSON.stringify(info.interfaces));
check(info.docker_sock === false, 'Docker socket is not mounted');
check(JSON.stringify((info.mounts || []).sort()) === '["/build","/src","/tmp"]', 'only /src, /build and /tmp are mounted', JSON.stringify(info.mounts));
check((info.src_files || []).join() === 'main.py', '/src contains only this job\'s source file', JSON.stringify(info.src_files));
check(info.memory_max === String(LANGUAGES.python.limits.memoryMb * 1024 * 1024), 'memory limit applied', `memory.max=${info.memory_max}`);
check(info.pids_max === String(LANGUAGES.python.limits.pids), 'PID limit applied', `pids.max=${info.pids_max}`);
check(/^100000 100000$/.test(info.cpu_max || ''), 'CPU limited to 1 core', `cpu.max=${info.cpu_max}`);

console.log('\nResource abuse:');
const bomb = await runPython('import os\nn = 0\ntry:\n    while True:\n        pid = os.fork()\n        if pid == 0:\n            import time; time.sleep(30)\n        n += 1\nexcept OSError as e:\n    print("fork stopped after", n, type(e).__name__)\n', { timeoutMs: 6000 });
check(/fork stopped after \d+ /.test(bomb.stdout) && Number(bomb.stdout.match(/after (\d+)/)?.[1]) < LANGUAGES.python.limits.pids, 'fork bomb is stopped by the PID limit', bomb.stdout.trim() || bomb.stderr.trim().slice(0, 80));
const hog = await runPython('x = []\nwhile True:\n    x.append(bytearray(10**7))\n');
check(hog.oomKilled === true, 'memory hog is OOM-killed and reported', `exit=${hog.exitCode} oomKilled=${hog.oomKilled}`);
const loop = await runPython('while True:\n    pass\n', { timeoutMs: 2000 });
check(loop.timedOut === true && loop.durationMs < 10000, 'infinite loop is killed at the time limit', `${loop.durationMs} ms`);
const spam = await runPython('import sys\nwhile True:\n    sys.stdout.write("x" * 65536)\n', { stdoutCap: 1 << 20 });
check(spam.outputExceeded === true, 'unbounded output is cut off at the cap');
const sleeper = await runPython('import time\ntime.sleep(60)\n', { timeoutMs: 2000 });
check(sleeper.timedOut === true, 'sleeping program is killed at the wall-clock limit', `${sleeper.durationMs} ms`);

console.log('\nIsolation between test cases:');
const first = await runPython('open("/tmp/carry", "w").write("secret")\nprint("wrote")\n');
const second = await runPython('import os\nprint(os.path.exists("/tmp/carry"))\n');
check(first.stdout.trim() === 'wrote' && second.stdout.trim() === 'False', 'files written in one case are gone in the next');

console.log('\nOutside the container (docker inspect of a live judge container):');
const live = runPython('import time\ntime.sleep(5)\n', { timeoutMs: 8000 });
let hc = null;
for (let i = 0; i < 40 && !hc; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const ids = await driver.listJudgeContainers();
  if (ids.length) {
    const ins = spawnSync('docker', ['inspect', '--format', '{{json .HostConfig}}|{{json .Config.User}}', ids[0]], { encoding: 'utf8' });
    if (ins.status === 0) { const [h, u] = ins.stdout.trim().split('|'); hc = { ...JSON.parse(h), User: JSON.parse(u) }; }
  }
}
await live;
if (!hc) check(false, 'could not inspect a live container');
else {
  check(hc.NetworkMode === 'none', 'HostConfig.NetworkMode = none');
  check(hc.ReadonlyRootfs === true, 'HostConfig.ReadonlyRootfs = true');
  check(JSON.stringify(hc.CapDrop) === '["ALL"]', 'HostConfig.CapDrop = ["ALL"]');
  check((hc.SecurityOpt || []).includes('no-new-privileges'), 'HostConfig.SecurityOpt includes no-new-privileges', JSON.stringify(hc.SecurityOpt));
  check(!(hc.SecurityOpt || []).some((o) => /seccomp[=:]unconfined/.test(o)), 'seccomp not disabled');
  check(hc.Privileged === false, 'not privileged');
  check(hc.User === '10001:10001', 'Config.User = 10001:10001');
  check(hc.Memory === hc.MemorySwap && hc.Memory > 0, 'memory = memory-swap (no swap)', `${hc.Memory}`);
  check(hc.PidsLimit > 0 && hc.NanoCpus === 1e9, 'PID and CPU limits set', `pids=${hc.PidsLimit} cpus=${hc.NanoCpus / 1e9}`);
  const binds = (hc.Mounts || []).map((m) => `${m.Target}:${m.ReadOnly ? 'ro' : 'rw'}`).sort();
  check(JSON.stringify(binds) === '["/build:ro","/src:ro"]', 'only /src and /build bind-mounted, both read-only while running', JSON.stringify(binds));
  check(!(hc.Binds || []).length, 'no -v binds (docker.sock, project, home)');
}

const left = await driver.listJudgeContainers();
check(left.length === 0, 'no judge containers left behind', `${left.length} found`);
console.log(failures ? `\n${failures} sandbox check(s) FAILED` : '\nAll sandbox checks passed.');
process.exit(failures ? 1 : 0);
