#!/bin/sh
# Builds dist/<plugin>-<version>.zip for each plugin, ready for gSender's
# "Install plugin" dialog.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/dist"
for dir in "$ROOT"/plugins/*/; do
	name=$(basename "$dir")
	# Plugins still in development have no manifest yet and are not released.
	[ -f "$dir/gsender-plugin.json" ] || { echo "skip $name: no gsender-plugin.json" >&2; continue; }
	version=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).version)" "$dir/gsender-plugin.json")
	out="$ROOT/dist/$name-$version.zip"
	rm -f "$out"
	(cd "$ROOT/plugins" && zip -qr "$out" "$name" -x '*.DS_Store')
	echo "$out"
done
