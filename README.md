# Zotero Tray

A Zotero 7+ plugin that keeps Zotero in the system tray on Linux, on both X11
and Wayland:

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
points and protocols are used: a bootstrapped Zotero plugin, the
StatusNotifierItem tray protocol, and standard window activation
(xdg-activation on Wayland, EWMH on X11). It should therefore work with any
desktop whose tray supports StatusNotifierItem, but it has only been tested on
KDE Plasma with KWin.

### KDE Plasma / KWin specifics

Two KDE-specific mechanisms are used when available, to make bringing the
window forward more reliable:

- Plasma's tray passes an xdg-activation token for each click through
  `ProvideXdgActivationToken`, a KDE extension to StatusNotifierItem. Other tray
  hosts may not; then on Wayland the window is focused with the KWin script
  below, or, without KWin, Gecko's own focus request, which the compositor may
  refuse (the window then shows up without focus).
- On Wayland, when no token arrived and KWin is running, a one-shot KWin script
  is loaded at runtime through KWin's scripting D-Bus API to activate the
  window. No KWin settings need to change.

## Requirements

- Zotero 7 or newer (tested with 10.0.6 / Gecko 140 ESR)
- `python3` with PyGObject and the Gio typelib (`python-gobject` on Arch).
  The GdkPixbuf typelib is optional; it provides the bundled PNG icon as a
  fallback when the `zotero` icon is not in the icon theme.
- A tray that supports StatusNotifierItem, i.e. a StatusNotifierWatcher
  (`org.kde.StatusNotifierWatcher` or `org.freedesktop.StatusNotifierWatcher`)
  with a registered host. KDE Plasma has one built in; on other desktops this
  depends on the panel. Without one, closing the window quits Zotero as usual.

## Build and install

```bash
./build.sh
```

In Zotero: Tools → Plugins → gear menu → Install Plugin From File… →
`zotero-tray.xpi`.

### Releases and updates

Zotero checks the plugin's `update_url`, which points at
[`updates.json`](updates.json) on the `master` branch. To publish version X:

1. Set `"version"` in `zotero-tray/manifest.json` to X and run `./build.sh`.
2. Add an entry for X to `updates.json`, with `update_link` set to
   `https://github.com/yuyichao/zotero-tray/releases/download/vX/zotero-tray.xpi`.
3. Push, and create a GitHub release with tag `vX` that has the built
   `zotero-tray.xpi` attached.

## How it works

```
Zotero process                         tray helper (python3)            desktop
┌────────────────────────┐ JSON lines ┌──────────────────────────┐ D-Bus ┌───────────────────┐
│ zotero-tray.js         │◄──stdout───│ org.kde.StatusNotifier-  │◄─────►│ system tray       │
│  close → hide window   │───stdin───►│ Item + dbusmenu          │       │ (SNI host)        │
│  show/activate/quit    │            │ KWin raise script loader │──────►│ KWin /Scripting   │
└────────────────────────┘            └──────────────────────────┘       │ (KWin only)       │
                                                                          └───────────────────┘
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
- Activating the window: the click went to the tray, not to Zotero, so
  Gecko's own focus request can be refused by focus-stealing prevention. After
  the shown window has painted, the plugin activates it the way a task bar
  would, in this order:
  1. Wayland with a token: a tray host that supports it (Plasma does) calls
     `ProvideXdgActivationToken` on the item right before `Activate` and
     before a menu click. The helper passes the token along, and the plugin hands it to GTK
     (`gdk_wayland_display_set_startup_notification_id` + `gdk_window_focus`
     on Gecko's toplevel, via js-ctypes), which calls
     `xdg_activation_v1.activate`.
  2. X11: an EWMH `_NET_ACTIVE_WINDOW` client message with the pager source
     indication, sent for the window's XID.
  3. Wayland without a token, on KWin: a one-shot KWin script, loaded
     through KWin's scripting D-Bus API, activates the window (matched by pid
     and title).
  4. Otherwise Gecko's own `window.focus()`.

### Fail-safes

The window is only hidden on close while the helper is running **and** a tray
host is registered with the StatusNotifierWatcher. Otherwise closing the
window quits Zotero as usual, so you can never end up with an invisible
Zotero:

- python3, PyGObject or the tray are unavailable → normal close behavior.
- The helper only reports the tray as ready once the item actually shows up
  in the watcher's `RegisteredStatusNotifierItems`. Until then it keeps
  re-registering, and it also re-registers if the watcher drops the item later.
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
activation fallback (for debugging).

## Tested

All testing was done on KDE Plasma / KWin.

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

On a real Plasma 6.8 Wayland session, with the KWin fallback turned off: the
tray icon and menu render; Plasma provided an activation token for every left
click and for the menu's Show item; using it, the window came forward with
keyboard focus over another app, both when hidden and when visible behind
another window; a left click on the focused window hides it. Middle click was
not tried. EWMH activation on X11 was only tried under Xwayland in the nested
KWin, where it brought the window forward with the KWin fallback off.

Not tested: a native KWin X11 session, and any desktop other than KDE Plasma
(other tray hosts, compositors and window managers).

## Known limitations

- On Wayland the compositor places the re-shown window (KWin centers it); the
  size and maximized state are kept, the position is not.
- Minimizing is not intercepted (Wayland gives clients no minimize
  notification); only closing goes to the tray.
- Menu labels are English.
