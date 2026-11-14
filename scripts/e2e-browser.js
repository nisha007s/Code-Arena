// Browser end-to-end check with real Chrome/Edge (puppeteer-core) against a real server.
//
//   npm run e2e
//
// Uses the Docker judge by default. On a machine without Docker:
//   JUDGE_DRIVER=local CODE_ARENA_ALLOW_UNSANDBOXED=1 npm run e2e
// Set CHROME_PATH if Chrome is not in a standard location.
// Screenshots go to test-artifacts/.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { loadConfig, projectRoot } from '../server/config.js';
import { createApp } from '../server/app.js';
import { loadProblemBank } from '../server/problems.js';

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = chromeCandidates.find((p) => fs.existsSync(p));
if (!executablePath) { console.error('No Chrome/Edge found. Set CHROME_PATH.'); process.exit(1); }

const out = path.join(projectRoot, 'test-artifacts');
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(out, 'data-'));
// E2E_BASE_URL=https://your-site.vercel.app runs the same checks against a deployed site.
const remote = process.env.E2E_BASE_URL ? process.env.E2E_BASE_URL.replace(/\/+$/, '') : null;
// The Supabase deployment offers Python and JavaScript only: E2E_ALT_LANG=javascript.
const altLang = process.env.E2E_ALT_LANG || 'java';
const altMarker = altLang === 'java' ? 'public class Main' : "readFileSync(0, 'utf8')";
let server = null, base = remote;
if (!remote) {
  const config = loadConfig({ overrides: { port: 0, match: { durationMs: 120000, settleMs: 20000 } } });
  server = createApp(config, { quiet: true, dbFile: path.join(dataDir, 'e2e.sqlite') });
  const { port } = await server.start();
  base = `http://127.0.0.1:${port}`;
}
const bank = loadProblemBank();

// Paste-ready programs for whatever problem the round picks.
const pythonSolution = (id) => fs.readFileSync(path.join(bank.get(id).dir, 'reference.py'), 'utf8');
const jsSolution = (id) => fs.readFileSync(path.join(bank.get(id).dir, 'reference.js'), 'utf8').replace('export function solve', 'function solve')
  + "\nprocess.stdout.write(solve(require('fs').readFileSync(0, 'utf8')));\n";

