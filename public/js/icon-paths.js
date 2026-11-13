// One icon set for the whole app (24×24, 2px strokes, round joins).
// Each icon is a list of SVG child elements: [tag, attributes].
const p = (d) => ['path', { d }];
const c = (cx, cy, r) => ['circle', { cx, cy, r }];
const r = (x, y, width, height, rx = 2) => ['rect', { x, y, width, height, rx }];

export const ICONS = {
  home: [p('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z')],
  problems: [p('M9 6h12M9 12h12M9 18h12'), p('M4 6h.01M4 12h.01M4 18h.01')],
  arena: [p('M13 2 4 14h7l-1 8 9-12h-7z')],
  history: [c(12, 12, 9), p('M12 7v5l3 2')],
  sun: [c(12, 12, 4), p('M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4')],
  moon: [p('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z')],
  play: [p('M7 4.5v15l12-7.5z')],
  send: [p('M22 2 11 13'), p('M22 2l-7 20-4-9-9-4z')],
  check: [p('M5 12.5l4.5 4.5L19 7')],
  x: [p('M6 6l12 12M18 6 6 18')],
  copy: [r(9, 9, 12, 12), p('M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1')],
  user: [c(12, 8, 4), p('M4 21a8 8 0 0 1 16 0')],
  users: [c(9, 8, 3.5), p('M2.5 20a6.5 6.5 0 0 1 13 0'), p('M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2a6.5 6.5 0 0 1 3.5 5.8')],
  trophy: [p('M8 21h8M12 17v4'), p('M7 4h10v5a5 5 0 0 1-10 0z'), p('M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4')],
  code: [p('M8 6l-6 6 6 6M16 6l6 6-6 6')],
  terminal: [r(2, 4, 20, 16), p('M6 9l4 3-4 3M12 15h5')],
  shield: [p('M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'), p('M8.5 12l2.5 2.5L15.5 10')],
  chart: [p('M4 20V11M10 20V5M16 20v-6M2 20h20')],
  compass: [c(12, 12, 9), p('M15.5 8.5l-2 5-5 2 2-5z')],
  search: [c(11, 11, 7), p('M20 20l-3.5-3.5')],
  link: [p('M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1'), p('M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1')],
  pencil: [p('M4 20h4L19 9l-4-4L4 16z'), p('M13.5 6.5l4 4')],
  refresh: [p('M20 11a8 8 0 1 0-2.3 5.7'), p('M20 4v7h-7')],
  arrowRight: [p('M5 12h14M13 6l6 6-6 6')],
  arrowLeft: [p('M19 12H5M11 6l-6 6 6 6')],
  globe: [c(12, 12, 9), p('M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18')],
  lock: [r(4, 11, 16, 10), p('M8 11V7a4 4 0 0 1 8 0v4')],
  flag: [p('M5 21V4M5 4h11l-2 4 2 4H5')],
  timer: [c(12, 13, 8), p('M12 9v4l2.5 2M9 2h6')],
  alert: [p('M12 3 2 21h20z'), p('M12 10v5M12 18h.01')],
  info: [c(12, 12, 9), p('M12 11v5M12 8h.01')],
  layers: [p('M12 3 2 8l10 5 10-5z'), p('M2 13l10 5 10-5')],
  zap: [p('M13 2 4 14h7l-1 8 9-12h-7z')],
  target: [c(12, 12, 9), c(12, 12, 5), c(12, 12, 1)],
  door: [p('M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8'), p('M10 12h11M18 9l3 3-3 3')],
  minus: [p('M5 12h14')],
  sliders: [p('M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0'), c(16, 6, 2), c(10, 12, 2), c(18, 18, 2)],
};

/** SVG markup string (used to generate the static page headers). */
export function iconMarkup(name, cls = 'icon') {
  const parts = (ICONS[name] || []).map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${parts}</svg>`;
}
