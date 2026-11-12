// TEST-ONLY local driver. It runs submitted programs directly on this computer
// with NO sandbox, using whatever compilers are installed. It exists so the
// judge pipeline, the arena and the browser tests can be exercised on a machine
// without Docker. config.js refuses it unless CODE_ARENA_ALLOW_UNSANDBOXED=1
// and the server is bound to 127.0.0.1. Never use it with untrusted code.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { LANGUAGES, LANGUAGE_IDS } from './languages.js';

const isWin = process.platform === 'win32';

function hostCommands(language, srcDir, buildDir) {
  const py = process.env.PYTHON || (isWin ? 'python' : 'python3');
  const exe = path.join(buildDir, isWin ? 'main.exe' : 'main');
  const src = (f) => path.join(srcDir, f);
  switch (language) {
    case 'python': return {
      compile: [py, '-I', '-c', `import sys\nsrc = open(sys.argv[1], 'rb').read()\ncompile(src, 'main.py', 'exec')\n`, src('main.py')],
      run: [py, '-I', '-B', src('main.py')],
    };
    case 'javascript': return { compile: ['node', '--check', src('main.js')], run: ['node', src('main.js')] };
    case 'java': return {
      compile: ['javac', '--release', '21', '-encoding', 'UTF-8', '-d', buildDir, src('Main.java')],
      run: ['java', '-Xss64m', '-Xmx384m', '-XX:+UseSerialGC', '-cp', buildDir, 'Main'],
    };
    case 'cpp': return { compile: ['g++', '-std=c++17', '-O2', '-o', exe, src('main.cpp')], run: [exe] };
    default: return null; // C# needs the Docker image (or a local .NET SDK, not wired up here)
  }
}

export class LocalDriver {
  constructor({ log = console } = {}) {
    this.log = log;
    this.name = 'local (UNSANDBOXED, test-only)';
  }

  async checkReady() {
    const languages = {};
    for (const id of LANGUAGE_IDS) {
      const cmds = hostCommands(id, '.', '.');
      if (!cmds) { languages[id] = { ready: false, message: `${LANGUAGES[id].name} needs the Docker judge.` }; continue; }
      const probe = spawnSync(cmds.compile[0], id === 'java' ? ['-version'] : ['--version'], { encoding: 'utf8', windowsHide: true });
      languages[id] = probe.error ? { ready: false, message: `${cmds.compile[0]} not found` } : { ready: true };
    }
    return {
      ready: Object.values(languages).some((l) => l.ready),
      unsandboxed: true,
      message: 'Unsandboxed local test judge. Use the Docker judge for real matches.',
      languages,
    };
  }

  async cleanupOrphans() { return 0; }
  async shutdown() {}
  async listJudgeContainers() { return []; }

  runContainer({ language, phase, srcDir, buildDir, stdin = '', timeoutMs, stdoutCap, stderrCap, signal }) {
    const cmds = hostCommands(language, srcDir, buildDir);
    return new Promise((resolve) => {
      const res = { exitCode: null, stdout: '', stderr: '', timedOut: false, outputExceeded: false, oomKilled: false, durationMs: 0 };
      if (!cmds) { resolve({ ...res, infraError: `${language} is not available in the local test judge` }); return; }
      const [cmd, ...args] = cmds[phase];
      const started = Date.now();
      let outBytes = 0, errBytes = 0, reason = null;
      const child = spawn(cmd, args, { cwd: buildDir, windowsHide: true });
      const kill = (r) => { if (!reason) { reason = r; child.kill('SIGKILL'); } };
      const timer = setTimeout(() => kill('timeout'), timeoutMs);
      const onAbort = () => kill('abort');
      signal?.addEventListener('abort', onAbort, { once: true });
      const outChunks = [], errChunks = [];
      child.stdout.on('data', (d) => { outBytes += d.length; if (outBytes > stdoutCap) { res.outputExceeded = true; kill('output'); } else outChunks.push(d); });
      child.stderr.on('data', (d) => { errBytes += d.length; if (errBytes > stderrCap) { res.outputExceeded = true; kill('output'); } else errChunks.push(d); });
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
      child.on('error', (e) => { clearTimeout(timer); resolve({ ...res, infraError: `cannot start ${cmd}: ${e.message}` }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        res.exitCode = code;
        res.durationMs = Date.now() - started;
        res.stdout = Buffer.concat(outChunks).toString('utf8');
        res.stderr = Buffer.concat(errChunks).toString('utf8');
        if (reason === 'timeout') res.timedOut = true;
        if (reason === 'abort') res.infraError = 'job cancelled';
        resolve(res);
      });
    });
  }
}
