#!/bin/bash
# Build Infyield.app from a staging tree OUTSIDE iCloud Drive.
#
# Why this exists: on a Mac with "Desktop & Documents Folders" synced, this
# project lives inside iCloud Drive. iCloud then evicts and re-materialises files
# on demand, and a bulk read of the tree can either return a file mid-write or
# block indefinitely. Both were observed here, and they do not look like sync
# problems from the outside:
#
#   next build  ->  Error: Invalid package config …/next/dist/compiled/zod/package.json
#                   (ERR_INVALID_PACKAGE_CONFIG, a different file every attempt)
#                or: hangs before printing its banner, at ~0s CPU
#   rsync       ->  hangs part-way with no error
#   next dev    ->  never prints, never listens
#
# The files themselves are fine — re-reading one after the failure always shows
# valid content, and `tsc --noEmit` passes — which is the tell that it is the
# read that is unreliable, not the file.
#
# So: stage the sources into a temp dir with `tar` (which streamed the whole tree
# reliably when rsync could not), install dependencies there, and run the normal
# build. The packaged .app is copied back, and it is identical to what build-app.sh
# produces in place — this only changes WHERE the compiling happens.
#
# Usage:  ./scripts/build-app-safe.sh [--install]
#   --install   also replace ~/Applications/Infyield.app with the new bundle
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${INFYIELD_BUILD_STAGE:-$(mktemp -d "${TMPDIR:-/tmp}/infyield-build.XXXXXX")}"
INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1

echo "▶ Staging sources into $STAGE (outside iCloud)"
mkdir -p "$STAGE"

# Streamed, not copied file-by-file: tar read the whole tree where rsync stalled.
#
# The paths are listed explicitly rather than archiving `.` because bsdtar aborts
# with "Special header too large: %llu" on the oversized iCloud extended
# attributes that ride along on synced files.
( cd "$ROOT" && tar cf - \
    src scripts electron \
    package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs \
    next-env.d.ts LICENSE NOTICE README.md ) | tar xf - -C "$STAGE"

# The icon is not part of the source tree but build-app.sh patches it into the bundle.
for icon in infyield-icon.icns infyield-icon.jpg infyield-icon.svg; do
  [ -f "$ROOT/$icon" ] && cp "$ROOT/$icon" "$STAGE/" || true
done

if [ ! -d "$STAGE/node_modules" ]; then
  echo "▶ Installing dependencies in the staging tree (npm ci)"
  ( cd "$STAGE" && npm ci --prefer-offline --no-audit --no-fund )
fi

# Stage into the same distDir the real build uses, so the packaged layout matches.
echo "▶ Building the app bundle"
( cd "$STAGE" && INFYIELD_DIST_DIR=.next-release ./scripts/build-app.sh )

APP="$STAGE/release/Infyield-darwin-arm64/Infyield.app"
[ -d "$APP" ] || { echo "✗ No bundle produced at $APP"; exit 1; }

echo ""
echo "✅ Built: $APP"

if [ "$INSTALL" = "1" ]; then
  DEST="$HOME/Applications/Infyield.app"
  echo "▶ Installing to $DEST"
  # Two patterns, because the main process retitles itself to just "Infyield"
  # (electron/main.js re-asserts the name after the server boots) — a pkill by
  # bundle path alone misses it, and the install then leaves the OLD bundle
  # running while the new one sits on disk unloading.
  pkill -f "Infyield.app" 2>/dev/null || true
  pkill -x "Infyield" 2>/dev/null || true
  sleep 1
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  echo "✅ Installed: $DEST  (staging tree left at $STAGE)"
else
  echo "   Install with: $0 --install"
fi
