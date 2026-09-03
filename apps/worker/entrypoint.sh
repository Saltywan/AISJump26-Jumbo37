#!/usr/bin/env bash
# /kit is mounted read-only and deliberately ships no node_modules, but
# check.mjs needs `playwright` importable from beside it. Copy the kit somewhere
# writable and put the pre-installed node_modules next to it — ESM resolution
# walks up from checks/check.mjs and finds it there.
set -euo pipefail

SRC=${KIT_SRC:-/kit}
DEST=${KIT_DIR:-/opt/kit}

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
ln -sfn /app/node_modules "$DEST/node_modules"

echo "worker: kit staged at $DEST ($(cat "$DEST/VERSION" 2>/dev/null | head -1))"
exec python3 /app/worker.py
