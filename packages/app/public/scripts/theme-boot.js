// Apply theme before first paint (matches main.tsx logic).
// Reads build-time values from <meta> tags injected by Vite transformIndexHtml
// so this file stays external (MV3 CSP: script-src 'self').
(function () {
  var snMeta = document.querySelector('meta[name="app-short-name"]');
  var sn = snMeta ? snMeta.getAttribute('content') : 'teamclaw';
  var theme;
  try {
    theme = localStorage.getItem(sn + '-theme');
  } catch (e) {}
  if (!theme) theme = 'system';
  if (
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  ) {
    document.documentElement.classList.add('dark');
  }
  var paletteMeta = document.querySelector('meta[name="app-palette"]');
  var palette = paletteMeta ? paletteMeta.getAttribute('content') : 'default';
  if (palette && palette !== 'default') {
    document.documentElement.setAttribute('data-palette', palette);
  }
})();
