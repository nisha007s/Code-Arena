// The two-pane workspace shared by Practice and the Arena:
// problem on the left; language, editor, Run/Submit and console on the right.
// Below 900px it becomes Problem / Editor / Results tabs (panes are hidden, never
// destroyed, so unsent work is kept).
import { api, requestId, ApiError } from './api.js';
import { h, icon, richText, difficultyBadge, tagList, verdictEl, announce, VERDICTS, errorMessage } from './ui.js';
import { CodeEditor } from './editor.js';
import { drafts } from './drafts.js';
import { CONFIG } from './config.js';

// The Supabase (WebAssembly) judge runs Python and JavaScript; the local Docker judge runs all five.
const LANGUAGES = CONFIG.backend === 'supabase' ? CONFIG.languages : [
  ['python', 'Python 3'],
  ['javascript', 'JavaScript (Node.js)'],
  ['java', 'Java 21'],
  ['cpp', 'C++17'],
  ['csharp', 'C# (.NET 10)'],
];
const FILE_NAMES = { python: 'main.py', javascript: 'main.js', java: 'Main.java', cpp: 'main.cpp', csharp: 'Main.cs' };
const LAYOUT_KEY = 'code-arena.layout';
function loadLayout() {
  try { return { problem: 40, console: 36, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') }; } catch { return { problem: 40, console: 36 }; }
}
function saveLayout(layout) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ } }

/** Accessible splitter: drag with a pointer, or focus it and use the arrow keys. */
function splitter({ orientation, label, getPct, setPct, container }) {
  const el = h('div', { class: `resizer resizer-${orientation === 'vertical' ? 'x' : 'y'}`, role: 'separator', tabindex: '0', 'aria-orientation': orientation, 'aria-label': label, 'aria-valuemin': '20', 'aria-valuemax': '75' });
  const sync = () => el.setAttribute('aria-valuenow', String(Math.round(getPct())));
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('is-dragging');
    document.documentElement.classList.add(orientation === 'vertical' ? 'is-resizing-x' : 'is-resizing-y');
    const move = (ev) => {
      const r = container().getBoundingClientRect();
      const pct = orientation === 'vertical' ? ((ev.clientX - r.left) / r.width) * 100 : ((r.bottom - ev.clientY) / r.height) * 100;
      setPct(pct); sync();
    };
    const up = () => {
      el.classList.remove('is-dragging');
      document.documentElement.classList.remove('is-resizing-x', 'is-resizing-y');
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 3;
    const keys = orientation === 'vertical' ? { ArrowLeft: -step, ArrowRight: step } : { ArrowUp: step, ArrowDown: -step };
    if (keys[e.key] !== undefined) { e.preventDefault(); setPct(getPct() + keys[e.key]); sync(); }
  });
  el.addEventListener('dblclick', () => { setPct(orientation === 'vertical' ? 40 : 36); sync(); });
  sync();
  return el;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⌘' : 'Ctrl';

export function renderProblem(p) {
  const section = (title, items, asList) => [
    h('h2', {}, title),
    asList ? h('ul', {}, items.map((t) => h('li', {}, richText(t)))) : items.map((t) => h('p', {}, richText(t))),
  ];
  return h('article', { 'aria-labelledby': 'problem-title' },
    h('h1', { id: 'problem-title' }, `${p.number}. ${p.title}`),
    h('div', { class: 'row meta-row' }, difficultyBadge(p.difficulty), tagList(p.tags)),
    p.statement.map((t) => h('p', {}, richText(t))),
    section('Input', p.inputFormat),
    section('Output', p.outputFormat),
    section('Constraints', p.constraints, true),
    h('h2', {}, 'Examples'),
    p.examples.map((ex, i) => h('div', { class: 'example' },
      h('div', { class: 'example-head' }, `Example ${i + 1}`),
      h('div', { class: 'example-body' },
        h('div', {}, h('div', { class: 'example-label' }, 'Input'), h('pre', {}, ex.input)),
        h('div', {}, h('div', { class: 'example-label' }, 'Output'), h('pre', {}, ex.output))),
      ex.explanation ? h('p', { class: 'ex-note' }, richText(ex.explanation)) : null)),
  );
}

