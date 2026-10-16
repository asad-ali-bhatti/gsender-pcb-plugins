#!/bin/sh
# Copies every plugin in plugins/ into gSender's plugin directory.
# gSender skips symlinked plugin folders, so this copies rather than links.
# Usage: sh scripts/install.sh [plugin-name ...]
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)

if [ -n "${GSENDER_PLUGINS_DIR:-}" ]; then
	DEST=$GSENDER_PLUGINS_DIR
else
	case "$(uname -s)" in
		Darwin) DEST="$HOME/Library/Application Support/gSender/plugins" ;;
		Linux) DEST="${XDG_CONFIG_HOME:-$HOME/.config}/gSender/plugins" ;;
		*) DEST="$APPDATA/gSender/plugins" ;;
	esac
fi
mkdir -p "$DEST"

if [ $# -eq 0 ]; then set -- $(ls "$ROOT/plugins"); fi
for name in "$@"; do
	src="$ROOT/plugins/$name"
	[ -f "$src/gsender-plugin.json" ] || { echo "skip $name: no gsender-plugin.json"; continue; }
	rm -rf "${DEST:?}/$name"
	cp -R "$src" "$DEST/$name"
	echo "installed $name -> $DEST/$name"
done
