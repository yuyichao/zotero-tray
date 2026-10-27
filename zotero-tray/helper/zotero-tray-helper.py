#!/usr/bin/env python3
# Tray helper for the Zotero Tray plugin.
#
# Exports a StatusNotifierItem (org.kde.StatusNotifierItem) with a
# com.canonical.dbusmenu context menu on the session bus and talks to the
# Zotero plugin with JSON lines over stdin/stdout. The helper exits as soon as
# stdin is closed, so the tray icon lives exactly as long as Zotero does.
#
# Zotero -> helper (stdin):
#   {"cmd": "config", "title": ..., "iconName": ..., "iconFiles": [...],
#    "labels": {"show": ..., "hide": ..., "quit": ...}}
#   {"cmd": "visible", "value": true|false}
#   {"cmd": "raise", "pid": N, "caption": "..."}
# helper -> Zotero (stdout):
#   {"event": "status", "ready": bool, ...}
#   {"event": "activate"} | {"event": "show"} | {"event": "hide"}
#   {"event": "quit"}

import json
import os
import sys
import tempfile

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

try:
    gi.require_version("GLibUnix", "2.0")
    from gi.repository import GLibUnix
    fd_add_full = GLibUnix.fd_add_full
except (ImportError, ValueError):
    fd_add_full = GLib.unix_fd_add_full

try:
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GdkPixbuf
except (ImportError, ValueError):
    GdkPixbuf = None

SNI_PATH = "/StatusNotifierItem"
MENU_PATH = "/MenuBar"
WATCHER_NAMES = ("org.kde.StatusNotifierWatcher",
                 "org.freedesktop.StatusNotifierWatcher")
WATCHER_PATH = "/StatusNotifierWatcher"

ITEM_TOGGLE = 1
ITEM_SEP = 2
ITEM_QUIT = 3

INTROSPECTION = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionMovieName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <method name="ProvideXdgActivationToken"><arg name="token" type="s" direction="in"/></method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewAttentionIcon"/>
    <signal name="NewOverlayIcon"/>
    <signal name="NewMenu"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
  </interface>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg type="i" name="parentId" direction="in"/>
      <arg type="i" name="recursionDepth" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="u" name="revision" direction="out"/>
      <arg type="(ia{sv}av)" name="layout" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg type="ai" name="ids" direction="in"/>
      <arg type="as" name="propertyNames" direction="in"/>
      <arg type="a(ia{sv})" name="properties" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="name" direction="in"/>
      <arg type="v" name="value" direction="out"/>
    </method>
    <method name="Event">
      <arg type="i" name="id" direction="in"/>
      <arg type="s" name="eventId" direction="in"/>
      <arg type="v" name="data" direction="in"/>
      <arg type="u" name="timestamp" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg type="a(isvu)" name="events" direction="in"/>
      <arg type="ai" name="idErrors" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg type="i" name="id" direction="in"/>
      <arg type="b" name="needUpdate" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg type="ai" name="ids" direction="in"/>
      <arg type="ai" name="updatesNeeded" direction="out"/>
      <arg type="ai" name="idErrors" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated">
      <arg type="a(ia{sv})" name="updatedProps"/>
      <arg type="a(ias)" name="removedProps"/>
    </signal>
    <signal name="LayoutUpdated">
      <arg type="u" name="revision"/>
      <arg type="i" name="parent"/>
    </signal>
    <signal name="ItemActivationRequested">
      <arg type="i" name="id"/>
      <arg type="u" name="timestamp"/>
    </signal>
  </interface>
