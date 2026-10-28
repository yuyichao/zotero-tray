/* global GDBus, Services, PathUtils, IOUtils, setTimeout, clearTimeout */
// The tray icon: a StatusNotifierItem (org.kde.StatusNotifierItem) with a
// com.canonical.dbusmenu context menu, exported on a private session bus
// connection through GDBus (see gdbus.js).
//
// `events` receives:
//   status({ ready, kwin }): ready is true while the item is registered with
//     a StatusNotifierWatcher that has a host; kwin while KWin is running
//   activate(token), show(token), hide(), quit(): tray clicks; `token` is the
//     xdg-activation token the tray host provided for the click, if any
//   closed(): the bus connection was lost

var SNI_PATH = "/StatusNotifierItem";
var MENU_PATH = "/MenuBar";
var SNI_IFACE = "org.kde.StatusNotifierItem";
var MENU_IFACE = "com.canonical.dbusmenu";
var WATCHER_NAMES = ["org.kde.StatusNotifierWatcher", "org.freedesktop.StatusNotifierWatcher"];
var WATCHER_PATH = "/StatusNotifierWatcher";
var PROPS_IFACE = "org.freedesktop.DBus.Properties";

var ITEM_TOGGLE = 1;
var ITEM_SEP = 2;
var ITEM_QUIT = 3;

// Tokens are single use and short lived; only hand one out with the event
// that immediately follows it.
var TOKEN_MAX_AGE_MS = 5000;

var SNI_XML = `
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
</node>`;

var MENU_XML = `
<node>
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
</node>`;

// Activates the (just re-mapped) Zotero main window. Loaded on demand through
// KWin's scripting D-Bus API, so no KWin configuration is needed.
var KWIN_RAISE_SCRIPT = `
(function () {
    const pid = %PID%;
    const caption = %CAPTION%;
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
`;

