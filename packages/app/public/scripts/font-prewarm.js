// Font fallback prewarm — force Core Text / DirectWrite to load and cache
// the fallback fonts (emoji + CJK + symbols) before React mounts.
(function prewarmFontFallbacks() {
  var span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.style.cssText =
    'position:absolute;left:-9999px;top:0;opacity:0;pointer-events:none;font-size:16px';
  span.textContent = '中文简体 繁體中文 日本語 한국어 😀🎉✨📦🚀💬🤖 ✓✗→←↑↓ ∑∫√';
  document.body.appendChild(span);
  void span.getBoundingClientRect();
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      span.remove();
    });
  });
})();
