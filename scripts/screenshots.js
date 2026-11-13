// Captures every page in dark and light themes, desktop and phone widths.
//
//   npm run screenshots         (Docker judge; output in test-artifacts/screens/)
//
// It first creates genuine activity through the real UI and judge (a few practice
// submissions and one complete match) so stats, history and progress show real data.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { loadConfig, projectRoot } from '../server/config.js';
import { createApp } from '../server/app.js';
import { loadProblemBank } from '../server/problems.js';

const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => fs.existsSync(p));
if (!chrome) { console.error('No Chrome/Edge found. Set CHROME_PATH.'); process.exit(1); }
const out = path.join(projectRoot, 'test-artifacts', 'screens');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(projectRoot, 'test-artifacts', 'shots-data-'));
const server = createApp(loadConfig({ overrides: { port: 0 } }), { quiet: true, dbFile: path.join(dataDir, 'shots.sqlite') });
const { port } = await server.start();
const base = `http://127.0.0.1:${port}`;
const bank = loadProblemBank();
const py = (id) => fs.readFileSync(path.join(bank.get(id).dir, 'reference.py'), 'utf8');
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 };
const TABLET = { width: 820, height: 1180, isMobile: true };
const LAPTOP = { width: 1024, height: 768 };
const SUFFIX = new Map([[PHONE, '-phone'], [TABLET, '-tablet'], [LAPTOP, '-laptop']]);
const errors = [];

async function player(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(DESKTOP);
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`${name}: ${m.text()}`); });
  page.setDefaultTimeout(60000);
  await page.goto(`${base}/`);
  await page.evaluate((n) => fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: n }) }), name);
  return page;
}
const setCode = (page, code) => page.$eval('.editor-input', (el, c) => { el.value = c; el.dispatchEvent(new Event('input')); }, code);
const click = async (page, text) => (await page.waitForSelector(`button::-p-text(${text})`)).click();
async function setTheme(page, theme) {
  await page.evaluate((t) => localStorage.setItem('code-arena.theme', t), theme);
}
async function shot(page, name, { theme = 'dark', viewport = DESKTOP, full = false } = {}) {
  await setTheme(page, theme);
  await page.setViewport(viewport);
  await page.reload({ waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(out, `${name}-${theme}${SUFFIX.get(viewport) || ''}.png`), fullPage: full });
}
async function practiceSubmit(page, id, language, source) {
  await page.goto(`${base}/practice.html?id=${id}`);
  await page.waitForSelector('.editor-input');
  await page.select('.toolbar select', language);
  await setCode(page, source);
  await click(page, 'Submit');
  await page.waitForFunction(() => document.querySelector('.console .verdict-banner'), { timeout: 90000 });
}

