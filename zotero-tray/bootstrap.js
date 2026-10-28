/* global Services, APP_SHUTDOWN */
var ZoteroTray;

function install() {}

async function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "gdbus.js");
  Services.scriptloader.loadSubScript(rootURI + "tray-item.js");
  Services.scriptloader.loadSubScript(rootURI + "zotero-tray.js");
  await ZoteroTray.init({ id, version, rootURI });
}

function onMainWindowLoad({ window }) {
  ZoteroTray?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  ZoteroTray?.removeFromWindow(window);
}

function shutdown(data, reason) {
  ZoteroTray?.shutdown(reason == APP_SHUTDOWN);
  ZoteroTray = undefined;
}

function uninstall() {}
