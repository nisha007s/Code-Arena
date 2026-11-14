// node wasm-meter.mjs <in.wasm> <out.wasm>
// Deterministic "fuel" metering: inserts, at the start of every `loop` body,
//   global.get F; i32.eqz; if; unreachable; end; global.get F; i32.const 1; i32.sub; global.set F
// F is a new mutable i32 global exported as "__fuel". The host sets the budget before
// running; when it reaches 0 the module traps, and the host sees F === 0 => TLE.
// Any non-terminating wasm execution must iterate some loop (recursion is bounded by the
// stack), so execution is guaranteed to stop inside the sandbox.
import fs from 'node:fs';
const [, , input, output] = process.argv;
const b = fs.readFileSync(input);

let p;
const u = () => { let r = 0, s = 0, x; do { x = b[p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; };
const sLeb = () => { let x; do { x = b[p++]; } while (x & 0x80); }; // skip signed LEB
const encU = (n) => { const o = []; do { let x = n % 128; n = Math.floor(n / 128); if (n) x |= 0x80; o.push(x); } while (n); return o; };

// ---- pass 1: sections ----
p = 8;
const sections = [];
while (p < b.length) { const id = b[p++]; const size = u(); sections.push({ id, start: p, end: p + size }); p += size; }
const sec = (id) => sections.find((s) => s.id === id);

// count imported globals
let importedGlobals = 0;
if (sec(2)) {
  p = sec(2).start; const n = u();
  for (let i = 0; i < n; i++) {
    { const l1 = u(); p += l1; } { const l2 = u(); p += l2; } const kind = b[p++];
    if (kind === 0) u();
    else if (kind === 1) { p++; const fl = b[p++]; u(); if (fl & 1) u(); }
    else if (kind === 2) { const fl = b[p++]; u(); if (fl & 1) u(); }
    else if (kind === 3) { importedGlobals++; p += 2; }
    else if (kind === 4) { p++; u(); } else throw new Error('import kind ' + kind);
  }
}
let definedGlobals = 0;
if (sec(6)) { p = sec(6).start; definedGlobals = u(); }
const F = importedGlobals + definedGlobals;
const Fb = encU(F);

// ---- instruction walker ----
const blockType = () => { const t = b[p]; if (t === 0x40 || (t >= 0x6f && t <= 0x7f)) p++; else sLeb(); };
const memarg = () => { u(); u(); };
function skipInstr(op) {
  if (op >= 0x45 && op <= 0xc4) return;            // numeric ops incl. sign-ext: no immediates
  switch (op) {
    case 0x00: case 0x01: case 0x0f: case 0x1a: case 0x1b: case 0x05: case 0x0b: case 0xd1: return;
    case 0x02: case 0x03: case 0x04: blockType(); return;
    case 0x0c: case 0x0d: case 0x10: case 0x12: u(); return;
    case 0x0e: { const n = u(); for (let i = 0; i <= n; i++) u(); return; }
    case 0x11: case 0x13: u(); u(); return;          // call_indirect typeidx tableidx
    case 0x1c: { const n = u(); p += n; return; } // n computed before p is read    // select t*
    case 0x20: case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: u(); return;
    case 0x41: sLeb(); return;
    case 0x42: sLeb(); return;
    case 0x43: p += 4; return;
    case 0x44: p += 8; return;
    case 0x3f: case 0x40: u(); return;               // memory.size/grow memidx
    case 0xd0: p++; return;                          // ref.null heaptype
    case 0xd2: u(); return;                          // ref.func
    case 0xfc: {
      const sub = u();
      if (sub <= 7) return;
      if (sub === 8) { u(); u(); return; } if (sub === 9) { u(); return; }
      if (sub === 10) { u(); u(); return; } if (sub === 11) { u(); return; }
      if (sub === 12) { u(); u(); return; } if (sub === 13) { u(); return; }
      if (sub === 14) { u(); u(); return; } if (sub >= 15 && sub <= 17) { u(); return; }
      throw new Error('0xfc sub ' + sub);
    }
    default:
      if (op >= 0x28 && op <= 0x3e) { memarg(); return; }
      throw new Error('unknown opcode 0x' + op.toString(16) + ' at ' + (p - 1));
  }
}
const TICK = process.env.TICK_FUNC ? encU(Number(process.env.TICK_FUNC)) : null;
const PROBE = [0x23, ...Fb, 0x45, 0x04, 0x40, ...(TICK ? [0x10, ...TICK, 0x1a] : [0x00]), 0x0b, 0x23, ...Fb, 0x41, 0x01, 0x6b, 0x24, ...Fb];

// ---- rewrite code section ----
const code = sec(10);
p = code.start;
const nFuncs = u();
const bodies = [];
let loops = 0;
for (let i = 0; i < nFuncs; i++) {
  const size = u(); const bodyStart = p; const bodyEnd = p + size;
  const nLocals = u(); for (let j = 0; j < nLocals; j++) { u(); const t = b[p++]; if (t === 0x63 || t === 0x64) sLeb(); }
  const parts = [b.subarray(bodyStart, p)];
  let last = p;
  while (p < bodyEnd) {
    const op = b[p++];
    skipInstr(op);
    if (op === 0x03) { parts.push(b.subarray(last, p), Buffer.from(PROBE)); last = p; loops++; }
  }
  if (p !== bodyEnd) throw new Error('body overrun in func ' + i);
  parts.push(b.subarray(last, bodyEnd));
  const body = Buffer.concat(parts);
  bodies.push(Buffer.from(encU(body.length)), body);
}
const codeContent = Buffer.concat([Buffer.from(encU(nFuncs)), ...bodies]);

// ---- new global section (append F: mut i32 = 0) and export ----
const globalEntry = Buffer.from([0x7f, 0x01, 0x41, 0x00, 0x0b]);
let globalContent;
if (sec(6)) { p = sec(6).start; u(); globalContent = Buffer.concat([Buffer.from(encU(definedGlobals + 1)), b.subarray(p, sec(6).end), globalEntry]); }
else globalContent = Buffer.concat([Buffer.from([1]), globalEntry]);
p = sec(7).start; const nExp = u();
const name = Buffer.from('__fuel');
const exportContent = Buffer.concat([Buffer.from(encU(nExp + 1)), b.subarray(p, sec(7).end), Buffer.from([name.length]), name, Buffer.from([0x03, ...Fb])]);

const out = [b.subarray(0, 8)];
const emit = (id, content) => out.push(Buffer.from([id, ...encU(content.length)]), content);
let globalDone = false;
for (const s of sections) {
  if (!sec(6) && !globalDone && s.id > 6 && s.id !== 0 && s.id !== 12) { emit(6, globalContent); globalDone = true; }
  if (s.id === 6) emit(6, globalContent);
  else if (s.id === 7) emit(7, exportContent);
  else if (s.id === 10) emit(10, codeContent);
  else out.push(b.subarray(s.start - 1 - encU(s.end - s.start).length, s.end));
}
fs.writeFileSync(output, Buffer.concat(out));
console.log(`metered ${loops} loops in ${nFuncs} functions; fuel global #${F}; ${fs.statSync(input).size} -> ${fs.statSync(output).size} bytes`);
