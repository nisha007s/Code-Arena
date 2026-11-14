// Lists wasm sections; with an output path, writes a copy without custom sections.
import fs from 'node:fs';
const [, , input, output] = process.argv;
const b = fs.readFileSync(input);
let p = 8; const keep = [b.subarray(0, 8)];
const leb = () => { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
while (p < b.length) {
  const start = p, id = b[p++], size = leb(), body = p;
  let name = '';
  if (id === 0) { const n = leb(); name = b.subarray(p, p + n).toString(); }
  console.log(id, name, size);
  p = body + size;
  if (id !== 0) keep.push(b.subarray(start, p));
}
if (output) { fs.writeFileSync(output, Buffer.concat(keep)); console.log('written', fs.statSync(output).size); }
