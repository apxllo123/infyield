#!/bin/bash
# Build infyield-icon.icns from infyield-icon.svg.
#
# Edit the SVG, never the .icns — the SVG is the source of truth and this script
# regenerates every size macOS asks for.
#
#   ./scripts/build-icon.sh
#
# Rasterising needs a browser engine; Electron ships one, so no extra tooling
# (rsvg, imagemagick) is required. Rendering is done offscreen because a normal
# window is clamped to the physical display (that is what produced a lop-sided
# 2048x1804 icon once) — offscreen is not, so we get a supersampled square
# source and can downscale cleanly to every size.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

SVG="$ROOT/infyield-icon.svg"
OUT="$ROOT/infyield-icon.icns"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SVG" ] || { echo "✗ missing $SVG"; exit 1; }
[ -x "$ROOT/node_modules/.bin/electron" ] || { echo "✗ run npm install first (electron is required to rasterise)"; exit 1; }

echo "▶ Rendering $(basename "$SVG")..."
"$ROOT/node_modules/.bin/electron" "$ROOT/.freebuff/render-svg.cjs" "$SVG" 1024 "$WORK/source.png" 2>/dev/null \
  | grep -E "^rendered" || true

[ -s "$WORK/source.png" ] || { echo "✗ rasteriser produced no output"; exit 1; }

SRC_W=$(sips -g pixelWidth "$WORK/source.png" | awk '/pixelWidth/{print $2}')
SRC_H=$(sips -g pixelHeight "$WORK/source.png" | awk '/pixelHeight/{print $2}')
if [ "$SRC_W" != "$SRC_H" ] || [ "$SRC_W" -lt 512 ]; then
  echo "✗ expected a square source of at least 512px, got ${SRC_W}x${SRC_H}"
  exit 1
fi
echo "  source: ${SRC_W}x${SRC_H}"

# The directory name MUST end in `.iconset` — iconutil rejects it otherwise with
# a bare "Invalid Iconset" even when every PNG inside is correct.
mkdir -p "$WORK/icon.iconset"
# Every entry iconutil expects. Names are fixed — do not rename.
for spec in "16:icon_16x16" "32:icon_16x16@2x" "32:icon_32x32" "64:icon_32x32@2x" \
            "128:icon_128x128" "256:icon_128x128@2x" "256:icon_256x256" \
            "512:icon_256x256@2x" "512:icon_512x512" "1024:icon_512x512@2x"; do
  px="${spec%%:*}"
  name="${spec##*:}"
  # -Z scales proportionally and preserves alpha; never resample up.
  if [ "$px" -le "$SRC_W" ]; then
    sips -s format png -Z "$px" "$WORK/source.png" --out "$WORK/icon.iconset/$name.png" >/dev/null 2>&1
  else
    sips -s format png "$WORK/source.png" --out "$WORK/icon.iconset/$name.png" >/dev/null 2>&1
  fi
done

# ---------------------------------------------------------------- web icons --
# The tab favicon and the pinned/apple icon come from the SAME source as the
# .app icon, so they can never drift apart. Next's file conventions pick up
# src/app/icon.svg and src/app/apple-icon.png automatically.
#
# The favicon crops to the plate (viewBox 100 100 824 824): a favicon has no
# margin to spare, so the 100pt macOS padding would leave the mark tiny in a tab.
echo "▶ Emitting web icons..."
sed -e 's|width="1024" height="1024" viewBox="0 0 1024 1024"|width="64" height="64" viewBox="100 100 824 824"|' \
  "$SVG" > "$ROOT/src/app/icon.svg"
grep -q 'viewBox="100 100 824 824"' "$ROOT/src/app/icon.svg" || {
  echo "✗ couldn't rewrite the viewBox for src/app/icon.svg (did the <svg> tag change?)"
  exit 1
}
sips -s format png -Z 180 "$WORK/source.png" --out "$ROOT/src/app/apple-icon.png" >/dev/null 2>&1
echo "  src/app/icon.svg + apple-icon.png"

echo "▶ Packing iconset..."
iconutil -c icns "$WORK/icon.iconset" -o "$OUT"
echo "  wrote $(basename "$OUT") ($(du -h "$OUT" | cut -f1))"

# Verify the result is really an iconset (a truncated icns makes the Dock fall
# back to a generic icon).
iconutil -c iconset "$OUT" -o "$WORK/verify.iconset" >/dev/null 2>&1 || {
  echo "✗ $OUT did not round-trip as an icns"; exit 1
}
COUNT=$(ls "$WORK/verify.iconset" | wc -l | tr -d ' ')
[ "$COUNT" -ge 10 ] || { echo "✗ expected 10 sizes, got $COUNT"; exit 1; }

echo "✅ Icon built: $OUT ($COUNT sizes)"