export class Workspace {
  /**
   * @param {HTMLElement} host
   * @param {object} o
   * @param {object} o.problem   public problem detail (with starters)
   * @param {string} o.guestId
   * @param {string} o.scope     'practice' or 'round:<id>'
   * @param {(code:{language:string, source:string, requestId:string}) => Promise<object>} [o.submit]  battle override
   * @param {() => {ready:boolean, message?:string}} [o.judgeState]
   */
  constructor(host, { problem, guestId, scope, submit, judgeState, submitLabel = 'Submit', context = 'practice' }) {
    Object.assign(this, { problem, guestId, scope, submitOverride: submit, judgeState });
    this.activeJobId = null;
    this.busy = false;
    this.submitLock = null;
    const uid = 'ws-' + Math.random().toString(36).slice(2, 8);

    const tabs = ['problem', 'editor', 'results'].map((name) => h('button', {
      type: 'button', role: 'tab', id: `${uid}-tab-${name}`, 'aria-controls': `${uid}-${name}`,
      'aria-selected': name === 'editor' ? 'true' : 'false', onclick: () => this.showPane(name),
    }, name[0].toUpperCase() + name.slice(1)));
    this.tabs = tabs;

    this.langSelect = h('select', { id: `${uid}-lang`, 'aria-label': 'Language' },
      LANGUAGES.map(([id, name]) => h('option', { value: id }, name)));
    this.runBtn = h('button', { class: 'btn', type: 'button', onclick: () => this.run(), 'aria-keyshortcuts': `${isMac ? 'Meta' : 'Control'}+Enter` }, icon('play'), 'Run');
    this.submitBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => this.submit(), 'aria-keyshortcuts': `${isMac ? 'Meta' : 'Control'}+Shift+Enter` }, icon('send'), submitLabel);
    this.fileTab = h('span', { class: 'file-tab', 'aria-hidden': 'true' }, icon('code'), h('span', {}, 'main.py'));
    this.consoleStatus = h('span', { class: 'console-status' });
    this.customToggle = h('input', { type: 'checkbox', id: `${uid}-custom` });
    this.customInput = h('textarea', { id: `${uid}-stdin`, 'aria-label': 'Custom input (stdin)', placeholder: 'Type input for your program…', spellcheck: 'false' });
    this.customBox = h('div', { class: 'custom-input', hidden: true }, h('label', { for: `${uid}-stdin` }, 'Custom input (stdin). Run uses this instead of the examples.'), this.customInput);
    this.customToggle.addEventListener('change', () => { this.customBox.hidden = !this.customToggle.checked; });
    this.lockNote = h('span', { class: 'lock-note', 'aria-live': 'polite' });
    this.cursorEl = h('span', { class: 'status-item', 'aria-hidden': 'true' }, 'Ln 1, Col 1');
    this.langStatus = h('span', { class: 'status-item status-lang' }, 'Python 3');
    this.fontLabel = h('span', { class: 'font-size', 'aria-live': 'polite' }, '14px');
    const fontBtn = (delta, text, lbl) => h('button', { class: 'status-btn', type: 'button', 'aria-label': lbl, title: lbl, onclick: () => { this.fontLabel.textContent = `${this.editor.setFontSize(this.editor.fontSize + delta)}px`; } }, text);
    this.fontControls = h('span', { class: 'status-item font-controls', role: 'group', 'aria-label': 'Editor font size' },
      fontBtn(-1, 'A−', 'Smaller editor font'), this.fontLabel, fontBtn(1, 'A+', 'Larger editor font'));
    this.console = h('div', { class: 'console-body' });
    const consolePanel = h('section', { class: 'console pane panel', id: `${uid}-results`, role: 'tabpanel', 'aria-labelledby': `${uid}-tab-results`, 'aria-label': 'Results' },
      h('div', { class: 'panel-head' }, h('span', { class: 'title' }, icon('terminal'), 'Console'), this.consoleStatus),
      this.console);
    this.renderIdle();
    const problemHead = context === 'practice'
      ? h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' }, h('a', { href: '/problems.html' }, icon('arrowLeft'), 'Problems'), h('span', { 'aria-hidden': 'true' }, '/'), h('span', { class: 'current' }, problem.title))
      : h('span', { class: 'title' }, icon('target'), 'Round problem');

    const editorHost = h('div', { class: 'editor-host' });
    this.layout = loadLayout();
    const applyLayout = () => {
      this.root.style.setProperty('--problem-w', `${this.layout.problem}%`); // CSSOM custom properties (CSP-safe)
      this.root.style.setProperty('--console-h', `${this.layout.console}%`);
    };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    this.splitX = splitter({ orientation: 'vertical', label: 'Resize problem and editor panels', container: () => this.root,
      getPct: () => this.layout.problem, setPct: (p) => { this.layout.problem = clamp(p, 24, 62); applyLayout(); saveLayout(this.layout); } });
    this.splitY = splitter({ orientation: 'horizontal', label: 'Resize editor and console', container: () => this.codeCol,
      getPct: () => this.layout.console, setPct: (p) => { this.layout.console = clamp(p, 18, 70); applyLayout(); saveLayout(this.layout); } });
    this.root = h('div', { class: 'workspace', 'data-pane': 'editor' },
      h('div', { class: 'pane-tabs', role: 'tablist', 'aria-label': 'Workspace panes' }, tabs),
      h('section', { class: 'pane pane-problem panel', id: `${uid}-problem`, role: 'tabpanel', 'aria-labelledby': `${uid}-tab-problem` },
        h('div', { class: 'panel-head' }, problemHead, h('span', { class: 'spacer' }), h('span', { class: 'faint' }, 'Description')),
        h('div', { class: 'problem-scroll' }, renderProblem(problem))),
      this.splitX,
      this.codeCol = h('div', { class: 'code-col' },
        h('div', { class: 'editor-area panel', id: `${uid}-editor`, role: 'tabpanel', 'aria-labelledby': `${uid}-tab-editor` },
          h('div', { class: 'toolbar' },
            this.fileTab,
            h('label', { for: `${uid}-lang`, class: 'visually-hidden' }, 'Language'), this.langSelect,
            h('button', { class: 'btn btn-ghost btn-small', type: 'button', title: 'Replace your code with the starter template', onclick: () => this.resetDraft() }, icon('refresh', 'icon icon-sm'), 'Reset code'),
            h('div', { class: 'actions' },
              h('label', { for: `${uid}-custom`, class: 'check' }, this.customToggle, 'Custom input'),
              this.runBtn, this.submitBtn)),
          editorHost,
          this.customBox,
          h('div', { class: 'run-row status-bar' },
            this.lockNote,
            this.cursorEl,
            h('span', { class: 'status-item status-hide-sm', 'aria-hidden': 'true' }, 'Spaces: 4'),
            this.langStatus,
            h('span', { class: 'spacer' }),
            // Full sentence for screen readers (the editor's aria-describedby); compact key caps on screen.
            h('span', { class: 'editor-hint', id: `${uid}-code-help`, title: `Tab indents · Esc then Tab leaves the editor · ${MOD}+Enter runs · ${MOD}+Shift+Enter submits` },
              h('span', { class: 'visually-hidden' }, `Tab indents. Press Escape, then Tab, to leave the editor. ${MOD} plus Enter runs your code. ${MOD} plus Shift plus Enter submits.`),
              h('span', { class: 'hint-keys', 'aria-hidden': 'true' },
                h('span', { class: 'hint-group' }, h('kbd', {}, 'Esc'), h('kbd', {}, 'Tab'), ' leave'),
                h('span', { class: 'hint-group' }, h('kbd', {}, MOD), h('kbd', {}, '↵'), ' Run'),
                h('span', { class: 'hint-group' }, h('kbd', {}, MOD), h('kbd', {}, '⇧'), h('kbd', {}, '↵'), ' Submit'))),
            this.fontControls)),
        this.splitY,
        consolePanel),
    );
    host.replaceChildren(this.root);
    applyLayout();

    this.editor = new CodeEditor(editorHost, {
      id: `${uid}-code`, label: `Code editor for ${problem.title}`,
      onChange: (v) => drafts.save(guestId, scope, problem.id, this.language, v),
      onRun: () => this.run(), onSubmit: () => this.submit(),
      onEscapeArmed: () => announce('Press Tab to leave the editor.'),
      onCursor: ({ line, col }) => { if (this.cursorEl) this.cursorEl.textContent = `Ln ${line}, Col ${col}`; },
    });
    this.editor.input.setAttribute('aria-describedby', `${uid}-code-help`);
    this.fontLabel.textContent = `${this.editor.fontSize}px`;

    this.language = drafts.lastLanguage(guestId, scope, problem.id) || drafts.lastLanguage(guestId, 'practice', problem.id) || 'python';
    if (!LANGUAGES.some(([id]) => id === this.language)) this.language = 'python';
    this.langSelect.value = this.language;
    this.loadDraft();
    this.#syncFileTab();
    this.langSelect.addEventListener('change', () => {
      drafts.save(guestId, scope, problem.id, this.language, this.editor.value);
      this.language = this.langSelect.value;
      drafts.setLastLanguage(guestId, scope, problem.id, this.language);
      this.loadDraft();
      this.#syncFileTab();
      announce(`Language: ${this.langSelect.selectedOptions[0].textContent}`);
    });
    // Another tab edited the same draft: pick it up unless this editor has focus.
    this.storageListener = (e) => {
      if (e.key === drafts.key(guestId, scope, problem.id, this.language) && document.activeElement !== this.editor.input && e.newValue !== null) {
        this.editor.value = e.newValue;
      }
    };
    window.addEventListener('storage', this.storageListener);
  }

  destroy() {
    window.removeEventListener('storage', this.storageListener);
    clearTimeout(this.pollTimer);
  }

  loadDraft() {
    const saved = drafts.load(this.guestId, this.scope, this.problem.id, this.language);
    this.editor.value = saved !== null ? saved : this.problem.starters[this.language];
  }

  resetDraft() {
    const name = this.langSelect.selectedOptions[0].textContent;
    if (!window.confirm(`Replace your ${name} code for “${this.problem.title}” with the starter template? This cannot be undone.`)) return;
    drafts.remove(this.guestId, this.scope, this.problem.id, this.language);
    this.loadDraft();
    announce('Code reset to the starter template.');
  }

  #syncFileTab() {
    this.fileTab.lastChild.textContent = FILE_NAMES[this.language] || 'main';
    this.langStatus.textContent = this.langSelect.selectedOptions[0]?.textContent || this.language;
  }

  showPane(name) {
    this.root.dataset.pane = name;
    for (const t of this.tabs) t.setAttribute('aria-selected', String(t.id.endsWith(name)));
  }

  /** Battle: lock submissions with a visible reason (null unlocks). */
  setSubmitLock(reason) {
    this.submitLock = reason;
    this.lockNote.replaceChildren(...(reason ? [icon('lock', 'icon icon-sm'), reason] : []));
    this.#syncButtons();
  }

  setReadOnly(ro) { this.editor.setReadOnly(ro); }

  #syncButtons() {
    this.runBtn.disabled = this.busy;
    this.submitBtn.disabled = this.busy || Boolean(this.submitLock);
  }

  // ---------- running code ----------

  async run() {
    const custom = this.customToggle.checked;
    await this.#start('run', custom ? this.customInput.value : null);
  }

  async submit() {
    if (this.submitLock) { announce(this.submitLock); return; }
    await this.#start('submit', null);
  }

  async #start(mode, customInput) {
    if (this.busy) return;
    const source = this.editor.value;
    if (!source.trim()) { this.renderError('Write some code first.'); return; }
    this.busy = true;
    this.#syncButtons();
    this.renderPending({ status: 'queued', mode });
    if (window.matchMedia('(max-width: 900px)').matches) this.showPane('results');
    const rid = requestId();
    try {
      let job;
      if (mode === 'submit' && this.submitOverride) {
        job = await this.submitOverride({ language: this.language, source, requestId: rid });
      } else {
        job = (await api('/api/submissions', {
          method: 'POST',
          body: { requestId: rid, problemId: this.problem.id, language: this.language, source, mode, customInput },
        })).job;
      }
      this.activeJobId = job.id;
      this.updateJob(job);
      this.#poll(job.id);
    } catch (e) {
      this.busy = false;
      this.#syncButtons();
      if (e instanceof ApiError && e.code === 'queue_full') this.renderError('The judge queue is full right now. Wait a few seconds and try again. Your code is saved.', 'Queue full');
      else if (e instanceof ApiError && e.code === 'network') this.renderError('Cannot reach the server. Your code is saved locally; try again once you are reconnected.', 'Offline');
      else this.renderError(errorMessage(e));
    }
  }

  #poll(id) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      if (this.activeJobId !== id) return;
      try {
        const { job } = await api(`/api/submissions/${id}`);
        this.updateJob(job);
        if (job.status !== 'done') this.#poll(id);
      } catch {
        this.#poll(id); // transient; keep trying
      }
    }, 700);
  }

  /** Called by polling and by realtime 'submission:update' events. */
  updateJob(job) {
    if (job.id !== this.activeJobId) return;
    if (job.status !== 'done') { this.renderPending(job); return; }
    if (this.lastRendered === job.id) return;
    this.lastRendered = job.id;
    clearTimeout(this.pollTimer);
    this.busy = false;
    this.#syncButtons();
    this.renderResult(job);
    const what = job.mode === 'run' ? 'Run' : 'Submission';
    announce(`${what} finished: ${job.verdictLabel || VERDICTS[job.verdict] || job.verdict}`);
  }

  // ---------- console rendering ----------

  setStatus(node) { this.consoleStatus.replaceChildren(...(node ? [node] : [])); }

  renderIdle() {
    this.setStatus(h('span', { class: 'badge' }, 'Ready'));
    this.console.replaceChildren(h('div', { class: 'console-idle' }, h('span', { class: 'icon-tile' }, icon('terminal')),
      h('div', {}, h('p', {}, h('strong', {}, 'Run'), ' checks your code against the public examples, or your own input with ', h('strong', {}, 'Custom input'), '.'),
        h('p', { class: 'mt-2' }, h('strong', {}, 'Submit'), ' runs the examples and the hidden tests. Hidden test data is never shown.'))));
  }

  renderPending(job) {
    const label = job.status === 'judging' ? 'Judging…' : 'Queued…';
    this.setStatus(h('span', { class: 'badge badge-accent' }, label));
    this.console.replaceChildren(h('div', { class: 'console-head' }, h('span', { class: 'loading', role: 'status' }, label),
      h('span', { class: 'muted' }, job.mode === 'submit' ? 'Running the examples and hidden tests.' : 'Running your code.')));
  }

  renderError(message, title = 'Not sent') {
    this.setStatus(h('span', { class: 'verdict v-WA verdict-pill' }, title));
    this.console.replaceChildren(h('div', { class: 'verdict-banner v-WA' }, h('div', { class: 'console-head' }, h('strong', {}, title)), h('p', { role: 'alert' }, message)));
    announce(`${title}: ${message}`);
  }

  renderResult(job) {
    const r = job.result || {};
    this.setStatus(verdictEl(job.verdict, job.verdictLabel, true));
    const examples = (r.cases || []).filter((c) => c.visibility === 'public');
    const passed = examples.filter((c) => c.verdict === 'AC').length;
    const slowest = Math.max(0, ...(r.cases || []).map((c) => c.timeMs || 0));
    // Submit stops at the first failing test, so name it instead of counting.
    const failing = examples.find((c) => c.verdict !== 'AC');
    let summary = '';
    if (job.mode === 'submit') {
      if (job.verdict === 'AC') summary = 'All tests passed.';
      else if (failing) summary = `Failed on ${failing.label}${failing.timeMs ? ` · ${failing.timeMs} ms` : ''}`;
      else if (r.hidden && !r.hidden.passed) summary = 'All examples passed; a hidden test failed.';
    } else if (examples.length) {
      summary = `${passed} of ${examples.length} example${examples.length === 1 ? '' : 's'} passed${slowest ? ` · slowest ${slowest} ms` : ''}`;
    }
    const parts = [h('div', { class: `verdict-banner v-${job.verdict}` },
      h('div', { class: 'console-head' },
        verdictEl(job.verdict, job.verdictLabel),
        h('span', { class: 'muted' }, job.mode === 'submit' ? 'Submission' : 'Run'),
        job.kind === 'battle' ? h('span', { class: 'badge' }, 'Match') : null),
      summary ? h('p', {}, summary) : null,
      r.message ? h('p', {}, r.message) : null)];
    if (r.compile && !r.compile.ok) parts.push(h('div', { class: 'io-label' }, 'Compiler / syntax output'), h('pre', { class: 'block' }, r.compile.output || '(no output)'));
    for (const c of r.cases || []) {
      if (c.visibility === 'custom') {
        parts.push(h('div', { class: 'stack' },
          h('div', {}, h('div', { class: 'io-label' }, `Status: ${c.verdict === 'OK' ? 'finished' : VERDICTS[c.verdict]} · exit code ${c.exitCode ?? '—'} · ${c.timeMs} ms`)),
          h('div', {}, h('div', { class: 'io-label' }, 'stdout'), h('pre', { class: 'block' }, c.stdout || '(empty)')),
          c.stderr ? h('div', {}, h('div', { class: 'io-label' }, 'stderr'), h('pre', { class: 'block' }, c.stderr)) : null));
        continue;
      }
      const d = h('details', { class: 'case', open: c.verdict !== 'AC' ? true : null },
        h('summary', {}, verdictEl(c.verdict), h('span', {}, c.label), h('span', { class: 'muted' }, `${c.timeMs} ms`)),
        h('div', { class: 'case-body' },
          h('div', {}, h('div', { class: 'io-label' }, 'Input'), h('pre', {}, c.input)),
          h('div', {}, h('div', { class: 'io-label' }, 'Expected output'), h('pre', {}, c.expected)),
          h('div', {}, h('div', { class: 'io-label' }, 'Your output'), h('pre', {}, c.stdout || '(empty)')),
          c.stderr ? h('div', { class: 'full' }, h('div', { class: 'io-label' }, 'stderr'), h('pre', {}, c.stderr)) : null));
      parts.push(d);
    }
    if (r.hidden) {
      parts.push(h('div', { class: 'hidden-summary' }, icon('lock'),
        r.hidden.passed ? verdictEl('AC', 'Hidden tests passed') : verdictEl(r.hidden.verdict, `Hidden test failed: ${VERDICTS[r.hidden.verdict]}`),
        h('span', { class: 'muted' }, 'Hidden test inputs and outputs are not shown.')));
    }
    this.console.replaceChildren(...parts);
  }
}
