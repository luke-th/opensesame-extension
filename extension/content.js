// Intercepts shortcut+click on links and hands the URL to the service worker.
(() => {
  let settings = null;
  // Whether the shortcut's regular key (if any) is currently held down.
  let keyHeld = false;

  function applySettings(s) {
    settings = s;
    if (!s.shortcut.code) keyHeld = false;
  }
  osLoadSettings().then(applySettings);
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') osLoadSettings().then(applySettings);
  });

  const SKIP_SCHEMES = /^(javascript|mailto|tel|sms|blob|data|about):/i;

  function send(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') return p.catch(() => undefined);
    } catch (_) {
      // Extension was reloaded and this page's context is stale; reload the page to fix.
    }
    return Promise.resolve(undefined);
  }

  // ---- Regular-key tracking --------------------------------------------------
  // Key events only reach the focused frame, so the worker keeps one browser-wide "held"
  // flag: any frame that sees keydown/keyup reports it, the worker broadcasts to every
  // frame, and clears it when Chrome itself loses focus.

  function isTriggerKey(e) {
    return !!(settings && settings.shortcut.code && e.code === settings.shortcut.code);
  }

  function setHeld(held, report) {
    if (keyHeld === held) return;
    keyHeld = held;
    if (report) send({ type: 'key-held', held });
  }

  window.addEventListener('keydown', (e) => { if (isTriggerKey(e)) setHeld(true, true); }, true);
  window.addEventListener('keyup', (e) => { if (isTriggerKey(e)) setHeld(false, true); }, true);
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'key-held') setHeld(!!msg.held, false);
    });
  } catch (_) {}
  // Pick up the current state (the key may already be held when this page loads). This also
  // tells the worker this frame is ready to see key events.
  send({ type: 'key-state' }).then((r) => { if (r && typeof r.held === 'boolean') setHeld(r.held, false); });

  // ---- Click interception -----------------------------------------------------

  // Exact match: the configured modifiers must be down and nothing else.
  function modifiersMatch(e, sc) {
    return e.metaKey === sc.meta && e.altKey === sc.alt && e.shiftKey === sc.shift && e.ctrlKey === sc.ctrl;
  }

  // Walk the composed path so links inside shadow DOM are found too.
  function findAnchor(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const node of path) {
      if (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) return node;
      if (typeof SVGAElement !== 'undefined' && node instanceof SVGAElement) return node;
    }
    const t = e.target;
    return t && typeof t.closest === 'function' ? t.closest('a[href], area[href]') : null;
  }

  function hrefOf(a) {
    const h = a.href;
    if (typeof h === 'string') return h;
    // SVG <a> exposes href as SVGAnimatedString.
    if (h && typeof h === 'object' && 'baseVal' in h && h.baseVal) {
      try { return new URL(h.baseVal, location.href).href; } catch (_) { return ''; }
    }
    return '';
  }

  window.addEventListener('click', (e) => {
    if (!settings || e.button !== 0) return;
    const sc = settings.shortcut;
    if (!osShortcutActive(sc) || !modifiersMatch(e, sc)) return;
    if (sc.code && !keyHeld) return;

    const a = findAnchor(e);
    if (!a) return;
    const url = hrefOf(a);
    if (!url || SKIP_SCHEMES.test(url)) return;

    // Stop the browser's own modifier behaviour (new tab / download) and any page handlers.
    e.preventDefault();
    e.stopImmediatePropagation();
    send({ type: 'open-other-screen', url });
  }, true);
})();
