// Tiny DevTools-protocol helper shared by the browser tests. No dependencies.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const TMP = path.join(__dirname, '.tmp');
const CHROME = process.env.CHROME_BIN || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url); const c = new CDP(ws);
      ws.onopen = () => res(c); ws.onerror = () => rej(new Error('ws error ' + url));
    });
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push(d.text + ' ' + (d.exception && d.exception.description || ''));
      }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}

// Launch a headless browser with the extension loaded. Returns { proc, port, targets, waitFor }.
function launch({ port, profile, extraArgs = [] }) {
  fs.mkdirSync(TMP, { recursive: true });
  const dir = path.join(TMP, profile);
  fs.rmSync(dir, { recursive: true, force: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--user-data-dir=${dir}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    ...extraArgs, 'about:blank',
  ], { stdio: 'ignore' });
  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json`)).json();
  async function waitFor(pred, label, tries = 60) {
    for (let i = 0; i < tries; i++) {
      try { const t = (await targets()).find(pred); if (t) return t; } catch (_) {}
      await sleep(250);
    }
    throw new Error(`timeout waiting for ${label}: ` + JSON.stringify(await targets().catch(() => [])));
  }
  return { proc, port, targets, waitFor };
}

function makeChecker() {
  const fails = [];
  const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails.push(msg); };
  const finish = () => { console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED'); process.exit(fails.length ? 1 : 0); };
  return { check, fails, finish };
}

module.exports = { CDP, launch, makeChecker, sleep, ROOT, EXT, TMP };
