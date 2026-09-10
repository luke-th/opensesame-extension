# OpenSesame

Chrome extension. Hold a shortcut (default **⌥⌘**, configurable to any modifiers plus an optional regular key like ⌃O or `) and click a link: it opens in a new window, fitted to the work area of your *other* monitor (the one you didn't click on).

## Install (unpacked)

1. Open `chrome://extensions` (or `brave://extensions`)
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick the `extension/` folder
4. Reload any tabs that were already open (content scripts only attach to pages loaded after install)

Click the toolbar icon (or **Details → Extension options**) to change the shortcut, target display, focus behaviour and right-click menu.

## How it works

- `content.js` listens for clicks in the capture phase on every page. If the configured modifiers match exactly (and the optional regular key is held) and the click landed on a link, it cancels the browser's default (new tab / download) and messages the service worker with the URL.
- Key events only reach the focused frame, so the worker keeps one browser-wide "held" flag: whichever frame sees keydown/keyup reports it, the worker broadcasts it to every frame, and clears it when Chrome itself loses focus. When a regular key is in the shortcut the new window is opened unfocused and focused once its content script has loaded (or after 1.5s), so a quick key release right after the click is still seen.
- `background.js` calls `chrome.system.display.getInfo()` for every monitor's bounds and work area, works out which display the source window is on (by overlap), picks another one, and calls `chrome.windows.create()` with that display's work area as the bounds. Because macOS sometimes clamps a new window back onto the source display, it re-checks and nudges with `chrome.windows.update()` a few times.
- The settings page draws your displays to scale from the same bounds (mac Displays-pane style, with a stand-in wallpaper). Click a screen to always target it, or leave it on Auto.
- A right-click **Open link on other screen** menu item does the same thing and works on pages where content scripts can't run (Chrome's PDF viewer, `chrome://` pages, the Web Store).

## Notes

- **Work area, not fullscreen.** The window fills the display minus menu bar and Dock. Chrome's API won't combine `maximized` with explicit bounds, so this is the "fit to screen" you get.
- **Three or more monitors.** Auto picks the nearest other display. Or pin a specific display in settings; if you click on that display itself it falls back to auto.
- **One monitor.** Still opens a new window, fitted to the current screen.
- **Exact modifier match.** ⌥⌘‑click fires, ⌥⌘⇧‑click doesn't. Lets you keep other combos free.
- **Regular key in the shortcut.** Useful when every modifier combo is taken (Brave, say). Record it in settings by pressing the keys. The key is matched by physical position (`KeyboardEvent.code`), so ⌥O still works even though macOS types ø. A bare letter with no modifier will also type into focused inputs, so prefer a modifier or a key like ` or F‑keys. The page must have focus for the key to be seen. If the extension ever thinks the key is stuck down (e.g. you released it while in the address bar), tap the key once.
- **Won't catch** links driven purely by JavaScript with no `href`, or `javascript:` / `mailto:` / `tel:` links.

## Layout

| Path | Purpose |
| --- | --- |
| `extension/manifest.json` | MV3 manifest. Permissions: `storage`, `system.display`, `contextMenus`. |
| `extension/shared.js` | Default settings + load/save helpers, shared by all contexts. |
| `extension/content.js` | Shortcut-click interception, held-key tracking. |
| `extension/background.js` | Service worker: display maths, window creation, context menu, key-state relay. |
| `extension/options.*` | Settings page: shortcut recorder, display arrangement, behaviour toggles. |
| `extension/icons/` | SVG source + rendered PNGs (`rsvg-convert -w N -h N icon.svg -o iconN.png`). |
| `test/` | Dependency-free tests (see below). |

## Tests

```bash
npm test
```

- `test/unit.js` — display selection maths and settings normalisation, plain Node.
- `test/e2e.js` — loads the extension in a headless Chromium and drives it over the DevTools protocol: modifier clicks, held-key clicks, iframes, shadow DOM, window placement.
- `test/opts.js` — the settings page, including a mocked 3-display arrangement. Screenshots land in `test/.tmp/`.

Chrome stable (137+) ignores `--load-extension`, so the browser tests default to Brave at `/Applications/Brave Browser.app`. Point `CHROME_BIN` at Chromium or Chrome for Testing otherwise.

## License

MIT. See [LICENSE](LICENSE).
