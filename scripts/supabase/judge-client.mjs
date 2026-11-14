// Shared client for the judge acceptance tools (admin test mode of the judge function).
// Needs JUDGE_ADMIN_KEY and RUNNER_KEY_LENGTH in the environment (never commit them).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../../public/js/config.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const URL_JUDGE = `${CONFIG.supabaseUrl}/functions/v1/judge`;
export const RUNNER_BASE = `${CONFIG.supabaseUrl}/functions/v1/`;
export const ANON = CONFIG.supabaseAnonKey;
export const FIXTURES = path.join(REPO, 'supabase', '.build', 'fixtures-gen', 'fixtures');
export const SLOW = path.join(REPO, 'scripts', 'supabase', 'slow-solutions');
const ADMIN = process.env.JUDGE_ADMIN_KEY;
if (!ADMIN) { console.error('Set JUDGE_ADMIN_KEY (and RUNNER_KEY_LENGTH) in the environment.'); process.exit(2); }
export const runnerKeyLength = Number(process.env.RUNNER_KEY_LENGTH || 43);
export const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
export async function judge(body, { key = ADMIN } = {}) {
  const t0 = performance.now();
  const res = await fetch(URL_JUDGE, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) }, body: JSON.stringify(body) });
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, wallMs: Math.round(performance.now() - t0), j, text: j ? null : text.slice(0, 200) };
}
export function reference(dir, lang) {
  const p = path.join(REPO, 'problem-bank', 'problems', dir);
  return lang === 'python' ? fs.readFileSync(path.join(p, 'reference.py'), 'utf8')
    : fs.readFileSync(path.join(p, 'reference.js'), 'utf8').replace('export function solve', 'function solve') + "\nprocess.stdout.write(solve(require('fs').readFileSync(0, 'utf8')));\n";
}
export const PROBLEMS = fs.readdirSync(path.join(REPO, 'problem-bank', 'problems')).sort();
