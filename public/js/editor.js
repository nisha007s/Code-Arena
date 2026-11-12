// Plain <textarea> code editor with synchronised line numbers.
//   Tab / Shift+Tab   indent / outdent (4 spaces)
//   Esc, then Tab     move focus out of the editor (keyboard escape hatch)
//   Enter             keeps the current line's indentation
//   Ctrl/⌘+Enter      Run          Ctrl/⌘+Shift+Enter   Submit
import { h } from './ui.js';

const INDENT = '    ';

export class CodeEditor {
  constructor(host, { id, label, onChange, onRun, onSubmit, onEscapeArmed }) {
    this.onChange = onChange;
    this.gutter = h('div', { class: 'editor-gutter', 'aria-hidden': 'true' }, '1');
    this.input = h('textarea', {
      id, class: 'editor-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
      autocorrect: 'off', wrap: 'off', 'aria-label': label, 'aria-describedby': id + '-help', 'aria-multiline': 'true',
    });
    this.root = h('div', { class: 'editor' }, this.gutter, this.input);
    host.append(this.root);
    this.escapeArmed = false;
    this.lines = 0;

    this.input.addEventListener('input', () => { this.#renderGutter(); this.onChange?.(this.input.value); });
    this.input.addEventListener('scroll', () => { this.gutter.scrollTop = this.input.scrollTop; });
    this.input.addEventListener('blur', () => { this.escapeArmed = false; });
    this.input.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') { e.preventDefault(); (e.shiftKey ? onSubmit : onRun)?.(); return; }
      if (e.key === 'Escape') { this.escapeArmed = true; onEscapeArmed?.(); return; }
      if (e.key === 'Tab') {
        if (this.escapeArmed || this.input.readOnly) { this.escapeArmed = false; return; } // let focus move on
        e.preventDefault();
        if (e.shiftKey) this.#outdent(); else this.#indent();
        return;
      }
      this.escapeArmed = false;
      if (e.key === 'Enter' && !mod && !e.altKey) {
        const { value, selectionStart } = this.input;
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const leading = value.slice(lineStart, selectionStart).match(/^[ \t]*/)[0];
        const opensBlock = /[:{[(]\s*$/.test(value.slice(lineStart, selectionStart));
        e.preventDefault();
        this.#insert('\n' + leading + (opensBlock ? INDENT : ''));
      }
    });
  }

  get value() { return this.input.value; }
  set value(v) {
    this.input.value = v;
    this.input.scrollTop = 0;
    this.#renderGutter();
  }

  setReadOnly(ro) { this.input.readOnly = ro; }
  focus() { this.input.focus(); }

  // Prefer execCommand so the browser's undo history keeps working.
  #insert(text) {
    this.input.focus();
    const ok = document.execCommand && document.execCommand('insertText', false, text);
    if (!ok) {
      this.input.setRangeText(text, this.input.selectionStart, this.input.selectionEnd, 'end');
      this.input.dispatchEvent(new Event('input'));
    }
  }

  #indent() {
    const { value, selectionStart: s, selectionEnd: e } = this.input;
    if (s === e || !value.slice(s, e).includes('\n')) { this.#insert(INDENT); return; }
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const block = value.slice(start, e);
    const next = block.replace(/^/gm, INDENT);
    this.input.setSelectionRange(start, e);
    this.#insert(next);
    this.input.setSelectionRange(start, start + next.length);
  }

  #outdent() {
    const { value, selectionStart: s, selectionEnd: e } = this.input;
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const end = Math.max(e, s);
    const block = value.slice(start, end);
    const next = block.replace(/^( {1,4}|\t)/gm, '');
    if (next === block) return;
    this.input.setSelectionRange(start, end);
    this.#insert(next);
    this.input.setSelectionRange(start, start + next.length);
  }

  #renderGutter() {
    const count = this.input.value.split('\n').length;
    if (count === this.lines) return;
    this.lines = count;
    let text = '';
    for (let i = 1; i <= count; i++) text += i + '\n';
    this.gutter.textContent = text;
    this.gutter.scrollTop = this.input.scrollTop;
  }
}
