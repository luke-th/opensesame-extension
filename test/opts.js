// Options page: recorder, target-screen arrangement, persistence. Also writes screenshots to test/.tmp.
const fs = require('fs');
const path = require('path');
const { CDP, launch, makeChecker, sleep, TMP } = require('./_cdp');

const { check, fails, finish } = makeChecker();

// Fake a 3-display setup (MacBook + 4K on the left at negative coords + 1080p on the right)
// so the arrangement view can be exercised on a single-display machine.
const MOCK_DISPLAYS = `(() => {
  const fake = [
    { id: 'mbp', name: 'Built-in Retina Display', isPrimary: true, isEnabled: true, bounds: { left: 0, top: 0, width: 1728, height: 1117 }, workArea: { left: 0, top: 25, width: 1728, height: 1092 } },
    { id: 'l4k', name: 'DELL U2720Q', isPrimary: false, isEnabled: true, bounds: { left: -2560, top: -300, width: 2560, height: 1440 }, workArea: { left: -2560, top: -300, width: 2560, height: 1440 } },
    { id: 'r1080', name: 'LG HDR 4K', isPrimary: false, isEnabled: true, bounds: { left: 1728, top: 200, width: 1920, height: 1080 }, workArea: { left: 1728, top: 200, width: 1920, height: 1080 } },
  ];
  try { chrome.system.display.getInfo = (cb) => { cb(fake); }; } catch (e) {}
  try { chrome.windows.getCurrent = () => Promise.resolve({ id: 42, left: 200, top: 100, width: 900, height: 700 }); } catch (e) {}
  // Capture the bounds listener so the test can simulate dragging the window to another display.
  window.__boundsListeners = [];
  try { chrome.windows.onBoundsChanged = { addListener: (fn) => window.__boundsListeners.push(fn) }; } catch (e) {}
})();`;

