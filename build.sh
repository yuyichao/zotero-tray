#!/bin/sh
# Build zotero-tray.xpi from the zotero-tray/ source directory.
set -e
cd "$(dirname "$0")/zotero-tray"
rm -f ../zotero-tray.xpi
python3 -m zipfile -c ../zotero-tray.xpi manifest.json bootstrap.js prefs.js zotero-tray.js helper
echo "built $(cd .. && pwd)/zotero-tray.xpi"
