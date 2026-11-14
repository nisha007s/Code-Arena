// Minimal, dependency-free zip extractor (stored + deflate entries) used by the build.
// node unzip.mjs <file.zip> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const [, , zipPath, outDir] = process.argv;
const b = fs.readFileSync(zipPath);
let eocd = b.length - 22;
while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
if (eocd < 0) throw new Error('not a zip file');
const count = b.readUInt16LE(eocd + 10);
let p = b.readUInt32LE(eocd + 16);
const root = path.resolve(outDir);
for (let i = 0; i < count; i++) {
  if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
  const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32), local = b.readUInt32LE(p + 42);
  const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
  p += 46 + nameLen + extraLen + commentLen;
  const dest = path.resolve(root, name);
  if (!dest.startsWith(root + path.sep) && dest !== root) throw new Error('unsafe path in zip: ' + name); // zip-slip guard
  if (name.endsWith('/')) { fs.mkdirSync(dest, { recursive: true }); continue; }
  const lNameLen = b.readUInt16LE(local + 26), lExtraLen = b.readUInt16LE(local + 28);
  const data = b.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : (() => { throw new Error('unsupported zip method ' + method); })());
}
console.log(`extracted ${count} entries`);
