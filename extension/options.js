(async () => {
  const isMac = /Mac/i.test(navigator.platform)
    || (navigator.userAgentData && navigator.userAgentData.platform === 'macOS');

  const SYMBOLS = isMac
    ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
    : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' };
  const ORDER = ['ctrl', 'alt', 'shift', 'meta'];
  const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'NumLock', 'ScrollLock', 'Symbol']);
  const CODE_LABELS = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Enter: '⏎', Tab: '⇥', Backspace: '⌫', Delete: '⌦', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  };

  const $ = (sel) => document.querySelector(sel);
  const display = $('#shortcutDisplay');
  const recordBtn = $('#recordBtn');
  const clearKeyBtn = $('#clearKeyBtn');
  const arrangement = $('#arrangement');
  const autoBtn = $('#autoBtn');
  const modeText = $('#modeText');
  const focusInput = $('#focusNewWindow');
  const menuInput = $('#contextMenu');
  const warn = $('#warn');
  const status = $('#status');

  let settings = await osLoadSettings();
  let recording = false;
  let pending = null;

  // ---- Displays -----------------------------------------------------------

  let displays = [];
  let thisWindow = null;
  let hereId = null;

  async function loadDisplays() {
    displays = (await new Promise((resolve) => chrome.system.display.getInfo((d) => resolve(d || []))))
      .filter((d) => d.isEnabled !== false);
    thisWindow = await Promise.resolve(chrome.windows.getCurrent()).catch(() => null);
    hereId = thisWindow ? displayContaining(displays, thisWindow) : null;
  }
  await loadDisplays();

  // Keep "This window" honest if the settings window is dragged to another display, and
  // redraw if displays are plugged in or out while the page is open.
  if (chrome.windows.onBoundsChanged) {
    chrome.windows.onBoundsChanged.addListener((w) => {
      if (!thisWindow || w.id !== thisWindow.id) return;
      thisWindow = { ...thisWindow, ...w };
      hereId = displayContaining(displays, thisWindow);
      render();
    });
  }
  if (chrome.system.display.onDisplayChanged) {
    chrome.system.display.onDisplayChanged.addListener(async () => {
      await loadDisplays();
      buildArrangement();
      render();
    });
  }

  function nameOf(d) {
    return d.name || (d.isPrimary ? 'Main display' : 'Display');
  }

  function overlap(a, b) {
    const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function displayContaining(ds, win) {
    let best = null, bestArea = 0;
    for (const d of ds) {
      const area = overlap({ left: win.left || 0, top: win.top || 0, width: win.width || 0, height: win.height || 0 }, d.bounds);
      if (area > bestArea) { best = d; bestArea = area; }
    }
    return best ? best.id : null;
  }

  // Lay the displays out to scale, the way macOS's Displays pane does.
  function buildArrangement() {
    arrangement.innerHTML = '';
    if (!displays.length) return;
    const minL = Math.min(...displays.map((d) => d.bounds.left));
    const minT = Math.min(...displays.map((d) => d.bounds.top));
    const maxR = Math.max(...displays.map((d) => d.bounds.left + d.bounds.width));
    const maxB = Math.max(...displays.map((d) => d.bounds.top + d.bounds.height));
    const totalW = maxR - minL, totalH = maxB - minT;
    const pad = 20;
    const gap = 8; // breathing room between adjacent displays
    const width = arrangement.clientWidth || 500;
    const scale = Math.min((width - pad * 2) / totalW, 220 / totalH);
    arrangement.style.height = `${Math.round(totalH * scale + pad * 2)}px`;
    const offsetX = (width - totalW * scale) / 2;

    for (const d of displays) {
      const b = d.bounds;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'screen';
      btn.dataset.id = d.id;
      btn.setAttribute('role', 'radio');
      btn.style.left = `${offsetX + (b.left - minL) * scale + gap / 2}px`;
      btn.style.top = `${pad + (b.top - minT) * scale + gap / 2}px`;
      btn.style.width = `${b.width * scale - gap}px`;
      btn.style.height = `${b.height * scale - gap}px`;
      btn.classList.toggle('is-primary', !!d.isPrimary);
      btn.title = `${nameOf(d)} · ${b.width}×${b.height}${d.isPrimary ? ' · primary' : ''}`;

      const label = document.createElement('span');
      label.className = 'screen-label';
      const name = document.createElement('span');
      name.className = 'screen-name';
      name.textContent = nameOf(d);
      const size = document.createElement('span');
      size.className = 'screen-size';
      size.textContent = `${b.width} × ${b.height}`;
      label.append(name, size);
      const target = document.createElement('span');
      target.className = 'badge target';
      target.textContent = 'Target';
      const here = document.createElement('span');
      here.className = 'badge here';
      here.textContent = 'This window';
      btn.append(target, here, label);

      btn.addEventListener('click', () => {
        settings.targetDisplay = settings.targetDisplay === d.id ? 'auto' : d.id;
        render();
        save();
      });
      arrangement.append(btn);
    }
  }

  autoBtn.addEventListener('click', () => { settings.targetDisplay = 'auto'; render(); save(); });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { buildArrangement(); render(); }, 100);
  });

  // ---- Shortcut formatting --------------------------------------------------

  // Use the physical key (code) so ⌥O doesn't become "ø", and give it a readable label.
  function keyLabel(e) {
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
    if (/^Numpad\d$/.test(e.code)) return 'Num' + e.code.slice(6);
    if (CODE_LABELS[e.code]) return CODE_LABELS[e.code];
    if (/^F\d{1,2}$/.test(e.code)) return e.code;
    return e.key && e.key.length === 1 ? e.key.toUpperCase() : (e.key || e.code);
  }

  function describe(sc) {
    const parts = ORDER.filter((k) => sc[k]).map((k) => SYMBOLS[k]);
    if (sc.code) parts.push(sc.key || sc.code);
    return parts.join(isMac ? '' : '+');
  }

  // ---- Recorder -------------------------------------------------------------

  function startRecording() {
    recording = true;
    pending = { meta: false, alt: false, shift: false, ctrl: false, code: '', key: '' };
    render();
  }

  function stopRecording() {
    recording = false;
    pending = null;
    render();
  }

  function commit(shortcut) {
    settings.shortcut = shortcut;
    recording = false;
    pending = null;
    render();
    save();
  }

  window.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stopRecording();
    pending.meta = e.metaKey; pending.alt = e.altKey; pending.shift = e.shiftKey; pending.ctrl = e.ctrlKey;
    if (MODIFIER_KEYS.has(e.key)) {
      render();
    } else {
      pending.code = e.code;
      pending.key = keyLabel(e);
      commit(pending);
    }
  }, true);

  // Releasing a modifier with nothing else pressed = a modifiers-only shortcut.
  window.addEventListener('keyup', (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (MODIFIER_KEYS.has(e.key) && (pending.meta || pending.alt || pending.shift || pending.ctrl)) commit(pending);
  }, true);

  recordBtn.addEventListener('click', () => (recording ? stopRecording() : startRecording()));
  clearKeyBtn.addEventListener('click', () => commit({ ...settings.shortcut, code: '', key: '' }));

  // ---- Render -------------------------------------------------------------

  function render() {
    const sc = settings.shortcut;
    display.classList.toggle('recording', recording);
    if (recording) {
      const p = describe(pending);
      display.textContent = p ? `${p} …` : 'Press keys…';
      display.classList.remove('empty');
      recordBtn.textContent = 'Cancel';
    } else {
      const text = describe(sc);
      display.textContent = text ? `${text} + click` : 'No shortcut';
      display.classList.toggle('empty', !text);
      recordBtn.textContent = 'Change';
    }
    clearKeyBtn.hidden = recording || !sc.code;

    // Target screen. A pinned display that isn't connected right now behaves as Auto.
    const pinned = displays.find((d) => d.id === settings.targetDisplay) || null;
    for (const el of arrangement.querySelectorAll('.screen')) {
      const on = !!pinned && el.dataset.id === pinned.id;
      el.classList.toggle('selected', on);
      el.classList.toggle('here', el.dataset.id === hereId);
      el.setAttribute('aria-checked', String(on));
    }
    autoBtn.classList.toggle('on', !pinned);
    autoBtn.setAttribute('aria-pressed', String(!pinned));
    if (displays.length < 2) {
      modeText.textContent = 'Only one display detected right now. Links open in a new window fitted to it.';
    } else if (pinned) {
      modeText.textContent = `Always opens on ${nameOf(pinned)}. Click it again, or Auto, to go back.`;
    } else {
      modeText.textContent = 'Opens on whichever screen you didn’t click from. Click a screen to always use it instead.'
        + (settings.targetDisplay !== 'auto' ? ' Your pinned screen isn’t connected right now.' : '');
    }

    focusInput.checked = settings.focusNewWindow;
    menuInput.checked = settings.contextMenu;

    const modCount = ORDER.filter((k) => sc[k]).length;
    let message = '';
    if (!osShortcutActive(sc)) {
      message = 'Set a shortcut, otherwise clicks are never intercepted.';
    } else if (sc.code && !modCount && /^(Key|Digit|Numpad)/.test(sc.code)) {
      message = 'Holding a letter or number with no modifier also types it into any focused text field. Add a modifier, or pick a key like ` or an F‑key.';
    } else if (!sc.code) {
      const m = sc;
      if (m.meta && !m.alt && !m.shift && !m.ctrl && isMac) {
        message = 'Heads up: this replaces ⌘‑click, which normally opens a link in a new tab.';
      } else if (!m.meta && !m.alt && !m.shift && m.ctrl && !isMac) {
        message = 'Heads up: this replaces Ctrl‑click, which normally opens a link in a new tab.';
      } else if (!m.meta && m.alt && !m.shift && !m.ctrl) {
        message = 'Heads up: this replaces Alt/Option‑click, which normally downloads the link.';
      } else if (!m.meta && !m.alt && m.shift && !m.ctrl) {
        message = 'Heads up: this replaces Shift‑click, which normally opens a link in a new window.';
      }
    }
    warn.textContent = message;
    warn.hidden = !message;
  }

  // ---- Save ---------------------------------------------------------------

  let statusTimer;
  async function save() {
    await osSaveSettings(settings);
    status.textContent = 'Saved';
    status.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => status.classList.remove('show'), 1200);
  }

  focusInput.addEventListener('change', () => { settings.focusNewWindow = focusInput.checked; save(); });
  menuInput.addEventListener('change', () => { settings.contextMenu = menuInput.checked; save(); });

  buildArrangement();
  render();
})();
