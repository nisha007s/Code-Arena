// CPython (WASI) runner shared by the Node harness and the Deno Edge Function.
// Python gets only: stdin bytes, captured stdout/stderr, a read-only in-memory stdlib.
// No sockets, no host filesystem, no environment, no JS bridge.
import { WASI, File, OpenFile, PreopenDirectory, Directory, ConsoleStdout } from 'npm:@bjorn3/browser_wasi_shim@0.4.1';

// pack = Uint8Array: [u32 headerLen][JSON [[path, offset, len], ...]][bytes]
export function unpack(pack) {
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const hlen = dv.getUint32(0, true);
  const entries = JSON.parse(new TextDecoder().decode(pack.subarray(4, 4 + hlen)));
  const base = 4 + hlen;
  return entries.map(([p, off, len]) => [p, pack.subarray(base + off, base + off + len)]);
}

function buildTree(files, onOpen) {
  const root = new Map();
  for (const [p, data] of files) {
    const parts = p.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.has(part)) dir.set(part, new Directory(new Map()));
      dir = dir.get(part).contents;
    }
    const f = new File(data, { readonly: true });
    if (onOpen) { const orig = f.stat.bind(f); f.stat = () => { onOpen(p); return orig(); }; }
    dir.set(parts.at(-1), f);
  }
  return root;
}

// Capped output sink: stops collecting after `limit` bytes (output-flood protection).
class Sink extends ConsoleStdout {
  constructor(limit) {
    super((data) => {
      if (this.size < this.limit) { const take = data.subarray(0, this.limit - this.size); this.chunks.push(take.slice()); this.size += take.length; }
      if (this.size >= this.limit) this.truncated = true;
    });
    this.chunks = []; this.size = 0; this.limit = limit; this.truncated = false;
  }
  // Once the cap is reached, writes fail with EIO so the program stops instead of looping forever.
  fd_write(data) { if (this.truncated) return { ret: 29, nwritten: 0 }; const r = super.fd_write(data); return this.truncated ? { ret: 29, nwritten: 0 } : r; }
  text() { const out = new Uint8Array(this.size); let o = 0; for (const c of this.chunks) { out.set(c, o); o += c.length; } return new TextDecoder().decode(out); }
}

// Clamp sys.setrecursionlimit: very deep recursion otherwise burns seconds of CPU before the
// WebAssembly stack overflows. Then run the user's file as __main__ with clean globals.
const WRAPPER = `import sys
_set = sys.setrecursionlimit
def _clamped(n, _set=_set): _set(min(int(n), 20000))
sys.setrecursionlimit = _clamped
sys.setrecursionlimit(1000)
del _set, _clamped
_src = open('/solution.py').read()
_code = compile(_src, 'solution.py', 'exec')
del _src
exec(_code, {'__name__': '__main__', '__builtins__': __builtins__})
`;

export function makePython(module, stdlibFiles, { trace } = {}) {
  return function run(source, stdin, { outputLimit = 64 * 1024, fuel = 0, timeMs = 0, tickFuel = 20000 } = {}) {
    const tree = buildTree([...stdlibFiles, ['lib/python3.15/lib-dynload/.keep', new Uint8Array(0)], ['main.py', new TextEncoder().encode(WRAPPER)], ['solution.py', new TextEncoder().encode(source)]]);
    const stdout = new Sink(outputLimit), stderr = new Sink(16 * 1024);
    const fds = [new OpenFile(new File(new TextEncoder().encode(stdin), { readonly: true })), stdout, stderr, new PreopenDirectory('/', tree)];
    const wasi = new WASI(['python', '-I', '-S', '-B', '-X', 'frozen_modules=on', '/main.py'], ['PYTHONHOME=/', 'PYTHONDONTWRITEBYTECODE=1'], fds);
    const imports = { ...wasi.wasiImport };
    if (trace) {
      imports.path_open = (fd, df, ptr, len, ...rest) => {
        trace(new TextDecoder().decode(new Uint8Array(wasi.inst.exports.memory.buffer, ptr, len)));
        return wasi.wasiImport.path_open(fd, df, ptr, len, ...rest);
      };
    }
    // Clock check: the metered module calls sched_yield every `tickFuel` loop iterations.
    let deadline = Infinity, timedOut = false, ticks = 0;
    class TimeLimit extends Error {}
    imports.sched_yield = () => {
      ticks++;
      if (performance.now() > deadline) { timedOut = true; throw new TimeLimit('time limit'); }
      instance.exports.__fuel.value = tickFuel;
      return 0;
    };
    const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: imports });
    const metered = 'fuel' in instance.exports || '__fuel' in instance.exports;
    if (metered) instance.exports.__fuel.value = timeMs ? tickFuel : (fuel > 0 ? fuel : 0x7fffffff);
    const t0 = performance.now();
    if (timeMs) deadline = t0 + timeMs;
    let exitCode, trap = null;
    try { exitCode = wasi.start(instance); } catch (e) { trap = String(e?.message || e); exitCode = -1; }
    const outOfFuel = timedOut || (metered && !timeMs && instance.exports.__fuel.value === 0);
    const fuelUsed = metered ? (fuel > 0 ? fuel : 0x7fffffff) - instance.exports.__fuel.value : null;
    return { exitCode, trap, outOfFuel, fuelUsed, ticks, ms: performance.now() - t0, stdout: stdout.text(), stderr: stderr.text(), truncated: stdout.truncated };
  };
}
