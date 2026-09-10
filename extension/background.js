importScripts('shared.js');

const MENU_ID = 'open-sesame-link';
// Browser-wide: is the shortcut's regular key currently held? Reported by whichever frame
// has focus, broadcast to all frames so links in other frames/tabs see it too.
let keyHeld = false;
// Tabs whose top-frame content script we are waiting to hear from (see openOnOtherScreen).
const readyWaiters = new Map();

// ---- Wiring -------------------------------------------------------------

chrome.runtime.onInstalled.addListener(syncContextMenu);
chrome.runtime.onStartup.addListener(syncContextMenu);
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') syncContextMenu();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;
  if (msg.type === 'open-other-screen' && typeof msg.url === 'string') {
    openOnOtherScreen(msg.url, sender.tab.windowId);
  } else if (msg.type === 'key-held') {
    setKeyHeld(!!msg.held);
  } else if (msg.type === 'key-state') {
    if (sender.frameId === 0) markReady(sender.tab.id);
    sendResponse({ held: keyHeld });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && info.linkUrl) {
    openOnOtherScreen(info.linkUrl, tab ? tab.windowId : undefined);
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Once the whole browser loses focus we can't see the keyup, so treat the key as released.
// Switching between Chrome windows is fine: the newly focused page reports key events itself.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE || !keyHeld) return;
  // Some platforms report NONE briefly between two Chrome windows; confirm before releasing.
  setTimeout(async () => {
    const w = await chrome.windows.getLastFocused().catch(() => null);
    if (!w || !w.focused) setKeyHeld(false);
  }, 200);
});

// ---- Key-state relay ----------------------------------------------------

function setKeyHeld(held) {
  if (keyHeld === held) return;
  keyHeld = held;
  chrome.tabs.query({}).then((tabs) => {
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'key-held', held }).catch(() => {});
  }).catch(() => {});
}

function markReady(tabId) {
  const resolve = readyWaiters.get(tabId);
  if (resolve) { readyWaiters.delete(tabId); resolve(); }
}

// Resolves once the tab's top-frame content script has checked in, or after `ms`.
function waitForReady(tabId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { readyWaiters.delete(tabId); resolve(); }, ms);
    readyWaiters.set(tabId, () => { clearTimeout(timer); resolve(); });
  });
}

// ---- Context menu -------------------------------------------------------

async function syncContextMenu() {
  const { contextMenu } = await osLoadSettings();
  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));
  if (contextMenu) {
    chrome.contextMenus.create({ id: MENU_ID, title: 'Open link on other screen', contexts: ['link'] });
  }
}

// ---- Core ---------------------------------------------------------------

async function openOnOtherScreen(url, sourceWindowId) {
  const settings = await osLoadSettings();
  const [displays, sourceWin] = await Promise.all([
    getDisplays(),
    sourceWindowId != null ? chrome.windows.get(sourceWindowId).catch(() => null) : null,
  ]);

  const active = displays.filter((d) => d.isEnabled !== false);
  if (!active.length) {
    await chrome.windows.create({ url });
    return;
  }

  const current = sourceWin
    ? displayFor(active, sourceWin)
    : (active.find((d) => d.isPrimary) || active[0]);
  // With a single display we still open a new window, fitted to that display.
  const target = pickTarget(active, current, settings.targetDisplay) || current;

  const wa = target.workArea || target.bounds;
  const bounds = { left: wa.left, top: wa.top, width: wa.width, height: wa.height };

  // With a regular key in the shortcut, focusing the new window immediately would send the
  // key-up to a page whose content script hasn't loaded yet, leaving the key stuck "held".
  // So open it unfocused, wait for its content script (or a short timeout), then focus.
  const deferFocus = settings.focusNewWindow && !!settings.shortcut.code;
  const win = await chrome.windows.create({
    url,
    type: 'normal',
    focused: settings.focusNewWindow && !deferFocus,
    ...bounds,
  });
  const tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  await Promise.all([
    settle(win.id, bounds),
    deferFocus && tabId != null ? waitForReady(tabId, 1500) : null,
  ]);
  if (deferFocus) await chrome.windows.update(win.id, { focused: true }).catch(() => {});
}

// Chrome (macOS especially) sometimes clamps a new window onto the source display
// or shaves a few px off. Nudge it until it lands where we asked.
async function settle(windowId, bounds) {
  for (let i = 0; i < 4; i++) {
    const w = await chrome.windows.get(windowId).catch(() => null);
    if (!w || closeEnough(w, bounds)) return;
    await chrome.windows.update(windowId, { state: 'normal', ...bounds }).catch(() => {});
    await sleep(120);
  }
}

// ---- Display maths ------------------------------------------------------

function getDisplays() {
  return new Promise((resolve) => chrome.system.display.getInfo((info) => resolve(info || [])));
}

function displayFor(displays, win) {
  const rect = { left: win.left || 0, top: win.top || 0, width: win.width || 0, height: win.height || 0 };
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const area = overlap(rect, d.bounds);
    if (area > bestArea) { best = d; bestArea = area; }
  }
  if (best) return best;
  // Window isn't on any display (shouldn't happen). Fall back to nearest centre.
  const c = centre(rect);
  return displays.slice().sort((a, b) => dist(centre(a.bounds), c) - dist(centre(b.bounds), c))[0];
}

function pickTarget(displays, current, preferredId) {
  const others = displays.filter((d) => d.id !== current.id);
  if (!others.length) return null;
  if (preferredId && preferredId !== 'auto') {
    const pref = others.find((d) => d.id === preferredId);
    if (pref) return pref;
  }
  // 3+ monitors, no preference: nearest other display.
  const c = centre(current.bounds);
  return others.slice().sort((a, b) => dist(centre(a.bounds), c) - dist(centre(b.bounds), c))[0];
}

function overlap(a, b) {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function centre(r) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function dist(p, q) {
  return Math.hypot(p.x - q.x, p.y - q.y);
}

function closeEnough(w, b, tol = 2) {
  return Math.abs(w.left - b.left) <= tol
    && Math.abs(w.top - b.top) <= tol
    && Math.abs(w.width - b.width) <= tol
    && Math.abs(w.height - b.height) <= tol;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
