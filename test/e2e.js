// End-to-end: loads the extension in headless Brave/Chromium and drives it over CDP.
// Chrome stable ≥137 ignores --load-extension; point CHROME_BIN at Brave, Chromium or Chrome for Testing.
const http = require('http');
const { CDP, launch, makeChecker, sleep } = require('./_cdp');

const WEB = 8765;
const BASE = `http://127.0.0.1:${WEB}`;
const { check, fails, finish } = makeChecker();

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/frame') {
      res.end(`<!doctype html><body style="margin:0"><a id="fl" href="${BASE}/framed" style="position:fixed;left:10px;top:10px;font-size:40px">framed</a></body>`);
      return;
    }
    res.end(`<!doctype html><body style="margin:0">
      <a id="l" href="${BASE}/target" style="position:fixed;left:20px;top:20px;font-size:40px">other</a>
      <a id="p" href="${BASE}/plain" style="position:fixed;left:20px;top:100px;font-size:40px">plain</a>
      <div id="host" style="position:fixed;left:20px;top:180px;font-size:40px"></div>
      <a id="k1" href="${BASE}/key1" style="position:fixed;left:300px;top:20px;font-size:40px">k1</a>
      <a id="k2" href="${BASE}/key2" style="position:fixed;left:300px;top:100px;font-size:40px">k2</a>
      <a id="k3" href="${BASE}/key3" style="position:fixed;left:300px;top:180px;font-size:40px">k3</a>
      <iframe id="f" src="/frame" style="position:fixed;left:20px;top:280px;width:400px;height:120px;border:1px solid #999"></iframe>
      <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<a id="s" href="${BASE}/shadow">shadow</a>'</script>
    </body>`);
  });
  await new Promise((r) => server.listen(WEB, r));

  const { proc, targets, waitFor } = launch({ port: 9333, profile: 'profile-e2e', extraArgs: ['--window-size=1200,800'] });
  const hasPage = async (url) => (await targets()).some((t) => t.type === 'page' && t.url === url);

  try {
    const sw = await waitFor((t) => t.type === 'service_worker' && t.url.includes('background.js'), 'service worker');
    const swc = await CDP.connect(sw.webSocketDebuggerUrl);

    const info = JSON.parse(await swc.eval(`(async () => {
      const d = await new Promise((r) => chrome.system.display.getInfo(r));
      return JSON.stringify({ displays: d.map((x) => ({ id: x.id, bounds: x.bounds, workArea: x.workArea, isPrimary: x.isPrimary })), settings: await osLoadSettings() });
    })()`));
    check(Array.isArray(info.displays) && info.displays.length >= 1, 'system.display.getInfo returns displays');
    check(info.settings.shortcut.meta && info.settings.shortcut.alt && !info.settings.shortcut.code, 'default shortcut is ⌥⌘, no key');

    await swc.eval(`chrome.windows.create({ url: '${BASE}/', focused: true, left: 0, top: 0, width: 600, height: 500 }).then(() => 'ok')`);
    const page = await waitFor((t) => t.type === 'page' && t.url.startsWith(BASE), 'test page');
    const pc = await CDP.connect(page.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    await sleep(800);

    const snapshot = () => swc.eval(`chrome.windows.getAll().then((ws) => JSON.stringify(ws.map((w) => ({ id: w.id, left: w.left, top: w.top, width: w.width, height: w.height, state: w.state, focused: w.focused }))))`).then(JSON.parse);
    const clickXY = async (x, y, modifiers) => {
      await pc.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await pc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
      await pc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
    };
    const clickAt = async (sel, modifiers) => {
      const box = JSON.parse(await pc.eval(`(() => { const el = ${sel}; const b = el.getBoundingClientRect(); return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); })()`));
      await clickXY(box.x, box.y, modifiers);
    };
    const newWindows = async (fn, wait = 1200) => {
      const before = await snapshot(); await fn(); await sleep(wait);
      const after = await snapshot();
      return { fresh: after.filter((w) => !before.some((b) => b.id === w.id)), before, after };
    };
    const ALT = 1, META = 4;
    const wa = info.displays[0].workArea;
    const fits = (w) => Math.abs(w.left - wa.left) <= 2 && Math.abs(w.top - wa.top) <= 2 && Math.abs(w.width - wa.width) <= 2 && Math.abs(w.height - wa.height) <= 2;

    // ---- Default ⌥⌘ shortcut -------------------------------------------------
    let r = await newWindows(() => clickAt(`document.getElementById('l')`, ALT | META), 1500);
    check(r.fresh.length === 1, 'exactly one new window created');
    check(await hasPage(`${BASE}/target`), 'new window holds the link URL');
    if (r.fresh[0]) check(fits(r.fresh[0]), `new window matches workArea ${JSON.stringify(wa)} (got ${JSON.stringify(r.fresh[0])})`);
    check((await pc.eval('location.href')) === `${BASE}/`, 'source page did not navigate');

    r = await newWindows(() => clickAt(`document.getElementById('host').shadowRoot.getElementById('s')`, ALT | META));
    check(r.fresh.length === 1 && await hasPage(`${BASE}/shadow`), 'shadow DOM link intercepted');

    r = await newWindows(() => clickAt(`document.getElementById('p')`, 0), 800);
    check(r.fresh.length === 0, 'plain click created no window');
    check((await pc.eval('location.href')) === `${BASE}/plain`, 'plain click navigated normally');

    // ---- Context menu path ---------------------------------------------------
    r = await newWindows(() => swc.eval(`openOnOtherScreen('${BASE}/menu', ${r.after[0].id}).then(() => 'ok')`), 1000);
    check(r.fresh.length === 1 && await hasPage(`${BASE}/menu`), 'openOnOtherScreen (context-menu path) works');

    // ---- Regular-key shortcut: bare O --------------------------------------
    await swc.eval(`chrome.storage.sync.set({ shortcut: { meta: false, alt: false, shift: false, ctrl: false, code: 'KeyO', key: 'O' } }).then(() => 'ok')`);
    await sleep(600);
    const live = JSON.parse(await swc.eval(`osLoadSettings().then(JSON.stringify)`));
    check(live.shortcut.code === 'KeyO' && !live.shortcut.meta, 'shortcut switched to bare O');

    r = await newWindows(() => clickAt(`document.getElementById('k1')`, 0), 900);
    check(r.fresh.length === 0 && (await pc.eval('location.href')) === `${BASE}/key1`, 'plain click with key NOT held navigates normally');

    await pc.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79 });
    await sleep(400);
    r = await newWindows(() => clickAt(`document.getElementById('k2')`, 0));
    check(r.fresh.length === 1 && await hasPage(`${BASE}/key2`), 'O held + click opens new window');
    check(r.fresh[0] && r.fresh[0].focused === true, 'deferred focus: new window ended up focused');
    check((await pc.eval('location.href')) === `${BASE}/key1`, 'source page did not navigate (held key)');

    // Link inside an iframe: key was pressed in the top frame, so this exercises the relay.
    const fpos = JSON.parse(await pc.eval(`(() => { const f = document.getElementById('f'); const fr = f.getBoundingClientRect(); const l = f.contentDocument.getElementById('fl').getBoundingClientRect(); return JSON.stringify({ x: fr.x + l.x + l.width / 2, y: fr.y + l.y + l.height / 2 }); })()`));
    r = await newWindows(() => clickXY(fpos.x, fpos.y, 0));
    check(r.fresh.length === 1 && await hasPage(`${BASE}/framed`), 'O held + click on link inside iframe opens new window (relay)');

    await pc.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79 });
    await sleep(400);
    r = await newWindows(() => clickAt(`document.getElementById('k3')`, 0), 900);
    check(r.fresh.length === 0 && (await pc.eval('location.href')) === `${BASE}/key3`, 'after keyup, plain click navigates normally again');

    // ---- Modifier + key: ⌥O -------------------------------------------------
    await swc.eval(`chrome.storage.sync.set({ shortcut: { meta: false, alt: true, shift: false, ctrl: false, code: 'KeyO', key: 'O' } }).then(() => 'ok')`);
    await sleep(600);
    await pc.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ø', code: 'KeyO', windowsVirtualKeyCode: 79, modifiers: ALT });
    await sleep(400);
    r = await newWindows(() => clickAt(`document.getElementById('l')`, ALT));
    check(r.fresh.length === 1 && await hasPage(`${BASE}/target`) && (await pc.eval('location.href')) === `${BASE}/key3`, '⌥O held + ⌥-click opens new window (code match despite ø)');
    r = await newWindows(() => clickAt(`document.getElementById('k2')`, ALT | META), 800);
    check(r.fresh.length === 0, '⌥O held + ⌥⌘-click ignored (exact modifier match)');
    await pc.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ø', code: 'KeyO', windowsVirtualKeyCode: 79, modifiers: ALT });
  } catch (e) {
    console.error('ERROR', e.message);
    fails.push(e.message);
  } finally {
    proc.kill('SIGKILL'); server.close();
    finish();
  }
})();