var TrayItem = class {
  constructor(events, { title, iconName, log }) {
    this.events = events;
    this.title = title;
    this.iconName = iconName;
    this.log = log;
    this.labels = { show: "Show " + title, hide: "Hide " + title, quit: "Quit " + title };
    this.pixmaps = null;
    this.windowVisible = true;
    this.menuRevision = 1;
    this.conn = null;
    this.busName = `org.kde.StatusNotifierItem-${Services.appinfo.processID}-1`;
    this.nameOwned = false;
    this.registered = false;
    this.registerTimer = null;
    this.registerAttempts = 0;
    this.host = false;
    this.kwin = false;
    this.watcher = null;
    this.watcherSubs = [];
    this.lastStatus = null;
    this.raise = null;
    this.stopped = false;
    this.token = null;
    this.tokenTime = 0;
  }

  async start() {
    let conn = await GDBus.connectSession();
    if (this.stopped) {
      conn.close();
      return;
    }
    this.conn = conn;
    conn.onClosed = () => {
      this.log("lost the D-Bus connection");
      this.stop();
      this.events.closed();
    };
    conn.registerObject(SNI_PATH, SNI_XML, {
      interfaces: [SNI_IFACE],
      methodCall: (iface, method, args) => this.onSniCall(method, args),
      getProperty: (iface, name) => this.sniProperty(name),
    });
    conn.registerObject(MENU_PATH, MENU_XML, {
      interfaces: [MENU_IFACE],
      methodCall: (iface, method, args) => this.onMenuCall(method, args),
      getProperty: (iface, name) => this.menuProperty(name),
    });
    conn.ownName(this.busName,
      () => {
        this.nameOwned = true;
        this.register();
      },
      () => {
        this.log("lost bus name " + this.busName);
        this.nameOwned = false;
        this.registered = false;
        this.reportStatus();
      });
    for (let name of WATCHER_NAMES) {
      conn.watchName(name,
        owner => this.onWatcherAppeared(name, owner),
        () => this.onWatcherVanished(name));
    }
    conn.watchName("org.kde.KWin", () => this.setKWin(true), () => this.setKWin(false));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.registerTimer);
    this.cleanupRaise();
    this.conn?.close();
    this.conn = null;
    if (this.pixmaps) {
      GDBus.V.unref(this.pixmaps);
      this.pixmaps = null;
    }
  }

  // --- Status --------------------------------------------------------------

  setKWin(value) {
    // ZOTERO_TRAY_NO_KWIN=1 disables the KWin activation fallback.
    this.kwin = value && !Services.env.get("ZOTERO_TRAY_NO_KWIN");
    this.reportStatus();
  }

  reportStatus() {
    let status = { ready: this.registered && this.host, registered: this.registered,
      host: this.host, kwin: this.kwin };
    if (JSON.stringify(status) != JSON.stringify(this.lastStatus)) {
      this.lastStatus = status;
      this.log("status " + JSON.stringify(status));
      this.events.status(status);
    }
  }

  // --- StatusNotifierWatcher -------------------------------------------------

  // The KDE watcher silently ignores items whose bus name is not owned yet,
  // so only register once both the name and the watcher are there.
  // Registration is also confirmed against the watcher's item list and
  // retried, since a successful reply does not mean the item was added.
  async register() {
    clearTimeout(this.registerTimer);
    this.registerTimer = null;
    let name = this.watcher;
    if (!this.nameOwned || !name || !this.conn) return;
    this.registerAttempts++;
    try {
      await this.conn.call(name, WATCHER_PATH, name, "RegisterStatusNotifierItem",
        GDBus.V.tuple([GDBus.V.s(this.busName)]));
    }
    catch (e) {
      this.log("RegisterStatusNotifierItem failed: " + e.message);
      if (this.watcher == name) this.retryRegister();
      return;
    }
    if (this.watcher != name || !this.nameOwned || !this.conn) return;
    let items = null;
    try {
      [items] = await this.conn.call(name, WATCHER_PATH, PROPS_IFACE, "Get",
        GDBus.V.tuple([GDBus.V.s(name), GDBus.V.s("RegisteredStatusNotifierItems")]));
    }
    catch (e) {
      this.log("RegisteredStatusNotifierItems failed: " + e.message);
    }
    if (this.watcher != name || !this.nameOwned) return;
    // Some watchers may not implement the property; trust the reply then.
    if (!items || items.some(item => this.isOurItem(item))) {
      this.registered = true;
      this.reportStatus();
    }
    else {
      this.log("watcher did not list the item, registering again");
      this.retryRegister();
    }
  }

  retryRegister() {
    if (this.registerTimer || this.stopped) return;
    let delay = this.registerAttempts < 10 ? 1000 : 5000;
    this.registerTimer = setTimeout(() => this.register(), delay);
  }

  isOurItem(item) {
    return item == this.busName || item.startsWith(this.busName + "/");
  }

  onWatcherAppeared(name, owner) {
    if (this.watcher) return;
    this.watcher = name;
    for (let signal of ["StatusNotifierHostRegistered", "StatusNotifierHostUnregistered"]) {
      this.watcherSubs.push(this.conn.subscribe(owner, name, signal, WATCHER_PATH,
        () => this.checkHost()));
    }
    this.watcherSubs.push(this.conn.subscribe(owner, name, "StatusNotifierItemUnregistered",
      WATCHER_PATH, ([item]) => {
        if (!this.isOurItem(item)) return;
        this.log("watcher unregistered the item, registering again");
        this.registered = false;
        this.reportStatus();
        this.retryRegister();
      }));
    this.registerAttempts = 0;
    this.register();
    this.checkHost();
  }

  onWatcherVanished(name) {
    if (this.watcher != name) return;
    this.watcherSubs.forEach(id => this.conn.unsubscribe(id));
    this.watcherSubs = [];
    this.watcher = null;
    this.registered = false;
    this.host = false;
    this.reportStatus();
  }

  async checkHost() {
    let name = this.watcher;
    if (!name || !this.conn) return;
    let host = false;
    try {
      [host] = await this.conn.call(name, WATCHER_PATH, PROPS_IFACE, "Get",
        GDBus.V.tuple([GDBus.V.s(name), GDBus.V.s("IsStatusNotifierHostRegistered")]));
    }
    catch (e) {
      this.log("IsStatusNotifierHostRegistered failed: " + e.message);
    }
    if (this.watcher == name) {
      this.host = !!host;
      this.reportStatus();
    }
  }

  // --- StatusNotifierItem ----------------------------------------------------

  // `pixmaps`: [{ width, height, data }] with ARGB32 pixels in network byte
  // order.
  setPixmaps(pixmaps) {
    let V = GDBus.V;
    if (this.pixmaps) V.unref(this.pixmaps);
    this.pixmaps = V.keep(V.array("(iiay)", pixmaps.map(
      ({ width, height, data }) => V.tuple([V.i(width), V.i(height), V.bytes(data)]))));
    this.conn?.emitSignal(SNI_PATH, SNI_IFACE, "NewIcon");
  }

  sniProperty(name) {
    let V = GDBus.V;
    switch (name) {
      case "Category": return V.s("ApplicationStatus");
      case "Id": return V.s("zotero");
      case "Title": return V.s(this.title);
      case "Status": return V.s("Active");
      case "WindowId": return V.i(0);
      case "IconName": return V.s(this.iconName);
      case "IconPixmap": return this.pixmaps ? V.ref(this.pixmaps) : V.array("(iiay)", []);
      case "IconThemePath": case "OverlayIconName": case "AttentionIconName":
      case "AttentionMovieName":
        return V.s("");
      case "OverlayIconPixmap": case "AttentionIconPixmap":
        return V.array("(iiay)", []);
      case "ToolTip":
        return V.tuple([V.s(this.iconName), V.array("(iiay)", []), V.s(this.title), V.s("")]);
      case "ItemIsMenu": return V.b(false);
      case "Menu": return V.o(MENU_PATH);
    }
    return null;
  }

  onSniCall(method, args) {
    switch (method) {
      case "Activate":
        this.sendActivation("activate", "Activate");
        break;
      case "SecondaryActivate":
        this.sendActivation("show", "SecondaryActivate");
        break;
      case "ProvideXdgActivationToken":
        this.token = args[0];
        this.tokenTime = Date.now();
        break;
    }
    return null;
  }

  takeToken() {
    let token = this.token;
    this.token = null;
    return token && Date.now() - this.tokenTime < TOKEN_MAX_AGE_MS ? token : null;
  }

  sendActivation(event, source) {
    let token = this.takeToken();
    this.log(`${event} from ${source} ${token ? "with" : "without"} activation token`);
    this.events[event](token);
  }

  // --- dbusmenu --------------------------------------------------------------

  menuProperty(name) {
    let V = GDBus.V;
    switch (name) {
      case "Version": return V.u(3);
      case "TextDirection": return V.s("ltr");
      case "Status": return V.s("normal");
      case "IconThemePath": return V.array("s", []);
    }
    return null;
  }

  // Item properties as plain JS; turned into a{sv} by itemProps().
  menuItems() {
    return {
      [ITEM_TOGGLE]: { label: this.labels[this.windowVisible ? "hide" : "show"] },
      [ITEM_SEP]: { type: "separator" },
      [ITEM_QUIT]: { label: this.labels.quit, "icon-name": "application-exit" },
    };
  }

  itemProps(props, names) {
    let V = GDBus.V;
    let dict = {};
    for (let [key, value] of Object.entries(props)) {
      if (!names.length || names.includes(key)) dict[key] = V.s(value);
    }
    return V.vardict(dict);
  }

  menuLayout(parent, depth, names) {
    let V = GDBus.V;
    let items = this.menuItems();
    if (parent != 0) {
      return V.tuple([V.i(parent), this.itemProps(items[parent] || {}, names), V.array("v", [])]);
    }
    let children = [];
    if (depth != 0) {
      children = Object.keys(items).map(id => V.v(V.tuple([
        V.i(Number(id)), this.itemProps(items[id], names), V.array("v", [])])));
    }
    return V.tuple([V.i(0), this.itemProps({ "children-display": "submenu" }, names),
      V.array("v", children)]);
  }

  onMenuCall(method, args) {
    let V = GDBus.V;
    switch (method) {
      case "GetLayout": {
        let [parent, depth, names] = args;
        return V.tuple([V.u(this.menuRevision), this.menuLayout(parent, depth, names)]);
      }
      case "GetGroupProperties": {
        let [ids, names] = args;
        let items = this.menuItems();
        if (!ids.length) ids = Object.keys(items).map(Number);
        return V.tuple([V.array("(ia{sv})", ids.filter(id => items[id]).map(
          id => V.tuple([V.i(id), this.itemProps(items[id], names)])))]);
      }
      case "GetProperty": {
        let [id, name] = args;
        let value = this.menuItems()[id]?.[name];
        if (value === undefined) {
          let error = new Error(name);
          error.dbusName = "com.canonical.dbusmenu.Error.UnknownProperty";
          throw error;
        }
        return V.tuple([V.v(V.s(value))]);
      }
      case "Event":
        this.onMenuEvent(args[0], args[1]);
        return null;
      case "EventGroup": {
        let items = this.menuItems();
        let errors = [];
        for (let [id, eventId] of args[0]) {
          if (items[id]) this.onMenuEvent(id, eventId);
          else errors.push(id);
        }
        return V.tuple([V.array("i", errors.map(id => V.i(id)))]);
      }
      case "AboutToShow":
        return V.tuple([V.b(false)]);
      case "AboutToShowGroup":
        return V.tuple([V.array("i", []), V.array("i", [])]);
    }
    return null;
  }

  onMenuEvent(id, eventId) {
    if (eventId != "clicked") return;
    if (id == ITEM_TOGGLE) {
      if (this.windowVisible) {
        this.takeToken();
        this.events.hide();
      }
      else {
        this.sendActivation("show", "menu");
      }
    }
    else if (id == ITEM_QUIT) {
      this.events.quit();
    }
  }

  setVisible(visible) {
    if (visible == this.windowVisible) return;
    this.windowVisible = visible;
    this.menuRevision++;
    this.conn?.emitSignal(MENU_PATH, MENU_IFACE, "LayoutUpdated",
      GDBus.V.tuple([GDBus.V.u(this.menuRevision), GDBus.V.i(0)]));
  }

  // --- KWin window activation ------------------------------------------------

  async raiseWindow(pid, caption) {
    if (!this.kwin || !this.conn) return;
    this.cleanupRaise();
    let name = `zotero-tray-raise-${Services.appinfo.processID}`;
    let dir = Services.env.get("XDG_RUNTIME_DIR") || PathUtils.tempDir;
    let file = PathUtils.join(dir, `zotero-tray-${Services.appinfo.processID}-${Date.now()}.js`);
    let raise = this.raise = { name, file, timer: null };
    let script = KWIN_RAISE_SCRIPT.replace("%PID%", String(pid))
      .replace("%CAPTION%", JSON.stringify(caption));
    await IOUtils.writeUTF8(file, script);
    if (this.raise != raise || !this.conn) {
      IOUtils.remove(file).catch(() => {});
      return;
    }
    // The script keeps waiting for the window to map; drop it afterwards.
    raise.timer = setTimeout(() => this.cleanupRaise(), 3000);
    let id;
    try {
      [id] = await this.conn.call("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting",
        "loadScript", GDBus.V.tuple([GDBus.V.s(file), GDBus.V.s(name)]));
    }
    catch (e) {
      this.log("KWin loadScript failed: " + e.message);
      return;
    }
    if (id < 0) {
      this.log("KWin refused to load the raise script");
      return;
    }
    if (this.raise == raise) {
      this.conn.send("org.kde.KWin", "/Scripting/Script" + id, "org.kde.kwin.Script", "run");
    }
  }

  cleanupRaise() {
    let raise = this.raise;
    if (!raise) return;
    this.raise = null;
    clearTimeout(raise.timer);
    this.conn?.send("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "unloadScript",
      GDBus.V.tuple([GDBus.V.s(raise.name)]));
    IOUtils.remove(raise.file).catch(() => {});
  }
};
