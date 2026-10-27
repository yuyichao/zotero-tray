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

  showWindow(win = Zotero.getMainWindow()) {
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
    }
    else if (win.windowState == win.STATE_MINIMIZED) {
      win.restore();
    }
    win.focus();
    // Without an activation token from the click, the compositor may refuse
    // to focus the window; ask KWin directly when it is available.
    this.send({ cmd: "raise", pid: Services.appinfo.processID, caption: win.document.title });
    this.sendVisible();
  },

  showHiddenWindows() {
    for (let win of Zotero.getMainWindows()) {
      if (!this.isVisible(win)) {
        this.showWindow(win);
      }
    }
  },

  toggleWindow() {
    let win = Zotero.getMainWindow();
    this.log(`toggle: visible=${win && this.isVisible(win)} sizemode=${win?.windowState} `
      + `active=${Services.focus.activeWindow == win} focused=${win?.document.hasFocus()}`);
    if (win && this.isVisible(win) && win.windowState != win.STATE_MINIMIZED
        && Services.focus.activeWindow == win && this.canHide(win)) {
      this.hideWindow(win);
    }
    else {
      this.showWindow(win);
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
          this.toggleWindow();
          break;
        case "show":
          this.showWindow();
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
