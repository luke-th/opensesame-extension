// Shared by content script, service worker and options page.
// Globals are prefixed `os` to avoid clashing with anything else in scope.

const OS_DEFAULTS = {
  // Keys held while clicking a link. `code` is an optional regular key (KeyboardEvent.code,
  // e.g. "KeyO", "Backquote", "F9"); `key` is its human label for the options page.
  shortcut: { meta: true, alt: true, shift: false, ctrl: false, code: '', key: '' },
  // Give the new window focus, or leave focus where you are.
  focusNewWindow: true,
  // Add "Open link on other screen" to the right-click menu.
  contextMenu: true,
  // 'auto' = whichever display isn't the one you clicked on. Otherwise a display id.
  targetDisplay: 'auto',
};

function osNormalize(stored) {
  const s = stored || {};
  // `modifiers` is the pre-0.2 shape; carry it over.
  const raw = s.shortcut || s.modifiers;
  const shortcut = raw
    ? {
        meta: !!raw.meta, alt: !!raw.alt, shift: !!raw.shift, ctrl: !!raw.ctrl,
        code: typeof raw.code === 'string' ? raw.code : '',
        key: typeof raw.key === 'string' ? raw.key : '',
      }
    : { ...OS_DEFAULTS.shortcut };
  return {
    shortcut,
    focusNewWindow: typeof s.focusNewWindow === 'boolean' ? s.focusNewWindow : OS_DEFAULTS.focusNewWindow,
    contextMenu: typeof s.contextMenu === 'boolean' ? s.contextMenu : OS_DEFAULTS.contextMenu,
    targetDisplay: typeof s.targetDisplay === 'string' ? s.targetDisplay : OS_DEFAULTS.targetDisplay,
  };
}

// A shortcut with nothing in it can never fire.
function osShortcutActive(sc) {
  return !!(sc.meta || sc.alt || sc.shift || sc.ctrl || sc.code);
}

function osLoadSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(null, (items) => resolve(osNormalize(items)));
    } catch (_) {
      resolve(osNormalize(null));
    }
  });
}

function osSaveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(osNormalize(settings), () => chrome.storage.sync.remove('modifiers', resolve));
  });
}