(async () => {
  const { proc, targets, waitFor } = launch({ port: 9334, profile: 'profile-opts', extraArgs: ['--window-size=900,1000'] });
  try {
    const sw = await waitFor((t) => t.type === 'service_worker' && t.url.includes('background.js'), 'sw');
    const swc = await CDP.connect(sw.webSocketDebuggerUrl);
    // Seed legacy-shaped settings to prove migration in the UI.
    await swc.eval(`chrome.storage.sync.set({ modifiers: { meta: true, alt: true, shift: false, ctrl: false } }).then(() => 'ok')`);
    const extId = new URL(sw.url).host;
    const OPTIONS_URL = `chrome-extension://${extId}/options.html`;
    await swc.eval(`chrome.tabs.create({ url: '${OPTIONS_URL}' }).then(() => 'ok')`);
    const pg = await waitFor((t) => t.type === 'page' && t.url === OPTIONS_URL, 'options page');
    const pc = await CDP.connect(pg.webSocketDebuggerUrl);
    await pc.send('Runtime.enable'); await pc.send('Page.enable'); await sleep(900);

    const text = (sel) => pc.eval(`document.querySelector('${sel}').textContent`);
    const hidden = (sel) => pc.eval(`document.querySelector('${sel}').hidden`);
    const attr = (sel, a) => pc.eval(`document.querySelector('${sel}').getAttribute('${a}')`);
    const count = (sel) => pc.eval(`document.querySelectorAll('${sel}').length`);
    const key = (type, key, code, modifiers = 0) => pc.send('Input.dispatchKeyEvent', { type, key, code, modifiers });
    const saved = async () => JSON.parse(await swc.eval(`osLoadSettings().then(JSON.stringify)`));

    check((await count('.screen')) === 1, 'arrangement shows the one display');
    check((await attr('#autoBtn', 'aria-pressed')) === 'true', 'Auto selected by default');
    check((await text('#modeText')).startsWith('Only one display'), 'single-display note shown');
    check((await pc.eval(`document.querySelector('.logo').naturalWidth`)) > 0, 'header icon loaded');
    check((await text('#shortcutDisplay')) === '⌥⌘ + click', 'legacy modifiers migrated, shows ⌥⌘ + click');
    check((await hidden('#warn')) === true, 'no warning for default combo');
    check((await hidden('#clearKeyBtn')) === true, 'Remove key hidden when no key');

    // Record ⌥Q
    await pc.eval(`document.getElementById('recordBtn').click()`); await sleep(150);
    check((await text('#shortcutDisplay')) === 'Press keys…' && (await text('#recordBtn')) === 'Cancel', 'recording state shown');
    await key('keyDown', 'Alt', 'AltLeft', 1); await sleep(100);
    check((await text('#shortcutDisplay')) === '⌥ …', 'pending modifiers previewed while held');
    await key('keyDown', 'œ', 'KeyQ', 1); await sleep(300);
    check((await text('#shortcutDisplay')) === '⌥Q + click', 'recorded ⌥Q (label from code, not œ)');
    let s = await saved();
    check(s.shortcut.alt && !s.shortcut.meta && s.shortcut.code === 'KeyQ' && s.shortcut.key === 'Q', 'saved ⌥Q to storage');
    check(s.modifiers === undefined, 'legacy modifiers key removed on save');
    check((await hidden('#warn')) === true, 'no warning for ⌥Q');
    check((await hidden('#clearKeyBtn')) === false, 'Remove key visible');
    await key('keyUp', 'Alt', 'AltLeft', 0); await sleep(100);

    // Remove key → ⌥ only → download warning
    await pc.eval(`document.getElementById('clearKeyBtn').click()`); await sleep(300);
    check((await text('#shortcutDisplay')) === '⌥ + click', 'key removed → ⌥ + click');
    check((await text('#warn')).includes('download'), 'Option-only warning shown');

    // Record modifiers-only ⌥⌘ via keyup
    await pc.eval(`document.getElementById('recordBtn').click()`); await sleep(100);
    await key('keyDown', 'Meta', 'MetaLeft', 4); await key('keyDown', 'Alt', 'AltLeft', 5); await sleep(100);
    await key('keyUp', 'Alt', 'AltLeft', 4); await sleep(300);
    check((await text('#shortcutDisplay')) === '⌥⌘ + click', 'modifiers-only recorded on release');
    await key('keyUp', 'Meta', 'MetaLeft', 0);
    s = await saved(); check(s.shortcut.meta && s.shortcut.alt && !s.shortcut.code, 'saved ⌥⌘, no key');

    // Bare letter → typing warning
    await pc.eval(`document.getElementById('recordBtn').click()`); await sleep(100);
    await key('keyDown', 'o', 'KeyO', 0); await sleep(300);
    check((await text('#shortcutDisplay')) === 'O + click', 'bare O recorded');
    check((await text('#warn')).includes('types it'), 'bare-letter typing warning shown');
    await key('keyUp', 'o', 'KeyO', 0);

    // Backquote label, Escape cancels
    await pc.eval(`document.getElementById('recordBtn').click()`); await sleep(100);
    await key('keyDown', '`', 'Backquote', 0); await sleep(300);
    check((await text('#shortcutDisplay')) === '` + click', 'backquote labelled `');
    await key('keyUp', '`', 'Backquote', 0);
    await pc.eval(`document.getElementById('recordBtn').click()`); await sleep(100);
    await key('keyDown', 'Escape', 'Escape', 0); await sleep(200);
    check((await text('#shortcutDisplay')) === '` + click' && (await text('#recordBtn')) === 'Change', 'Escape cancels recording, keeps previous');

    // Target screen: click pins, click again unpins, Auto button unpins
    const screenId = await pc.eval(`document.querySelector('.screen').dataset.id`);
    await pc.eval(`document.querySelector('.screen').click()`); await sleep(300);
    s = await saved(); check(s.targetDisplay === screenId, 'clicking a screen pins it');
    check((await attr('.screen', 'aria-checked')) === 'true' && (await attr('#autoBtn', 'aria-pressed')) === 'false', 'pinned state reflected in UI');
    await pc.eval(`document.getElementById('autoBtn').click()`); await sleep(300);
    s = await saved(); check(s.targetDisplay === 'auto', 'Auto button restores auto');
    await pc.eval(`document.querySelector('.screen').click()`); await sleep(200);
    await pc.eval(`document.querySelector('.screen').click()`); await sleep(300);
    s = await saved(); check(s.targetDisplay === 'auto', 'clicking the pinned screen again unpins');

    // Context menu toggle still works
    await pc.eval(`document.getElementById('contextMenu').click()`); await sleep(400);
    const menuState = await swc.eval(`new Promise(r => chrome.contextMenus.create({id:'open-sesame-link', title:'x', contexts:['link']}, () => { const e = chrome.runtime.lastError; if (!e) chrome.contextMenus.remove('open-sesame-link', () => r('absent')); else r('present'); }))`);
    check(menuState === 'absent', 'context menu removed when toggled off');
    await pc.eval(`document.getElementById('contextMenu').click()`); await sleep(200);

    // Record ⌃⌥O and screenshot
    await pc.eval(`document.getElementById('recordBtn').click()`); await sleep(100);
    await key('keyDown', 'Control', 'ControlLeft', 2); await key('keyDown', 'Alt', 'AltLeft', 3); await key('keyDown', 'ø', 'KeyO', 3); await sleep(300);
    await key('keyUp', 'ø', 'KeyO', 3); await key('keyUp', 'Alt', 'AltLeft', 2); await key('keyUp', 'Control', 'ControlLeft', 0); await sleep(200);
    check((await text('#shortcutDisplay')) === '⌃⌥O + click', 'recorded ⌃⌥O');
    let shot = await pc.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(TMP, 'options.png'), Buffer.from(shot.data, 'base64'));
    check(pc.errors.length === 0, 'no uncaught exceptions on options page' + (pc.errors.length ? ': ' + pc.errors.join(' | ') : ''));

    // ---- Mocked 3-display arrangement ------------------------------------------
    const before = new Set((await targets()).map((t) => t.id));
    await swc.eval(`chrome.tabs.create({ url: 'about:blank' }).then(() => 'ok')`);
    const blank = await waitFor((t) => t.type === 'page' && !before.has(t.id), 'blank tab');
    const p2 = await CDP.connect(blank.webSocketDebuggerUrl);
    await p2.send('Runtime.enable'); await p2.send('Page.enable');
    await p2.send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_DISPLAYS });
    await p2.send('Page.navigate', { url: OPTIONS_URL });
    await sleep(1200);
    const readScreens = async (c) => JSON.parse(await c.eval(`JSON.stringify([...document.querySelectorAll('.screen')].map((el) => ({ id: el.dataset.id, left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: parseFloat(el.style.width), height: parseFloat(el.style.height), primary: el.classList.contains('is-primary'), here: el.classList.contains('here'), name: el.querySelector('.screen-name').textContent, size: el.querySelector('.screen-size').textContent })))`));
    const screens = await readScreens(p2);
    check(screens.length === 3, `mocked arrangement renders 3 screens (got ${screens.length})`);
    const byId = Object.fromEntries(screens.map((x) => [x.id, x]));
    if (screens.length === 3) {
      check(byId.l4k.left < byId.mbp.left && byId.mbp.left < byId.r1080.left, 'screens ordered left→right by bounds');
      check(byId.l4k.top < byId.mbp.top && byId.r1080.top > byId.mbp.top, 'vertical offsets preserved');
      check(Math.abs((byId.l4k.width + 8) / (byId.mbp.width + 8) - 2560 / 1728) < 0.02, 'screens drawn to scale (gap-adjusted)');
      check(byId.mbp.primary && !byId.l4k.primary, 'primary flagged');
      check(byId.mbp.here && !byId.l4k.here, 'display containing this window flagged');
      const gapLR = byId.mbp.left - (byId.l4k.left + byId.l4k.width);
      check(gapLR >= 7 && gapLR <= 9, `adjacent screens separated by a gap (${gapLR.toFixed(1)}px)`);
      check((await p2.eval(`getComputedStyle(document.querySelector('.screen'), '::before').content`)) === 'none', 'no fake menu-bar strip');
      // Simulate dragging the settings window onto the 4K display.
      await p2.eval(`window.__boundsListeners.forEach((fn) => fn({ id: 42, left: -2000, top: 0, width: 900, height: 700 }))`); await sleep(150);
      const moved = Object.fromEntries((await readScreens(p2)).map((x) => [x.id, x]));
      check(moved.l4k.here && !moved.mbp.here, '"This window" follows the window when it moves displays');
      await p2.eval(`window.__boundsListeners.forEach((fn) => fn({ id: 999, left: 3000, top: 300, width: 900, height: 700 }))`); await sleep(150);
      const other = Object.fromEntries((await readScreens(p2)).map((x) => [x.id, x]));
      check(other.l4k.here, 'bounds changes of other windows are ignored');
      check(byId.l4k.name === 'DELL U2720Q', 'display names shown');
      check(byId.l4k.size === '2560 × 1440' && byId.mbp.size === '1728 × 1117', 'display dimensions shown');
    }
    check((await p2.eval(`document.getElementById('modeText').textContent`)).startsWith('Opens on whichever'), 'multi-display auto text');
    await p2.eval(`document.querySelector('.screen[data-id="l4k"]').click()`); await sleep(300);
    check((await p2.eval(`document.getElementById('modeText').textContent`)) === 'Always opens on DELL U2720Q. Click it again, or Auto, to go back.', 'pinned text names the display');
    shot = await p2.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(TMP, 'options-3displays.png'), Buffer.from(shot.data, 'base64'));
    check(p2.errors.length === 0, 'no uncaught exceptions with mocked displays' + (p2.errors.length ? ': ' + p2.errors.join(' | ') : ''));
  } catch (e) { console.error('ERROR', e.message); fails.push(e.message); }
  finally { proc.kill('SIGKILL'); finish(); }
})();
