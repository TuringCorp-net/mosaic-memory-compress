#!/usr/bin/env bash
# Mount MosaicMemoryCompress into a DSH profile by INSTALLING it, never by
# symlinking the checkout: a symlinked dev tree carries its own
# node_modules/@deepseek-ai, which shadows the host's session API and makes
# the runtime capability probe validate against the wrong implementation.
#
# Usage: scripts/install-local.sh [profile_node_modules_dir]
#   default: ~/.dsh/profiles/node_modules
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$HOME/.dsh/profiles/node_modules}"
DEST="$TARGET/mosaic-memory-compress"

TARBALL="$(cd "$REPO" && npm pack --pack-destination /tmp 2>/dev/null | tail -1)"
rm -rf "$DEST"
mkdir -p "$DEST"
tar xzf "/tmp/$TARBALL" --strip-components=1 -C "$DEST"
rm -f "/tmp/$TARBALL"

echo "installed $TARBALL → $DEST"
node -e "
const m = require('$DEST/dsh-module/dist/index.cjs');
const { createRequire } = require('module');
const req = createRequire('$DEST/dsh-module/dist/');
console.log('session API resolves to:', req.resolve('@deepseek-ai/dsh-session'));
console.log('probe selects:', m.detectedReplaceFields());
"
