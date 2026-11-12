// Loads the server-only problem bank (problem-bank/) and builds the public view.
// Hidden fixtures, reference solutions and private notes never leave this module
// except through the judge, and the judge never returns hidden output.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot } from './config.js';
import { starterFor } from './starters.js';
import { LANGUAGE_IDS } from './judge/languages.js';

export const problemsRoot = path.join(projectRoot, 'problem-bank', 'problems');
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

// Hidden fixtures are generated deterministically (scripts/generate-fixtures.js).
export function ensureFixtures() {
  const missing = fs.readdirSync(problemsRoot).some((d) => !fs.existsSync(path.join(problemsRoot, d, 'tests', 'index.json')));
  if (!missing) return;
  console.log('Generating hidden test fixtures…');
  const res = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'generate-fixtures.js')], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('Fixture generation failed');
}

// Explicit allowlist of fields the browser may see.
function toPublic(p) {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    difficulty: p.difficulty,
    tags: [...p.tags],
    statement: [...p.statement],
    inputFormat: [...p.inputFormat],
    outputFormat: [...p.outputFormat],
    constraints: [...p.constraints],
    examples: p.examples.map((e) => ({ input: e.input, output: e.output, explanation: e.explanation || '' })),
  };
}

export function loadProblemBank(root = problemsRoot) {
  const list = [];
  for (const dir of fs.readdirSync(root).sort()) {
    const full = path.join(root, dir);
    const meta = JSON.parse(fs.readFileSync(path.join(full, 'problem.json'), 'utf8'));
    const tests = meta.examples.map((e, i) => ({ visibility: 'public', index: i, label: `Example ${i + 1}`, input: e.input, expected: e.output }));
    const indexFile = path.join(full, 'tests', 'index.json');
    const hidden = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : [];
    hidden.forEach((h, i) => tests.push({ visibility: 'hidden', index: i, label: `hidden ${h.file}`, base: path.join(full, 'tests', h.file) }));
    list.push({ ...meta, dir: full, tests });
  }
  list.sort((a, b) => a.number - b.number);
  const byId = new Map(list.map((p) => [p.id, p]));

  const readInput = (t) => (t.visibility === 'public' ? t.input : fs.readFileSync(t.base + '.in', 'utf8'));
  const readExpected = (t) => (t.visibility === 'public' ? t.expected : fs.readFileSync(t.base + '.out', 'utf8'));

  // Each case gets a stdout cap that fits its valid answer (intervals and temperatures are large).
  const stdoutCapFor = (t) => {
    const size = t.visibility === 'public' ? Buffer.byteLength(t.expected) : fs.statSync(t.base + '.out').size;
    return Math.max(64 * 1024, size * 2 + 4096);
  };

  return {
    list,
    get: (id) => byId.get(id) || null,
    readInput,
    readExpected,
    stdoutCapFor,
    publicSummary: (p) => ({ id: p.id, number: p.number, title: p.title, difficulty: p.difficulty, tags: [...p.tags] }),
    publicDetail: (p) => ({
      ...toPublic(p),
      starters: Object.fromEntries(LANGUAGE_IDS.map((lang) => [lang, starterFor(p, lang)])),
    }),
    // Recommender inputs: public title and tags only.
    recommenderDocs: () => list.map((p) => ({ id: p.id, number: p.number, title: p.title, difficulty: p.difficulty, tags: [...p.tags], primaryTopic: p.primaryTopic })),
    pick(difficulty, excludeId, random = Math.random) {
      let pool = list.filter((p) => difficulty === 'mixed' || p.difficulty === difficulty);
      if (pool.length > 1 && excludeId) pool = pool.filter((p) => p.id !== excludeId);
      return pool[Math.floor(random() * pool.length)];
    },
  };
}
