#!/bin/sh
# Build zotero-tray.xpi from the zotero-tray/ source directory.
set -e
cd "$(dirname "$0")/zotero-tray"
rm -f ../zotero-tray.xpi
python3 -m zipfile -c ../zotero-tray.xpi manifest.json bootstrap.js prefs.js gdbus.js poll-worker.js tray-item.js zotero-tray.js
echo "built $(cd .. && pwd)/zotero-tray.xpi"
