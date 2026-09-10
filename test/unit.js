// Pure-function tests for the display maths and settings normalisation. No browser needed.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const noop = { addListener() {} };
global.chrome = {
  runtime: { onInstalled: noop, onStartup: noop, onMessage: noop, openOptionsPage() {} },
  storage: { onChanged: noop, sync: { get(_, cb) { cb({}); } } },
  contextMenus: { onClicked: noop }, action: { onClicked: noop }, system: { display: {} },
  windows: { onFocusChanged: noop, WINDOW_ID_NONE: -1 }, tabs: { onActivated: noop, onRemoved: noop },
};
global.importScripts = () => {};
const path = require('path'); const EXT = path.resolve(__dirname, '..', 'extension');
vm.runInThisContext(fs.readFileSync(path.join(EXT, 'shared.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'));

// MacBook (primary) + 4K to the left at negative coords + 1080p to the right.
const D = [
  { id: 'mbp', isPrimary: true,  bounds: { left: 0,     top: 0,    width: 1728, height: 1117 }, workArea: { left: 0,     top: 25,   width: 1728, height: 1092 } },
  { id: 'l4k', isPrimary: false, bounds: { left: -2560, top: -300, width: 2560, height: 1440 }, workArea: { left: -2560, top: -300, width: 2560, height: 1440 } },
  { id: 'r1080', isPrimary: false, bounds: { left: 1728, top: 0,   width: 1920, height: 1080 }, workArea: { left: 1728, top: 0,    width: 1920, height: 1080 } },
];
const win = (left, top, width, height) => ({ left, top, width, height });

assert.equal(displayFor(D, win(100, 100, 800, 600)).id, 'mbp', 'window on primary');
assert.equal(displayFor(D, win(-2000, 0, 800, 600)).id, 'l4k', 'window at negative coords');
assert.equal(displayFor(D, win(1500, 0, 1000, 600)).id, 'r1080', 'straddling window → majority display');
assert.equal(displayFor(D, win(9000, 9000, 100, 100)).id, 'r1080', 'offscreen window → nearest');

assert.equal(pickTarget(D, D[0], 'auto').id, 'r1080', 'auto from primary → nearest other');
assert.equal(pickTarget(D, D[1], 'auto').id, 'mbp', 'auto from left 4k → nearest other');
assert.equal(pickTarget(D, D[0], 'l4k').id, 'l4k', 'pinned display honoured');
assert.equal(pickTarget(D, D[1], 'l4k').id, 'mbp', 'pinned == current → falls back to auto');
assert.equal(pickTarget(D, D[0], 'gone').id, 'r1080', 'unknown pinned id → auto');
assert.equal(pickTarget([D[0]], D[0], 'auto'), null, 'single display → null');

const two = [D[0], D[1]];
assert.equal(pickTarget(two, two[0], 'auto').id, 'l4k', 'two displays: the other one');
assert.equal(pickTarget(two, two[1], 'auto').id, 'mbp', 'two displays: the other one (reverse)');

assert.equal(overlap({ left: 0, top: 0, width: 10, height: 10 }, { left: 20, top: 20, width: 5, height: 5 }), 0, 'no overlap');
assert.ok(closeEnough({ left: 1, top: -1, width: 801, height: 599 }, { left: 0, top: 0, width: 800, height: 600 }), 'tolerance');
assert.ok(!closeEnough({ left: 10, top: 0, width: 800, height: 600 }, { left: 0, top: 0, width: 800, height: 600 }), 'outside tolerance');
console.log('unit: all assertions passed');

// ---- Settings normalisation / migration ------------------------------------
let n = osNormalize(null);
assert.deepEqual(n.shortcut, { meta: true, alt: true, shift: false, ctrl: false, code: '', key: '' }, 'defaults');
n = osNormalize({ modifiers: { meta: false, alt: false, shift: true, ctrl: true } });
assert.deepEqual(n.shortcut, { meta: false, alt: false, shift: true, ctrl: true, code: '', key: '' }, 'legacy modifiers migrate');
n = osNormalize({ shortcut: { ctrl: true, code: 'KeyO', key: 'O' } });
assert.deepEqual(n.shortcut, { meta: false, alt: false, shift: false, ctrl: true, code: 'KeyO', key: 'O' }, 'partial shortcut filled');
n = osNormalize({ shortcut: { code: 42, key: null } });
assert.deepEqual(n.shortcut, { meta: false, alt: false, shift: false, ctrl: false, code: '', key: '' }, 'garbage types dropped');
assert.equal(osShortcutActive({ meta: false, alt: false, shift: false, ctrl: false, code: '' }), false, 'empty shortcut inactive');
assert.equal(osShortcutActive({ meta: false, alt: false, shift: false, ctrl: false, code: 'Backquote' }), true, 'bare key active');
assert.equal(osShortcutActive({ meta: false, alt: true, shift: false, ctrl: false, code: '' }), true, 'modifier-only active');
console.log('unit: normalisation assertions passed');
