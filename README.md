# Zotero Tray

A Zotero 7+ plugin that keeps Zotero in the system tray on KDE Plasma, on both
X11 and Wayland:

- A tray icon is shown for as long as Zotero is running. It uses the
  StatusNotifierItem protocol (`org.kde.StatusNotifierItem` plus a
  `com.canonical.dbusmenu` menu), not the XEmbed tray.
- Closing the main window (Zotero's own titlebar ✕, the window manager's
  close button or Alt+F4, or Ctrl+W / File → Close on the last tab) hides the
  window. The window is unmapped, so it is not in
  the task bar and the window manager has no window for it. Zotero keeps
  running.
- Left-clicking the icon shows the window and focuses it, or hides it if it is
  already focused. Middle click always shows it. The menu has Show/Hide Zotero
  and Quit Zotero.
- Running `zotero` again (e.g. from the launcher) while the window is hidden
  brings it back.

No Zotero files are patched and nothing is preloaded. Only standard extension
points are used: a bootstrapped Zotero plugin, and a KWin script that is loaded
at runtime through KWin's scripting D-Bus API. No KWin settings need to change.

## Requirements

- Zotero 7 or newer (tested with 10.0.6 / Gecko 140 ESR)
- `python3` with PyGObject and the Gio typelib (`python-gobject` on Arch).
  The GdkPixbuf typelib is optional; it provides the bundled PNG icon as a
  fallback when the `zotero` icon is not in the icon theme.

## Build and install

```bash
./build.sh
```

In Zotero: Tools → Plugins → gear menu → Install Plugin From File… →
`zotero-tray.xpi`.

## How it works

```
Zotero process                         tray helper (python3)            Plasma
┌────────────────────────┐ JSON lines ┌──────────────────────────┐ D-Bus ┌──────────────────┐
│ zotero-tray.js         │◄──stdout───│ org.kde.StatusNotifier-  │◄─────►│ system tray       │
│  close → hide window   │───stdin───►│ Item + dbusmenu          │       │ (SNI host)        │
│  show/raise/quit       │            │ KWin raise script loader │──────►│ KWin /Scripting   │
└────────────────────────┘            └──────────────────────────┘       └──────────────────┘
```

- `zotero-tray.js` (runs inside Zotero): hides and shows the main window
  through `nsIBaseWindow.visibility`, so tabs and state are kept. It cancels
  the window's `close` event (window-manager close requests) and
  `DOMWindowClose` (every `window.close()` call, which is what Zotero's own
  titlebar button and Ctrl+W use). It also registers a command-line handler
  (for relaunching `zotero`). It also wraps
  `Zotero.Utilities.Internal.activate` so code that brings Zotero to the front
  shows a hidden window first.
- `helper/zotero-tray-helper.py` is started with `Subprocess` and exits when its
  stdin closes. The icon therefore disappears exactly when Zotero exits, even if
  Zotero crashes. The helper is extracted into the profile directory at
  startup.
- After showing the window, the helper loads a one-shot KWin script that
  activates the window (matched by pid and title). This avoids focus-stealing
  prevention refusing focus, since the tray click went to plasmashell, not
  Zotero. If KWin is not running, this step is skipped and only Gecko's own
  `window.focus()` is used.

### Fail-safes

The window is only hidden on close while the helper is running **and** a tray
host is registered with the StatusNotifierWatcher. Otherwise closing the
window quits Zotero as usual, so you can never end up with an invisible
Zotero:

- python3, PyGObject or the tray are unavailable → normal close behavior.
- The helper dies while the window is hidden → the window is shown again and
  the helper is restarted (up to 5 failures in a row).
- The tray host disappears while the window is hidden (e.g. plasmashell
  crashes) → if it is not back within 10 s, the window is shown again.
- Disabling or uninstalling the plugin shows any hidden window.

## Preferences

Set in the Config Editor (Settings → Advanced):

| Pref | Default | Meaning |
|---|---|---|
| `extensions.zotero-tray.closeToTray` | `true` | Hide instead of close. With `false`, the icon stays but closing quits. |
| `extensions.zotero-tray.iconName` | `zotero` | Icon theme name, e.g. `zotero-symbolic` for a monochrome icon. |
| `extensions.zotero-tray.python` | `python3` | Interpreter for the helper (name looked up in `PATH`, or an absolute path). |

Setting `ZOTERO_TRAY_NO_KWIN=1` in Zotero's environment turns off the KWin
activation script (for debugging).

## Tested

In a nested, headless KWin 6.8 (Wayland, plus Xwayland for the X11 backend)
with a stand-in StatusNotifierWatcher, and Zotero 10.0.6 on both
`MOZ_ENABLE_WAYLAND=1` and `GDK_BACKEND=x11`:

- Zotero's titlebar ✕, `cmd_close` (Ctrl+W) and a window-manager close all
  hide the window; KWin and `_NET_CLIENT_LIST` no longer list it
- tray click shows and focuses the window even while another app is active,
  and hides it on a second click; the menu toggles and quits
- relaunching `zotero` while hidden shows the window
- maximized state is kept; on X11 the position is kept too
- helper crash, tray-host loss and "no tray host at all" fall back as
  described above
- installing from the packed `.xpi`

On a real Plasma 6.8 Wayland session: the tray icon and menu render, left
click hides a focused window and shows and focuses it from another app (Plasma
sends `ProvideXdgActivationToken` before `Activate`, and the KWin script does
the activation), and the menu Show/Hide works.

Not tested: a native KWin X11 session.

## Known limitations

- On Wayland the compositor places the re-shown window (KWin centers it); the
  size and maximized state are kept, the position is not.
- Minimizing is not intercepted (Wayland gives clients no minimize
  notification); only closing goes to the tray.
- Menu labels are English.