</node>
"""

# Activates the (just re-mapped) Zotero main window. Loaded on demand through
# KWin's scripting D-Bus API, so no KWin configuration is needed.
KWIN_RAISE_SCRIPT = """
(function () {
    const pid = %(pid)d;
    const caption = %(caption)s;
    function captionMatches(w) {
        return w.caption === caption || w.caption.startsWith(caption + " <");
    }
    function activate(w) {
        if (w.minimized)
            w.minimized = false;
        workspace.activeWindow = w;
    }
    for (const w of workspace.windowList()) {
        if (w.pid === pid && w.normalWindow && captionMatches(w)) {
            activate(w);
            return;
        }
    }
    // The window may not be mapped yet; catch it when it shows up.
    let done = false;
    const onAdded = function (w) {
        if (done || w.pid !== pid || !w.normalWindow)
            return;
        done = true;
        workspace.windowAdded.disconnect(onAdded);
        activate(w);
    };
    workspace.windowAdded.connect(onAdded);
})();
"""


def log(*args):
    print("zotero-tray-helper:", *args, file=sys.stderr, flush=True)


def send(**msg):
    try:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        loop.quit()


def load_pixmaps(paths):
    """Return a list of (w, h, ARGB32 big-endian bytes) for the icon files."""
    if GdkPixbuf is None:
        return []
    pixmaps = []
    for path in paths:
        try:
            pb = GdkPixbuf.Pixbuf.new_from_file(path)
        except GLib.Error:
            continue
        if not pb.get_has_alpha():
            pb = pb.add_alpha(False, 0, 0, 0)
        w, h, stride = pb.get_width(), pb.get_height(), pb.get_rowstride()
        src = pb.get_pixels()
        out = bytearray(w * h * 4)
        for y in range(h):
            row = src[y * stride:y * stride + w * 4]
            o = y * w * 4
            out[o + 0:o + w * 4:4] = row[3::4]
            out[o + 1:o + w * 4:4] = row[0::4]
            out[o + 2:o + w * 4:4] = row[1::4]
            out[o + 3:o + w * 4:4] = row[2::4]
        pixmaps.append((w, h, bytes(out)))
    return pixmaps


class Tray:
    def __init__(self, bus):
        self.bus = bus
        self.title = "Zotero"
        self.icon_name = "zotero"
        self.pixmaps = []
        self.labels = {"show": "Show Zotero", "hide": "Hide Zotero",
                       "quit": "Quit Zotero"}
        self.window_visible = True
        self.menu_revision = 1
        self.registered = False
        self.host = False
        self.kwin = False
        self.watcher = None
        self.watcher_subs = []
        self.last_status = None
        self.raise_timer = 0
        self.raise_file = None

        node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
        for iface in node.interfaces:
            bus.register_object(iface.name == "com.canonical.dbusmenu"
                                and MENU_PATH or SNI_PATH,
                                iface, self.on_method_call,
                                self.on_get_property, None)
        self.bus_name = "org.kde.StatusNotifierItem-%d-1" % os.getpid()
        Gio.bus_own_name_on_connection(bus, self.bus_name,
                                       Gio.BusNameOwnerFlags.NONE,
                                       None, None)
        for name in WATCHER_NAMES:
            Gio.bus_watch_name_on_connection(
                bus, name, Gio.BusNameWatcherFlags.NONE,
                self.on_watcher_appeared, self.on_watcher_vanished)
        Gio.bus_watch_name_on_connection(
            bus, "org.kde.KWin", Gio.BusNameWatcherFlags.NONE,
            lambda *a: self.set_kwin(True), lambda *a: self.set_kwin(False))

    # --- status ---------------------------------------------------------

    def set_kwin(self, value):
        self.kwin = value
        self.report_status()

    def report_status(self):
        status = dict(ready=self.registered and self.host,
                      registered=self.registered, host=self.host,
                      kwin=self.kwin)
        if status != self.last_status:
            self.last_status = status
            send(event="status", **status)

    # --- StatusNotifierWatcher -------------------------------------------

    def on_watcher_appeared(self, bus, name, owner):
        if self.watcher is not None:
            return
        self.watcher = name
        iface = name
        for sig in ("StatusNotifierHostRegistered",
                    "StatusNotifierHostUnregistered"):
            self.watcher_subs.append(bus.signal_subscribe(
                owner, iface, sig, WATCHER_PATH, None,
                Gio.DBusSignalFlags.NONE, self.on_host_changed))
        bus.call(name, WATCHER_PATH, iface, "RegisterStatusNotifierItem",
                 GLib.Variant("(s)", (self.bus_name,)), None,
                 Gio.DBusCallFlags.NONE, 5000, None, self.on_registered, name)
        self.on_host_changed()

    def on_watcher_vanished(self, bus, name):
        if self.watcher != name:
            return
        for sub in self.watcher_subs:
            bus.signal_unsubscribe(sub)
        self.watcher_subs = []
        self.watcher = None
        self.registered = False
        self.host = False
        self.report_status()

    def on_registered(self, bus, res, name):
        try:
            bus.call_finish(res)
        except GLib.Error as e:
            log("RegisterStatusNotifierItem failed:", e.message)
            return
        if self.watcher == name:
            self.registered = True
            self.report_status()

    def on_host_changed(self, *args):
        name = self.watcher
        if name is None:
            return
        self.bus.call(name, WATCHER_PATH, "org.freedesktop.DBus.Properties",
                      "Get", GLib.Variant("(ss)", (name,
                                                   "IsStatusNotifierHostRegistered")),
                      GLib.VariantType("(v)"), Gio.DBusCallFlags.NONE, 5000,
                      None, self.on_host_reply, name)

    def on_host_reply(self, bus, res, name):
        try:
            host = bool(bus.call_finish(res).unpack()[0])
        except GLib.Error as e:
            log("IsStatusNotifierHostRegistered failed:", e.message)
            host = False
        if self.watcher == name:
            self.host = host
            self.report_status()

    # --- D-Bus object implementation -------------------------------------

    def pixmap_variant(self):
        return GLib.Variant("a(iiay)", [(w, h, data)
                                        for w, h, data in self.pixmaps])

    def sni_property(self, name):
        if name == "Category":
            return GLib.Variant("s", "ApplicationStatus")
        if name == "Id":
            return GLib.Variant("s", "zotero")
        if name == "Title":
            return GLib.Variant("s", self.title)
        if name == "Status":
            return GLib.Variant("s", "Active")
        if name == "WindowId":
            return GLib.Variant("i", 0)
        if name == "IconName":
            return GLib.Variant("s", self.icon_name)
        if name == "IconPixmap":
            return self.pixmap_variant()
        if name in ("IconThemePath", "OverlayIconName", "AttentionIconName",
                    "AttentionMovieName"):
            return GLib.Variant("s", "")
        if name in ("OverlayIconPixmap", "AttentionIconPixmap"):
            return GLib.Variant("a(iiay)", [])
        if name == "ToolTip":
            return GLib.Variant("(sa(iiay)ss)",
                                (self.icon_name, [], self.title, ""))
        if name == "ItemIsMenu":
            return GLib.Variant("b", False)
        if name == "Menu":
            return GLib.Variant("o", MENU_PATH)
        return None

    def menu_property(self, name):
        if name == "Version":
            return GLib.Variant("u", 3)
        if name == "TextDirection":
            return GLib.Variant("s", "ltr")
        if name == "Status":
            return GLib.Variant("s", "normal")
        if name == "IconThemePath":
            return GLib.Variant("as", [])
        return None

    def on_get_property(self, bus, sender, path, iface, name):
        if iface == "com.canonical.dbusmenu":
            return self.menu_property(name)
        return self.sni_property(name)

    def menu_items(self):
        return {
            ITEM_TOGGLE: {"label": GLib.Variant("s", self.labels[
                "hide" if self.window_visible else "show"])},
            ITEM_SEP: {"type": GLib.Variant("s", "separator")},
            ITEM_QUIT: {"label": GLib.Variant("s", self.labels["quit"]),
                        "icon-name": GLib.Variant("s", "application-exit")},
        }

    @staticmethod
    def filter_props(props, names):
        if not names:
            return props
        return {k: v for k, v in props.items() if k in names}

    def menu_layout(self, parent, depth, names):
        items = self.menu_items()
        if parent != 0:
            return (parent, self.filter_props(items.get(parent, {}), names), [])
        children = []
        if depth != 0:
            children = [GLib.Variant("(ia{sv}av)",
                                     (i, self.filter_props(items[i], names), []))
                        for i in sorted(items)]
        root = {"children-display": GLib.Variant("s", "submenu")}
        return (0, self.filter_props(root, names), children)

    def on_menu_event(self, item_id, event_id):
        if event_id != "clicked":
            return
        if item_id == ITEM_TOGGLE:
            send(event="hide" if self.window_visible else "show")
        elif item_id == ITEM_QUIT:
            send(event="quit")

    def on_method_call(self, bus, sender, path, iface, method, params,
                       invocation):
        args = params.unpack()
        ret = None
        if iface == "org.kde.StatusNotifierItem":
            if method == "Activate":
                send(event="activate")
            elif method == "SecondaryActivate":
                send(event="show")
        elif method == "GetLayout":
            ret = GLib.Variant("(u(ia{sv}av))",
                               (self.menu_revision, self.menu_layout(*args)))
        elif method == "GetGroupProperties":
            ids, names = args
            items = self.menu_items()
            ret = GLib.Variant("(a(ia{sv}))", ([
                (i, self.filter_props(items[i], names))
                for i in (ids or sorted(items)) if i in items],))
        elif method == "GetProperty":
            item_id, name = args
            value = self.menu_items().get(item_id, {}).get(name)
            if value is None:
                invocation.return_dbus_error(
                    "com.canonical.dbusmenu.Error.UnknownProperty", name)
                return
            ret = GLib.Variant("(v)", (value,))
        elif method == "Event":
            self.on_menu_event(args[0], args[1])
        elif method == "EventGroup":
            items = self.menu_items()
            errors = []
            for item_id, event_id, _data, _ts in args[0]:
                if item_id in items:
                    self.on_menu_event(item_id, event_id)
                else:
                    errors.append(item_id)
            ret = GLib.Variant("(ai)", (errors,))
        elif method == "AboutToShow":
            ret = GLib.Variant("(b)", (False,))
        elif method == "AboutToShowGroup":
            ret = GLib.Variant("(aiai)", ([], []))
        invocation.return_value(ret)

    def menu_changed(self):
        self.menu_revision += 1
        self.bus.emit_signal(None, MENU_PATH, "com.canonical.dbusmenu",
                             "LayoutUpdated",
                             GLib.Variant("(ui)", (self.menu_revision, 0)))

    # --- KWin window activation ------------------------------------------

    def kwin_call(self, path, iface, method, params, callback=None):
        def done(bus, res, _data):
            try:
                reply = bus.call_finish(res)
            except GLib.Error as e:
                log("KWin %s failed: %s" % (method, e.message))
                return
            if callback:
                callback(reply)
        self.bus.call("org.kde.KWin", path, iface, method, params, None,
                      Gio.DBusCallFlags.NONE, 5000, None, done, None)

    def raise_window(self, pid, caption):
        if not self.kwin or os.environ.get("ZOTERO_TRAY_NO_KWIN"):
            return
        name = "zotero-tray-raise-%d" % os.getpid()
        scripting = ("/Scripting", "org.kde.kwin.Scripting")
        self.cleanup_raise(name)
        fd, self.raise_file = tempfile.mkstemp(
            prefix="zotero-tray-", suffix=".js",
            dir=os.environ.get("XDG_RUNTIME_DIR") or None)
        with os.fdopen(fd, "w") as f:
            f.write(KWIN_RAISE_SCRIPT % {"pid": int(pid),
                                         "caption": json.dumps(caption)})

        def loaded(reply):
            script_id = reply.unpack()[0]
            if script_id < 0:
                log("KWin refused to load the raise script")
                return
            self.kwin_call("/Scripting/Script%d" % script_id,
                           "org.kde.kwin.Script", "run", None)

        self.kwin_call(*scripting, "loadScript",
                       GLib.Variant("(ss)", (self.raise_file, name)), loaded)
        # The script keeps waiting for the window to map; drop it afterwards.
        self.raise_timer = GLib.timeout_add(3000, self.cleanup_raise, name)

    def cleanup_raise(self, name, sync=False):
        if self.raise_timer:
            GLib.source_remove(self.raise_timer)
            self.raise_timer = 0
        if self.raise_file:
            params = GLib.Variant("(s)", (name,))
            if sync:
                try:
                    self.bus.call_sync("org.kde.KWin", "/Scripting",
                                       "org.kde.kwin.Scripting",
                                       "unloadScript", params, None,
                                       Gio.DBusCallFlags.NONE, 1000, None)
                except GLib.Error:
                    pass
            else:
                self.kwin_call("/Scripting", "org.kde.kwin.Scripting",
                               "unloadScript", params)
            try:
                os.unlink(self.raise_file)
            except OSError:
                pass
            self.raise_file = None
        return GLib.SOURCE_REMOVE

    # --- commands from Zotero --------------------------------------------

    def handle_command(self, msg):
        cmd = msg.get("cmd")
        if cmd == "config":
            self.title = msg.get("title", self.title)
            self.icon_name = msg.get("iconName", self.icon_name)
            self.labels.update(msg.get("labels", {}))
            self.pixmaps = load_pixmaps(msg.get("iconFiles", []))
            for sig in ("NewTitle", "NewIcon", "NewToolTip"):
                self.bus.emit_signal(None, SNI_PATH,
                                     "org.kde.StatusNotifierItem", sig, None)
            self.menu_changed()
        elif cmd == "visible":
            visible = bool(msg.get("value"))
            if visible != self.window_visible:
                self.window_visible = visible
                self.menu_changed()
        elif cmd == "raise":
            self.raise_window(msg["pid"], msg.get("caption", ""))


def main():
    global loop
    loop = GLib.MainLoop()
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    tray = Tray(bus)
    buf = b""

    def on_stdin(fd, cond):
        nonlocal buf
        data = b""
        if cond & GLib.IO_IN:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
        if not data:
            loop.quit()
            return GLib.SOURCE_REMOVE
        buf += data
        *lines, buf = buf.split(b"\n")
        for line in lines:
            if not line.strip():
                continue
            try:
                tray.handle_command(json.loads(line))
            except Exception as e:  # keep the icon alive on bad input
                log("bad command %r: %s" % (line, e))
        return GLib.SOURCE_CONTINUE

    fd_add_full(GLib.PRIORITY_DEFAULT, sys.stdin.fileno(),
                GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_stdin)
    loop.run()
    tray.cleanup_raise("zotero-tray-raise-%d" % os.getpid(), sync=True)


if __name__ == "__main__":
    main()
