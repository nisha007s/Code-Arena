// Runs before first paint (classic script in <head>) so there is no theme flash.
// Saved choice wins; otherwise follow the operating-system preference.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('code-arena.theme'); } catch (e) { /* storage blocked */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