try {
  const ada = await player('Ada Lovelace');
  const alan = await player('Alan Turing');

  // Cold-start home first (no activity yet) for comparison.
  await shot(ada, 'home-new-guest', { full: true });

  // Real practice activity for Ada.
  await practiceSubmit(ada, 'target-pair', 'python', py('target-pair'));
  await practiceSubmit(ada, 'bracket-check', 'python', 'print("YES")\n');
  await practiceSubmit(ada, 'longest-streak', 'python', py('longest-streak'));

  // Practice workspace with a real verdict in the console.
  await practiceSubmit(ada, 'bracket-check', 'python', py('bracket-check'));
  for (const theme of ['dark', 'light']) {
    await setTheme(ada, theme); await ada.reload({ waitUntil: 'networkidle0' });
    await setCode(ada, py('bracket-check'));
    await click(ada, 'Run');
    await ada.waitForFunction(() => document.querySelector('.console .verdict-banner'), { timeout: 90000 });
    await ada.screenshot({ path: path.join(out, `practice-${theme}.png`) });
  }

  // A full match: lobby → round → results.
  await ada.goto(`${base}/arena.html`);
  await ada.waitForSelector('#create-form');
  for (const theme of ['dark', 'light']) await shot(ada, 'arena-start', { theme });
  await setTheme(ada, 'dark'); await ada.reload({ waitUntil: 'networkidle0' });
  await ada.select('#room-difficulty', 'easy');
  await click(ada, 'Create private room');
  await ada.waitForSelector('.room-code');
  const invite = await ada.$eval('#invite-url', (el) => el.value);
  await alan.goto(invite);
  await alan.waitForSelector('.seat-list');
  await click(alan, 'Ready');
  await ada.waitForFunction(() => document.querySelectorAll('.fighter.is-ready').length === 1);
  for (const theme of ['dark', 'light']) await shot(ada, 'arena-lobby', { theme, full: true });
  await shot(ada, 'arena-lobby', { viewport: PHONE, full: true });
  await ada.setViewport(DESKTOP); await setTheme(ada, 'dark'); await ada.reload({ waitUntil: 'networkidle0' });
  await click(ada, 'Ready');
  await ada.waitForFunction(() => !document.querySelector('button.btn-primary.btn-large')?.disabled);
  await click(ada, 'Start match');
  await ada.waitForSelector('#problem-title');
  await alan.waitForSelector('#problem-title');
  const title = await ada.$eval('#problem-title', (el) => el.textContent);
  const problem = bank.list.find((p) => title.endsWith(p.title));
  await setCode(alan, 'print("not yet")\n');
  await click(alan, 'Submit');
  await alan.waitForFunction(() => document.querySelector('.console .verdict-banner'), { timeout: 90000 });
  for (const theme of ['dark', 'light']) await shot(alan, 'arena-match', { theme });
  await setTheme(alan, 'dark'); await alan.reload({ waitUntil: 'networkidle0' });
  await setCode(ada, py(problem.id));
  await click(ada, 'Submit');
  await ada.waitForFunction(() => document.querySelector('.match-header')?.textContent.includes('Solved'), { timeout: 90000 });
  await alan.waitForSelector('#problem-title');
  await setCode(alan, py(problem.id));
  await click(alan, 'Submit');
  await ada.waitForSelector('#result-title', { timeout: 90000 });
  for (const theme of ['dark', 'light']) await shot(ada, 'arena-results', { theme, full: true });
  await shot(alan, 'arena-results-opponent');

  // Data-backed pages after real activity.
  for (const [page, name, file] of [[ada, 'home', '/'], [ada, 'problems', '/problems.html'], [ada, 'history', '/history.html'], [ada, 'progress', '/progress.html']]) {
    await page.goto(base + file);
    for (const theme of ['dark', 'light']) await shot(page, name, { theme, full: true });
    await shot(page, name, { viewport: PHONE, full: true });
    await page.setViewport(DESKTOP);
  }
  await ada.goto(`${base}/practice.html?id=target-pair`);
  await shot(ada, 'practice', { viewport: PHONE });
  await shot(ada, 'practice', { viewport: TABLET });
  await shot(ada, 'practice', { viewport: LAPTOP });
  await ada.goto(`${base}/`);
  await shot(ada, 'home', { viewport: TABLET });
  await shot(ada, 'home', { theme: 'light', viewport: LAPTOP });

  // Theme toggle works without reload and persists.
  await ada.setViewport(DESKTOP);
  await ada.goto(`${base}/`);
  const before = await ada.evaluate(() => document.documentElement.dataset.theme);
  await ada.click('#theme-toggle');
  const after = await ada.evaluate(() => document.documentElement.dataset.theme);
  await ada.reload();
  const persisted = await ada.evaluate(() => document.documentElement.dataset.theme);
  console.log(`theme toggle: ${before} → ${after} (no reload), after reload: ${persisted}`);
  const overflow = [];
  for (const vp of [PHONE, TABLET, LAPTOP, DESKTOP]) {
    for (const file of ['/', '/problems.html', '/history.html', '/progress.html', '/arena.html', '/practice.html?id=island-count']) {
      await ada.setViewport(vp); await ada.goto(base + file, { waitUntil: 'networkidle0' });
      if (await ada.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) overflow.push(`${file} @${vp.width}px`);
    }
  }
  console.log(`horizontal overflow (390/820/1024/1440 px): ${overflow.length ? overflow.join(', ') : 'none'}`);
} catch (e) {
  console.error('screenshot run failed:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(errors.length ? `console errors:\n  ${errors.join('\n  ')}` : 'no console errors');
console.log(`screenshots: ${fs.readdirSync(out).length} files in test-artifacts/screens/`);
