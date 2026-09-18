#!/bin/bash
# Build Infyield.app for macOS (arm64).
# Layout note (fixes "Cannot find module .../Resources/app/index.js"):
# electron-packager copies the STAGED DIR into Contents/Resources/app and reads
# its package.json "main" as the Electron entry. So the stage root must contain
# package.json + electron/main.js, with the standalone Next server nested under
# server/ — NOT one level up in Resources.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# The release build lives in its own distDir so a concurrent `next dev` (which
# the in-app agent can start) cannot rewrite the assets we are about to ship.
DIST_DIR="${INFYIELD_DIST_DIR:-.next-release}"
export INFYIELD_DIST_DIR="$DIST_DIR"

echo "▶ Building Next.js standalone into $DIST_DIR..."
rm -rf "$ROOT/$DIST_DIR"
npm run build
if [ ! -f "$DIST_DIR/standalone/server.js" ]; then
  echo "Standalone output missing — enable output:'standalone' in next.config.ts"
  exit 1
fi

# Fail loudly rather than shipping a server with no styles/scripts on disk: a
# clobbered build once produced an unstyled app that still "started fine".
if ! ls "$DIST_DIR"/static/css/*.css >/dev/null 2>&1; then
  echo "✗ No CSS in $DIST_DIR/static — the build is incomplete; not packaging it."
  exit 1
fi

STAGE="$ROOT/release/stage"
rm -rf "$ROOT/release"
# The staged tree must mirror the distDir baked into the build's
# required-server-files.json: the standalone server resolves its own assets
# under <distDir>/static, so staging them at .next/static instead makes every
# /_next/static request 404 and the UI render unstyled.
mkdir -p "$STAGE/electron" "$STAGE/server/$DIST_DIR/static" "$STAGE/server/.data"

# Server tree nested INSIDE the electron app: server/server.js
cp -R "$ROOT/$DIST_DIR/standalone/." "$STAGE/server/"
# The standalone output can carry a build-time .data directory (any server run
# in the repo before packaging writes its ledger there, and `next build` copies
# the whole project tree). It must never ship: a bundled ledger is fake money
# that springs into existence for anyone running the packaged server directly.
# The empty $STAGE/server/.data above stays as the fallback for exactly that.
rm -rf "$STAGE/server/.data"
mkdir -p "$STAGE/server/.data"
cp -R "$ROOT/$DIST_DIR/static/." "$STAGE/server/$DIST_DIR/static/"
mkdir -p "$STAGE/server/public"

# Verify the staged tree can actually serve its assets before we package it.
if ! ls "$STAGE/server/$DIST_DIR/static/css"/*.css >/dev/null 2>&1; then
  echo "✗ Staged app has no CSS — aborting."
  exit 1
fi

# Electron app root = stage root. The whole directory goes in — main.js plus
# preload.js (the folder-picker bridge); a file list here would silently drop
# the next file someone adds beside them.
cp -R "$ROOT/electron/." "$STAGE/electron/"
cat > "$STAGE/package.json" <<'EOF'
{
  "name": "infyield",
  "productName": "Infyield",
  "version": "0.1.0",
  "main": "electron/main.js"
}
EOF

echo "▶ Packaging with Electron..."
cd "$STAGE"
# The packager is pinned as a devDependency (18.3.6): packaging runs from the
# local install instead of `npx --yes` resolving latest at build time, so a
# release is reproducible and needs no network. Fail loudly if node_modules is
# missing rather than silently falling back to a fetch.
PACKAGER="$ROOT/node_modules/.bin/electron-packager"
if [ ! -x "$PACKAGER" ]; then
  echo "✗ electron-packager not found at $PACKAGER — run 'npm install' first."
  exit 1
fi
"$PACKAGER" . Infyield \
  --platform=darwin --arch=arm64 \
  --out="$ROOT/release" \
  --overwrite \
  --app-bundle-id=com.infyield.app

APP="$ROOT/release/Infyield-darwin-arm64/Infyield.app"

# Icon: some packager versions ignore --icon; patch the bundle directly.
cp "$ROOT/infyield-icon.icns" "$APP/Contents/Resources/infyield.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile infyield" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string infyield" "$APP/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile infyield" "$APP/Contents/Info.plist"

if ! ls "$APP/Contents/Resources/app/server/$DIST_DIR/static/css"/*.css >/dev/null 2>&1; then
  echo "✗ Packaged app is missing its static assets — the UI would render unstyled."
  exit 1
fi

echo "▶ Codesigning (adhoc) for local launch..."
codesign --force --deep --sign - "$APP" 2>/dev/null || true

rm -rf "$STAGE"
echo ""
echo "✅ Built: $APP"
echo "   Open with: open \"$APP\""
echo "   Install:   cp -R \"$APP\" /Applications/"
