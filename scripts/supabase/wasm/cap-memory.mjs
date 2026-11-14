// node wasm-cap-memory.mjs <in.wasm> <out.wasm> <maxPages>
// Rewrites the (single, defined) memory's limits to add a maximum (64 KiB pages).
import fs from 'node:fs';
const [, , input, output, maxPagesArg] = process.argv;
const b = fs.readFileSync(input);
const maxPages = Number(maxPagesArg);
const lebU = (n) => { const out = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; out.push(x); } while (n); return out; };
let p = 8; const parts = [b.subarray(0, 8)];
const leb = () => { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
while (p < b.length) {
  const start = p, id = b[p++], size = leb(), body = p;
  if (id === 5) {
    p = body; const count = leb(); if (count !== 1) throw new Error('expected one memory');
    const flags = b[p++]; const min = leb(); if (flags & 1) leb();
    if (maxPages < min) throw new Error(`max ${maxPages} < initial ${min}`);
    const content = [1, flags | 1, ...lebU(min), ...lebU(maxPages)];
    parts.push(Buffer.from([5, ...lebU(content.length), ...content]));
    console.log(`memory: initial ${min} pages (${min / 16} MiB), max now ${maxPages} pages (${maxPages / 16} MiB)`);
  } else parts.push(b.subarray(start, body + size));
  p = body + size;
}
fs.writeFileSync(output, Buffer.concat(parts));