let failures = 0;
const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'}  ${what}`); if (!ok) failures++; };
const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const cspErrors = [];
let wsFallbacks = 0;
async function newPlayer(name, viewport = { width: 1366, height: 860 }) {
  const ctx = await browser.createBrowserContext(); // separate cookies = separate guest
  const page = await ctx.newPage();
  await page.setViewport(viewport);
  // Expected HTTP errors (401 retry on first load, 409 room full) are not script errors.
  page.on('console', (m) => {
    if (m.type() !== 'error' || m.text().startsWith('Failed to load resource')) return;
    // A refused WebSocket handshake is transport negotiation (Socket.IO then uses polling), not an app error.
    if (/^WebSocket connection to .* failed/.test(m.text())) { wsFallbacks++; return; }
    cspErrors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => cspErrors.push(`${name}: ${e.message}`));
  page.setDefaultTimeout(30000);
  return page;
}
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());
const setCode = (page, code) => page.$eval('.editor-input', (el, c) => { el.value = c; el.dispatchEvent(new Event('input')); }, code);
// The lobby re-renders on every room update, so a button can be replaced between finding and
// clicking it (more likely over HTTP long-polling). Retry with a fresh lookup in that case.
const clickText = async (page, label) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const el = await page.waitForSelector(`button::-p-text(${label})`);
      await el.click();
      return;
    } catch (e) {
      if (attempt >= 4 || !/detached|not clickable|Node is either/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
};
const shot = (page, name) => page.screenshot({ path: path.join(out, name), fullPage: false });

try {
  console.log(`Server ${base} · judge: ${server ? server.services.judge.status().driver : 'remote (see /api/judge/health)'}`);

  // ---------- practice workspace ----------
  const solo = await newPlayer('solo');
  await solo.goto(`${base}/problems.html`);
  await solo.waitForSelector('.problem-table tbody tr');
  check((await solo.$$('.problem-table tbody tr')).length === 12, 'library lists 12 problems');
  await solo.type('#q', 'zzzz');
  check(Boolean(await solo.$('.empty')), 'search with no match shows an empty state');
  await clickText(solo, 'Clear filters');
  await solo.select('#difficulty', 'hard');
  check((await solo.$$('.problem-table tbody tr')).length === 2, 'difficulty filter narrows to 2 hard problems');
  check((await solo.$$('.rec-card')).length === 3, 'three cold-start recommendations shown');
  await shot(solo, 'library-desktop.png');

  await solo.goto(`${base}/practice.html?id=target-pair`);
  await solo.waitForSelector('.editor-input');
  check((await solo.$eval('.editor-input', (el) => el.value)).includes('Input format:'), 'starter template loaded');
  await setCode(solo, fs.readFileSync(path.join(projectRoot, 'scripts', 'solutions', 'target-pair.py'), 'utf8'));
  await clickText(solo, 'Run');
  await solo.waitForSelector('.console .console-head .verdict', { timeout: 60000 });
  check((await text(solo, '.console .console-head .verdict')) === 'Accepted', 'Run on examples → Accepted with per-example output');
  await solo.focus('.editor-input');
  await solo.keyboard.down('Control'); await solo.keyboard.down('Shift'); await solo.keyboard.press('Enter'); await solo.keyboard.up('Shift'); await solo.keyboard.up('Control');
  await solo.waitForFunction(() => document.querySelector('.console')?.textContent.includes('Hidden tests passed'), { timeout: 60000 });
  check(true, 'Ctrl+Shift+Enter submits; hidden tests passed');
  // language switch keeps drafts per language
  await solo.select('.toolbar select', altLang);
  check((await solo.$eval('.editor-input', (el) => el.value)).includes(altMarker), `switching to ${altLang} shows its starter`);
  await solo.select('.toolbar select', 'python');
  check((await solo.$eval('.editor-input', (el) => el.value)).includes('seen = set()'), 'switching back restores the Python draft');
  // keyboard: Tab indents, Esc then Tab leaves the editor
  await solo.focus('.editor-input');
  await solo.keyboard.press('Tab');
  check(await solo.evaluate(() => document.activeElement.classList.contains('editor-input')), 'Tab inside the editor indents (focus stays)');
  await solo.keyboard.press('Escape'); await solo.keyboard.press('Tab');
  check(await solo.evaluate(() => !document.activeElement.classList.contains('editor-input')), 'Esc then Tab moves focus out of the editor');
  await shot(solo, 'practice-desktop.png');
  // custom input
  await solo.click('.actions input[type=checkbox]');
  await setCode(solo, 'import sys\nprint(sys.stdin.read().upper())\n');
  await solo.type('.custom-input textarea', 'hello arena');
  await clickText(solo, 'Run');
  await solo.waitForFunction(() => document.querySelector('.console')?.textContent.includes('HELLO ARENA'), { timeout: 60000 });
  check(true, 'custom stdin run shows stdout');
  // phone layout
  await solo.setViewport({ width: 390, height: 844, isMobile: true });
  await solo.reload();
  await solo.waitForSelector('.pane-tabs button');
  check(await solo.$eval('.pane-tabs', (el) => getComputedStyle(el).display !== 'none'), 'phone width shows Problem / Editor / Results tabs');
  check((await solo.$eval('.editor-input', (el) => el.value)).includes('upper()'), 'draft survived a refresh');
  const noHScroll = await solo.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check(noHScroll, 'no horizontal page scroll at 390px');
  await shot(solo, 'practice-phone-editor.png');
  await clickText(solo, 'Problem');
  await shot(solo, 'practice-phone-problem.png');

  // ---------- live match ----------
  const host = await newPlayer('host');
  const friend = await newPlayer('friend');
  await host.goto(`${base}/arena.html`);
  await host.waitForSelector('#create-form');
  await host.select('#room-difficulty', 'easy');
  await clickText(host, 'Create private room');
  await host.waitForSelector('.room-code');
  const code = await text(host, '.room-code');
  const invite = await host.$eval('#invite-url', (el) => el.value);
  check(/^[A-Z0-9]{6}$/.test(code) && invite === `${base}/arena.html?room=${code}`, `room ${code} with an invite built from the current origin`);
  await clickText(host, 'Copy invite link');
  await host.waitForSelector('.toast');
  check(true, `copy button gives feedback ("${await text(host, '.toast')}")`);
  await shot(host, 'lobby-host.png');

  await friend.goto(invite);
  await friend.waitForSelector('.seat-list');
  await host.waitForFunction(() => document.querySelectorAll('.seat-list .seat:not(.seat-empty)').length === 2);
  check(true, 'friend joined through the invite link; host sees both seats');
  const third = await newPlayer('third');
  await third.goto(invite);
  await third.waitForFunction(() => document.getElementById('join-error')?.textContent.includes('two players'));
  check(true, 'a third browser is refused (room full)');

  check(await host.$eval('button.btn-primary.btn-large', (b) => b.disabled), 'Start is disabled until both are ready');
  await clickText(host, 'Ready');
  await clickText(friend, 'Ready');
  await host.waitForFunction(() => !document.querySelector('button.btn-primary.btn-large')?.disabled);
  await clickText(host, 'Start match');
  await host.waitForSelector('#problem-title');
  await friend.waitForSelector('#problem-title');
  const [ph, pf] = [await text(host, '#problem-title'), await text(friend, '#problem-title')];
  check(ph === pf, `both players see the same problem: ${ph}`);
  const problem = bank.list.find((p) => ph.endsWith(p.title));
  await shot(friend, 'match-friend.png');

  // Draft survives a refresh mid-round.
  await friend.select('.toolbar select', 'javascript');
  await setCode(friend, '// friend draft marker\n');
  await friend.reload();
  await friend.waitForSelector('#problem-title');
  check((await friend.$eval('.editor-input', (el) => el.value)).includes('friend draft marker'), 'friend refreshed mid-round: seat reclaimed and draft kept');

  // Host submits first in Python; friend submits a wrong answer, then a correct JavaScript one.
  await setCode(host, pythonSolution(problem.id));
  await clickText(host, 'Submit');
  await setCode(friend, 'console.log("nope")\n');
  await clickText(friend, 'Submit');
  await friend.waitForFunction(() => /Wrong Answer|Accepted/.test(document.querySelector('.console .console-head')?.textContent || ''), { timeout: 60000 });
  check((await text(friend, '.console .console-head .verdict')) === 'Wrong Answer', 'friend gets a private Wrong Answer');
  await friend.waitForFunction(() => !document.querySelector('.actions .btn-primary').disabled, { timeout: 60000 }).catch(() => {});
  try {
    await host.waitForFunction(() => document.querySelector('.console')?.textContent.includes('Accepted'), { timeout: 60000 });
  } catch (e) {
    const consoleText = await host.$eval('.console', (el) => el.textContent).catch(() => '(none)');
    const lockText = await host.$eval('.actions', (el) => el.textContent).catch(() => '');
    throw new Error(`host never saw Accepted. Console: "${consoleText.slice(0, 300)}" Actions: "${lockText}"`);
  }
  check(true, 'host submission Accepted');
  check(await host.$eval('.actions .btn-primary', (b) => b.disabled), 'host Submit locks after Accepted');
  await friend.waitForFunction(() => document.querySelector('.match-header')?.textContent.includes('Solved'));
  check(true, 'friend sees the coarse "Solved" status for the host');
  await setCode(friend, jsSolution(problem.id));
  await clickText(friend, 'Submit');
  await host.waitForSelector('#result-title', { timeout: 60000 });
  await friend.waitForSelector('#result-title', { timeout: 60000 });
  const [rh, rf] = [await text(host, '#result-title'), await text(friend, '#result-title')];
  check(rh === 'You won!' && rf.endsWith('won.'), `results agree — host: "${rh}", friend: "${rf}"`);
  const friendPage = await friend.content();
  check(!friendPage.includes(pythonSolution(problem.id).slice(0, 60)), "host's code never reaches the friend's page");
  await shot(host, 'results-host.png');

  // Rematch with clean readiness and a new problem.
  await clickText(host, 'Rematch (new problem)');
  await friend.waitForSelector('.seat-list');
  check(await friend.$$eval('.seat .pstatus', (els) => els.every((e) => e.textContent.includes('Not ready'))), 'rematch resets readiness for both players');
  await clickText(host, 'Ready'); await clickText(friend, 'Ready');
  await host.waitForFunction(() => !document.querySelector('button.btn-primary.btn-large')?.disabled);
  await clickText(host, 'Start match');
  await host.waitForFunction((prev) => document.querySelector('#problem-title') && document.querySelector('#problem-title').textContent !== prev, {}, ph);
  check(true, `rematch rotates the problem (${await text(host, '#problem-title')})`);

  // History
  await host.goto(`${base}/history.html`);
  await host.waitForSelector('.outcome-won');
  check(true, 'history shows the won match and submissions');
  await shot(host, 'history.png');
  check(cspErrors.length === 0, `no console/CSP errors${cspErrors.length ? ': ' + cspErrors.slice(0, 3).join(' | ') : ''}`);
  if (wsFallbacks) console.log(`  i  WebSocket was refused ${wsFallbacks} time(s); Socket.IO used HTTP long-polling instead`);
} catch (e) {
  failures++;
  console.error('  ✗  ' + e.message);
  for (const [i, p] of (await browser.pages()).entries()) await p.screenshot({ path: path.join(out, `failure-${i}.png`) }).catch(() => {});
} finally {
  await browser.close();
  if (server) await server.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} browser check(s) FAILED` : '\nAll browser checks passed. Screenshots in test-artifacts/.');
process.exit(failures ? 1 : 0);
