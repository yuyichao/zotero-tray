/* global Zotero, Services, ChromeUtils, PathUtils, IOUtils, Components, setTimeout, clearTimeout */
var { classes: Cc, interfaces: Ci, manager: Cm } = Components;
var { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

// Top-level declarations use var: Zotero keeps the plugin sandbox across
// disable/enable, so this file can be loaded into it more than once.

var PREF_BRANCH = "extensions.zotero-tray.";
// How long the main window may stay hidden without a tray host before it is
// brought back (e.g. while plasmashell restarts).
var HOST_GRACE_MS = 10000;
var MAX_HELPER_FAILURES = 5;

var CLH_CID = Components.ID("{1f6c9b1e-6f0e-4b52-9a8b-3e0d6a7c2f41}");
var CLH_CONTRACT = "@yyc1992/zotero-tray-clh;1";
// Sorted before Zotero's own "m-zotero" handler.
var CLH_CATEGORY_ENTRY = "l-zotero-tray";

ZoteroTray = {
  rootURI: null,
  proc: null,
  ready: false,
  kwin: false,
  quitting: false,
  shuttingDown: false,
  helperFailures: 0,
  hostTimer: null,
  windows: new Map(),
  hidden: new WeakSet(),

  async init({ rootURI }) {
    this.rootURI = rootURI;
    Services.obs.addObserver(this, "quit-application-granted");
    this.registerCommandLineHandler();
    this.wrapActivate();
    for (let win of Zotero.getMainWindows()) {
      if (win.document.readyState == "complete") {
        this.addToWindow(win);
      }
    }
    await this.startHelper();
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
    this.stopHelper();
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
      if (this.kwin) {
        this.send({ cmd: "raise", pid: Services.appinfo.processID, caption: win.document.title });
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

  // --- Tray helper process ---------------------------------------------

  async extractHelper() {
    let text = await Zotero.File.getResourceAsync(this.rootURI + "helper/zotero-tray-helper.py");
    let path = PathUtils.join(PathUtils.profileDir, "zotero-tray-helper.py");
    await IOUtils.writeUTF8(path, text);
    return path;
  },

  async startHelper() {
    if (this.shuttingDown || this.proc) return;
    let proc;
    try {
      let python = this.pref("python");
      if (!python.includes("/")) {
        python = await Subprocess.pathSearch(python);
      }
      let script = await this.extractHelper();
      proc = await Subprocess.call({
        command: python,
        arguments: [script],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    }
    catch (e) {
      Zotero.logError(e);
      this.log("could not start the tray helper; closing the main window will quit Zotero");
      return;
    }
    if (this.shuttingDown) {
      proc.kill();
      return;
    }
    this.proc = proc;
    this.log("tray helper started");
    this.readLines(proc.stderr, line => this.log("helper: " + line));
    this.readLines(proc.stdout, line => this.onHelperMessage(line));
    this.send({
      cmd: "config",
      title: Zotero.appName || "Zotero",
      iconName: this.pref("iconName"),
      iconFiles: ["icon128.png", "icon64.png", "icon32.png"].map(
        name => PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).path, "icons", name)),
    });
    this.sendVisible();
    proc.wait().then(({ exitCode }) => this.onHelperExit(proc, exitCode));
  },

  stopHelper() {
    let proc = this.proc;
    this.proc = null;
    this.ready = false;
    if (proc) {
      // The helper exits on EOF; kill it if it does not.
      proc.stdin.close().catch(() => {});
      setTimeout(() => proc.kill(), 2000);
    }
  },

  async readLines(pipe, callback) {
    let buf = "";
    try {
      for (;;) {
        let data = await pipe.readString();
        if (!data) break;
        buf += data;
        let lines = buf.split("\n");
        buf = lines.pop();
        for (let line of lines) {
          if (line) callback(line);
        }
      }
    }
    catch (e) {
      // Pipe closed
    }
  },

  send(msg) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify(msg) + "\n").catch(() => {});
  },

  sendVisible() {
    let win = Zotero.getMainWindow();
    let visible = !!win && this.isVisible(win) && win.windowState != win.STATE_MINIMIZED;
    this.send({ cmd: "visible", value: visible });
  },

  onHelperMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    }
    catch (e) {
      this.log("bad helper message: " + line);
      return;
    }
    this.log("helper event: " + line);
    // Run UI actions from a fresh event loop turn.
    Services.tm.dispatchToMainThread(() => {
      switch (msg.event) {
        case "status":
          this.setReady(msg.ready);
          this.kwin = msg.kwin;
          break;
        case "activate":
          this.toggleWindow(msg.token);
          break;
        case "show":
          this.showWindow(undefined, msg.token);
          break;
        case "hide": {
          let win = Zotero.getMainWindow();
          if (win && this.canHide(win)) this.hideWindow(win);
          break;
        }
        case "quit":
          this.quit();
          break;
      }
    });
  },

  setReady(ready) {
    this.log(ready ? "tray icon is shown" : "no tray host available");
    this.ready = ready;
    clearTimeout(this.hostTimer);
    if (ready) {
      this.helperFailures = 0;
    }
    else {
      this.hostTimer = setTimeout(() => {
        if (!this.ready) this.showHiddenWindows();
      }, HOST_GRACE_MS);
    }
  },

  onHelperExit(proc, exitCode) {
    if (this.proc != proc) return;
    this.proc = null;
    let wasReady = this.ready;
    this.ready = false;
    clearTimeout(this.hostTimer);
    if (this.shuttingDown || this.quitting) return;
    this.log(`tray helper exited with code ${exitCode}`);
    // Never leave the app running with neither a window nor a tray icon.
    this.showHiddenWindows();
    if (!wasReady) this.helperFailures++;
    if (this.helperFailures < MAX_HELPER_FAILURES) {
      setTimeout(() => this.startHelper(), 2000);
    }
  },
};
