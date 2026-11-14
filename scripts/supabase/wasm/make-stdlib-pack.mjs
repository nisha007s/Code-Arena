// node make-pack.mjs <libRoot> <out.pack> [listFile]
// Packs stdlib .py files (all minus big unneeded packages, or only those in listFile).
import fs from 'node:fs';
import path from 'node:path';
const [, , libRoot, out, listFile] = process.argv;
const SKIP = /^lib\/python3\.15\/(test|idlelib|tkinter|turtledemo|ensurepip|pydoc_data|profiling|_pyrepl|asyncio|email|xml|http|urllib|unittest|logging|multiprocessing|concurrent|sqlite3|venv|wsgiref|xmlrpc|curses|dbm|lib2to3|site-packages|__phello__)\//;
let files = [];
const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(libRoot, p).split(path.sep).join('/')); } };
walk(path.join(libRoot, 'lib'));
files = files.filter((f) => f.endsWith('.py') && !SKIP.test(f));
if (listFile) { const want = new Set(fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean)); files = files.filter((f) => want.has(f)); }
const entries = []; const bufs = []; let off = 0;
for (const f of files.sort()) { const b = fs.readFileSync(path.join(libRoot, f)); entries.push([f, off, b.length]); bufs.push(b); off += b.length; }
const header = Buffer.from(JSON.stringify(entries));
const len = Buffer.alloc(4); len.writeUInt32LE(header.length);
fs.writeFileSync(out, Buffer.concat([len, header, ...bufs]));
console.log(`${files.length} files, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
