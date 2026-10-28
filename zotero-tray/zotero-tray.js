/* global Zotero, Services, ChromeUtils, PathUtils, Components, setTimeout, clearTimeout, GDBus, TrayItem */
var { classes: Cc, interfaces: Ci, manager: Cm } = Components;

// Top-level declarations use var: Zotero keeps the plugin sandbox across
// disable/enable, so this file can be loaded into it more than once.

var PREF_BRANCH = "extensions.zotero-tray.";
// How long the main window may stay hidden without a tray host before it is
// brought back (e.g. while plasmashell restarts).
var HOST_GRACE_MS = 10000;
var MAX_TRAY_FAILURES = 5;

// resource://zotero-tray/ maps to the plugin's root, for the poll worker.
var RESOURCE_HOST = "zotero-tray";

var CLH_CID = Components.ID("{1f6c9b1e-6f0e-4b52-9a8b-3e0d6a7c2f41}");
var CLH_CONTRACT = "@yyc1992/zotero-tray-clh;1";
// Sorted before Zotero's own "m-zotero" handler.
var CLH_CATEGORY_ENTRY = "l-zotero-tray";

ZoteroTray = {
  rootURI: null,
  item: null,
  ready: false,
  kwin: false,
  quitting: false,
  shuttingDown: false,
  trayFailures: 0,
  hostTimer: null,
  windows: new Map(),
  hidden: new WeakSet(),

  async init({ rootURI }) {
    this.rootURI = rootURI;
    this.resProto().setSubstitution(RESOURCE_HOST, Services.io.newURI(rootURI));
    GDBus.init(`resource://${RESOURCE_HOST}/poll-worker.js`);
    Services.obs.addObserver(this, "quit-application-granted");
    this.registerCommandLineHandler();
    this.wrapActivate();
    for (let win of Zotero.getMainWindows()) {
      if (win.document.readyState == "complete") {
        this.addToWindow(win);
      }
    }
    this.startTray();
  },

  shutdown(appShutdown) {
    this.shuttingDown = true;
    Services.obs.removeObserver(this, "quit-application-granted");
    clearTimeout(this.hostTimer);
    if (!appShutdown) {
      this.showHiddenWindows();
      for (let win of [...this.windows.keys()]) {
        this.removeFromWindow(win);
      }
      this.unwrapActivate();
      this.unregisterCommandLineHandler();
    }
    this.stopTray();
    this.resProto().setSubstitution(RESOURCE_HOST, null);
  },

  resProto() {
    return Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  },

  log(msg) {
    Zotero.debug("Zotero Tray: " + msg);
  },

  pref(name) {
    return Zotero.Prefs.get(PREF_BRANCH + name, true);
  },

  observe(subject, topic) {
    if (topic == "quit-application-granted") {
      this.quitting = true;
    }
  },

  // --- Window handling ---------------------------------------------------

  baseWindow(win) {
    return win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow);
  },

  // nsIBaseWindow.visibility always reads back as true, so keep track of the
  // windows we hid ourselves.
  isVisible(win) {
    return !this.hidden.has(win);
  },

  isWayland() {
    try {
      return Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).windowProtocol == "wayland";
    }
    catch (e) {
      return false;
    }
  },

  // Only background the app while there is a working tray icon to bring it
  // back with.
  canHide(win) {
    if (!this.ready || this.quitting || this.shuttingDown || !this.pref("closeToTray")) {
      return false;
    }
    // With several main windows open, closing one should really close it.
    return !Zotero.getMainWindows().some(w => w != win && this.isVisible(w));
  },

  addToWindow(win) {
    if (this.windows.has(win)) return;
    let state = {
      onClose: (event) => {
        if (!this.canHide(win)) return;
        event.preventDefault();
        this.hideWindow(win);
      },
      onFocus: () => this.sendVisible(),
    };
    // "close" is the window manager's close request (server-side decoration,
    // Alt+F4, task bar). Zotero's own titlebar close button and Ctrl+W /
    // File → Close on the last tab call window.close(), which only fires
    // the cancelable "DOMWindowClose".
    win.addEventListener("close", state.onClose);
    win.addEventListener("DOMWindowClose", state.onClose);
    win.addEventListener("activate", state.onFocus);
    this.windows.set(win, state);
    this.sendVisible();
  },

  removeFromWindow(win) {
    let state = this.windows.get(win);
    if (!state) return;
    win.removeEventListener("close", state.onClose);
    win.removeEventListener("DOMWindowClose", state.onClose);
    win.removeEventListener("activate", state.onFocus);
    this.windows.delete(win);
    this.sendVisible();
  },

  hideWindow(win) {
    if (!this.isVisible(win)) return;
    let state = this.windows.get(win);
    if (state) {
      state.sizemode = win.windowState;
      state.x = win.screenX;
      state.y = win.screenY;
    }
    this.log("hiding main window");
    this.baseWindow(win).visibility = false;
    this.hidden.add(win);
    this.sendVisible();
  },

  // `token` is the xdg-activation token the tray host provided for the click.
  showWindow(win = Zotero.getMainWindow(), token = null) {
    if (!win) {
      this.log("no main window, opening one");
      Zotero.openMainWindow();
      return;
    }
    if (!this.isVisible(win)) {
      this.log("showing main window");
      this.baseWindow(win).visibility = true;
      this.hidden.delete(win);
      let state = this.windows.get(win);
      if (state?.sizemode == win.STATE_MAXIMIZED) {
        win.maximize();
      }
      else if (state && state.x !== undefined && !this.isWayland()) {
        win.moveTo(state.x, state.y);
      }
      // The window manager only knows the window again once it is mapped.
      this.afterShown(win, () => this.activateWindow(win, token));
    }
    else {
      if (win.windowState == win.STATE_MINIMIZED) {
        win.restore();
      }
      this.activateWindow(win, token);
    }
    this.sendVisible();
  },

  afterShown(win, callback) {
    let done = false;
    let run = () => {
      if (done) return;
      done = true;
      callback();
    };
    win.requestAnimationFrame(() => win.requestAnimationFrame(run));
    setTimeout(run, 500);
  },

  // --- Window activation -------------------------------------------------
  //
  // After a tray click the last user input went to the tray, not to Zotero,
  // so Gecko's own focus request can be refused by focus-stealing prevention.
  // Use the standard ways for a tray/task bar to activate a window instead:
  //  - Wayland: the xdg-activation token the tray host provided for the
  //    click, handed to GTK, which passes it to xdg_activation_v1.activate.
  //  - X11: an EWMH _NET_ACTIVE_WINDOW request with the pager source
  //    indication, as a task bar sends.
  // Without a token on Wayland, ask KWin through a script when available,
  // and use Gecko's own window.focus() otherwise.

  activateWindow(win, token) {
    let how = null;
    try {
      if (!this.isWayland()) {
        this.ewmhActivate(win);
        how = "EWMH _NET_ACTIVE_WINDOW";
      }
      else if (token) {
        this.tokenActivate(win, token);
        how = "xdg-activation token";
      }
    }
    catch (e) {
      Zotero.logError(e);
    }
    if (!how) {
      win.focus();
      if (this.kwin && this.item) {
        this.item.raiseWindow(Services.appinfo.processID, win.document.title);
        how = "KWin script";
      }
      else {
        how = "window.focus()";
      }
    }
    this.log("activating main window via " + how);
  },

  // Gecko's GTK toplevel GdkWindow for a chrome window.
  gdkWindow(win) {
    let lib = this.gdk();
    let { ctypes } = lib;
    // NS_NATIVE_WINDOW of the main widget, as "0x..."
    let handle = this.baseWindow(win).nativeHandle;
    let gdkWin = ctypes.voidptr_t(ctypes.UInt64(handle));
    if (gdkWin.isNull()) {
      throw new Error("no native window for the main window");
    }
    return lib.getToplevel(gdkWin);
  },

  gdk() {
    if (!this._gdk) {
      let { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      let lib = ctypes.open("libgdk-3.so.0");
      let ptr = ctypes.voidptr_t;
      this._gdk = {
        ctypes,
        lib,
        getDefaultDisplay: lib.declare("gdk_display_get_default", ctypes.default_abi, ptr),
        getToplevel: lib.declare("gdk_window_get_toplevel", ctypes.default_abi, ptr, ptr),
      };
    }
    return this._gdk;
  },

  tokenActivate(win, token) {
    let g = this.gdk();
    let { ctypes } = g;
    if (!g.setStartupId) {
      g.setStartupId = g.lib.declare("gdk_wayland_display_set_startup_notification_id",
        ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t, ctypes.char.ptr);
      g.focus = g.lib.declare("gdk_window_focus",
        ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t, ctypes.uint32_t);
    }
    let gdkWin = this.gdkWindow(win);
    // gdk_window_focus() consumes the display's startup notification ID as
    // the activation token for xdg_activation_v1.activate.
    g.setStartupId(g.getDefaultDisplay(), token);
    g.focus(gdkWin, 0);
  },

  ewmhActivate(win) {
    let g = this.gdk();
    let { ctypes } = g;
    if (!g.x11) {
      let x11 = ctypes.open("libX11.so.6");
      let ptr = ctypes.voidptr_t;
      let XID = ctypes.unsigned_long;
      g.x11 = {
        lib: x11,
        ClientMessageEvent: new ctypes.StructType("XClientMessageEvent", [
          { type: ctypes.int },
          { serial: ctypes.unsigned_long },
          { send_event: ctypes.int },
          { display: ptr },
          { window: XID },
          { message_type: XID },
          { format: ctypes.int },
          { data: ctypes.long.array(5) },
          // XSendEvent copies a whole XEvent (24 longs).
          { pad: ctypes.long.array(12) },
        ]),
        getXDisplay: g.lib.declare("gdk_x11_display_get_xdisplay", ctypes.default_abi, ptr, ptr),
        getXid: g.lib.declare("gdk_x11_window_get_xid", ctypes.default_abi, XID, ptr),
        getRoot: g.lib.declare("gdk_x11_get_default_root_xwindow", ctypes.default_abi, XID),
        internAtom: x11.declare("XInternAtom", ctypes.default_abi, XID, ptr, ctypes.char.ptr, ctypes.int),
        sendEvent: x11.declare("XSendEvent", ctypes.default_abi, ctypes.int,
          ptr, XID, ctypes.int, ctypes.long, ptr),
        flush: x11.declare("XFlush", ctypes.default_abi, ctypes.int, ptr),
      };
    }
    let x = g.x11;
    let gdkWin = this.gdkWindow(win);
    let display = x.getXDisplay(g.getDefaultDisplay());
    let event = new x.ClientMessageEvent();
    event.type = 33; // ClientMessage
    event.send_event = 1;
    event.display = display;
    event.window = x.getXid(gdkWin);
    event.message_type = x.internAtom(display, "_NET_ACTIVE_WINDOW", 0);
    event.format = 32;
    event.data[0] = 2; // source indication: pager
    // Timestamp: CurrentTime. (gdk_x11_get_server_time() would block forever
    // since Gecko's toplevel does not select PropertyChange events.)
    event.data[1] = 0;
    event.data[2] = 0;
    let mask = (1 << 20) | (1 << 19); // SubstructureRedirect | SubstructureNotify
    if (!x.sendEvent(display, x.getRoot(), 0, mask, event.address())) {
      throw new Error("XSendEvent failed");
    }
    x.flush(display);
  },

  showHiddenWindows() {
    for (let win of Zotero.getMainWindows()) {
      if (!this.isVisible(win)) {
        this.showWindow(win);
      }
    }
  },

  toggleWindow(token) {
    let win = Zotero.getMainWindow();
    this.log(`toggle: visible=${win && this.isVisible(win)} sizemode=${win?.windowState} `
      + `active=${Services.focus.activeWindow == win} focused=${win?.document.hasFocus()}`);
    if (win && this.isVisible(win) && win.windowState != win.STATE_MINIMIZED
        && Services.focus.activeWindow == win && this.canHide(win)) {
      this.hideWindow(win);
    }
    else {
      this.showWindow(win, token);
    }
  },

  quit() {
    let win = Zotero.getMainWindow();
    if (win && typeof win.goQuitApplication == "function") {
      // Goes through the quit-application-requested checks; it expects the
      // triggering event to look at its modifiers.
      win.goQuitApplication({});
    }
    else {
      Zotero.Utilities.Internal.quit();
    }
  },

  // Show the hidden window when Zotero is launched again or asked to bring
  // itself to the front.
  registerCommandLineHandler() {
    let tray = this;
    this.clh = {
      handle(cmdLine) {
        if (cmdLine.state == Ci.nsICommandLine.STATE_INITIAL_LAUNCH) return;
        if (cmdLine.findFlag("ZoteroIntegrationAgent", false) != -1) return;
        let win = Zotero.getMainWindow();
        if (win && !tray.isVisible(win)) {
          tray.showWindow(win);
        }
      },
      helpInfo: "",
      QueryInterface: ChromeUtils.generateQI(["nsICommandLineHandler"]),
      createInstance(iid) {
        return this.QueryInterface(iid);
      },
    };
    let registrar = Cm.QueryInterface(Ci.nsIComponentRegistrar);
    registrar.registerFactory(CLH_CID, "Zotero Tray command line handler", CLH_CONTRACT, this.clh);
    Services.catMan.addCategoryEntry("command-line-handler", CLH_CATEGORY_ENTRY, CLH_CONTRACT, false, true);
  },

  unregisterCommandLineHandler() {
    if (!this.clh) return;
    Services.catMan.deleteCategoryEntry("command-line-handler", CLH_CATEGORY_ENTRY, false);
    Cm.QueryInterface(Ci.nsIComponentRegistrar).unregisterFactory(CLH_CID, this.clh);
    this.clh = null;
  },

  wrapActivate() {
    let internal = Zotero.Utilities.Internal;
    let orig = this.origActivate = internal.activate;
    let tray = this;
    internal.activate = function (win) {
      if (win && tray.windows.has(win) && !tray.isVisible(win)) {
        tray.showWindow(win);
      }
      return orig.apply(this, arguments);
    };
  },

  unwrapActivate() {
    if (this.origActivate) {
      Zotero.Utilities.Internal.activate = this.origActivate;
      this.origActivate = null;
    }
  },

  // --- Tray icon ---------------------------------------------------------

  async startTray() {
    if (this.shuttingDown || this.item) return;
    let item = this.item = new TrayItem(this.trayEvents(), {
      title: Zotero.appName || "Zotero",
      iconName: this.pref("iconName"),
      log: msg => this.log(msg),
    });
    try {
      await item.start();
    }
    catch (e) {
      Zotero.logError(e);
      this.log("could not show the tray icon; closing the main window will quit Zotero");
      if (this.item == item) this.onTrayLost(item);
      return;
    }
    if (this.item != item) return;
    this.sendVisible();
    let pixmaps = [];
    try {
      pixmaps = this.loadPixmaps();
    }
    catch (e) {
      Zotero.logError(e);
    }
    if (pixmaps.length) item.setPixmaps(pixmaps);
  },

  stopTray() {
    let item = this.item;
    this.item = null;
    this.ready = false;
    item?.stop();
  },

  // Tray events arrive from GDBus callbacks; run UI actions from a fresh
  // event loop turn.
  trayEvents() {
    let dispatch = (fn) => {
      let item = this.item;
      Services.tm.dispatchToMainThread(() => {
        if (this.item == item) fn();
      });
    };
    return {
      status: ({ ready, kwin }) => dispatch(() => {
        this.kwin = kwin;
        this.setReady(ready);
      }),
      activate: token => dispatch(() => this.toggleWindow(token)),
      show: token => dispatch(() => this.showWindow(undefined, token)),
      hide: () => dispatch(() => {
        let win = Zotero.getMainWindow();
        if (win && this.canHide(win)) this.hideWindow(win);
      }),
      quit: () => dispatch(() => this.quit()),
      closed: () => dispatch(() => this.onTrayLost(this.item)),
    };
  },

  // Zotero's bundled icons as ARGB32 pixmaps, for when the icon theme has no
  // icon named by the iconName pref.
  loadPixmaps() {
    let { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
    let lib = ctypes.open("libgdk_pixbuf-2.0.so.0");
    let ptr = ctypes.voidptr_t;
    let int = (name) => lib.declare(name, ctypes.default_abi, ctypes.int, ptr);
    let fromFile = lib.declare("gdk_pixbuf_new_from_file", ctypes.default_abi, ptr,
      ctypes.char.ptr, ptr);
    let getPixels = lib.declare("gdk_pixbuf_get_pixels", ctypes.default_abi, ctypes.uint8_t.ptr, ptr);
    let [getWidth, getHeight, getRowstride, getNChannels] = ["gdk_pixbuf_get_width",
      "gdk_pixbuf_get_height", "gdk_pixbuf_get_rowstride", "gdk_pixbuf_get_n_channels"].map(int);
    let unref = lib.declare("g_object_unref", ctypes.default_abi, ctypes.void_t, ptr);
    let iconDir = PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).path, "icons");
    let pixmaps = [];
    try {
      for (let name of ["icon128.png", "icon64.png", "icon32.png"]) {
        let pixbuf = fromFile(PathUtils.join(iconDir, name), null);
        if (pixbuf.isNull()) {
          this.log("could not load " + name);
          continue;
        }
        try {
          let width = getWidth(pixbuf);
          let height = getHeight(pixbuf);
          let stride = getRowstride(pixbuf);
          let channels = getNChannels(pixbuf);
          let src = ctypes.cast(getPixels(pixbuf),
            ctypes.uint8_t.array(stride * (height - 1) + width * channels).ptr).contents;
          // RGB(A) rows to ARGB32 in network byte order
          let data = new Uint8Array(width * height * 4);
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              let s = y * stride + x * channels;
              let d = (y * width + x) * 4;
              data[d] = channels == 4 ? src[s + 3] : 255;
              data[d + 1] = src[s];
              data[d + 2] = src[s + 1];
              data[d + 3] = src[s + 2];
            }
          }
          pixmaps.push({ width, height, data });
        }
        finally {
          unref(pixbuf);
        }
      }
    }
    finally {
      lib.close();
    }
    return pixmaps;
  },

  sendVisible() {
    let win = Zotero.getMainWindow();
    let visible = !!win && this.isVisible(win) && win.windowState != win.STATE_MINIMIZED;
    this.item?.setVisible(visible);
  },

  setReady(ready) {
    this.log(ready ? "tray icon is shown" : "no tray host available");
    this.ready = ready;
    clearTimeout(this.hostTimer);
    if (ready) {
      this.trayFailures = 0;
    }
    else {
      this.hostTimer = setTimeout(() => {
        if (!this.ready) this.showHiddenWindows();
      }, HOST_GRACE_MS);
    }
  },

  // The bus connection failed or was lost.
  onTrayLost(item) {
    if (!item || this.item != item) return;
    let wasReady = this.ready;
    this.stopTray();
    clearTimeout(this.hostTimer);
    if (this.shuttingDown || this.quitting) return;
    // Never leave the app running with neither a window nor a tray icon.
    this.showHiddenWindows();
    if (!wasReady) this.trayFailures++;
    if (this.trayFailures < MAX_TRAY_FAILURES) {
      setTimeout(() => this.startTray(), 2000);
    }
  },
};
