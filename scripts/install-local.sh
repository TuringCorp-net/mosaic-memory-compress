#!/usr/bin/env bash
# ⚠️  NOT RECOMMENDED — kept for reference only (2026-09-10).
#
# Installing a bare unpack into profiles/node_modules breaks DSH startup:
#   request for '@deepseek-ai/cosmokit' is from a module not been linked
# The cordis loader refuses modules it has not linked, and an unpacked
# directory is not a registered profile dependency tree (profiles/ has no
# package.json). The supported mount is a symlink to the checkout — the
# adapter's write-path self-correction makes the module shadowing harmless.
# Install this way only after registering the package as a real profile
# dependency.
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
