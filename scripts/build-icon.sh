#!/bin/bash
# Build infyield-icon.icns + the web/app icons from assets/infyield-icon.png.
#
# The PNG master is the source of truth (1024×1024, artwork cropped tight to
# the squircle, corners masked transparent at the macOS 22.37% radius — see
# scripts/build-icon-from-png.cjs, the one-shot migration that produced it from
# the designer's file). Edit the master, never the .icns.
#
#   ./scripts/build-icon.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

PNG="$ROOT/assets/infyield-icon.png"
OUT="$ROOT/infyield-icon.icns"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$PNG" ] || { echo "✗ missing $PNG"; exit 1; }

W=$(sips -g pixelWidth "$PNG" | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$PNG" | awk '/pixelHeight/{print $2}')
[ "$W" = "$H" ] || { echo "✗ master must be square, got ${W}x${H}"; exit 1; }
[ "$W" -ge 1024 ] || { echo "✗ master must be ≥1024px, got $W"; exit 1; }

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
  if [ "$px" -le "$W" ]; then
    sips -s format png -Z "$px" "$PNG" --out "$WORK/icon.iconset/$name.png" >/dev/null 2>&1
  else
    sips -s format png "$PNG" --out "$WORK/icon.iconset/$name.png" >/dev/null 2>&1
  fi
done

# ---------------------------------------------------------------- web icons --
# The tab favicon and the pinned/apple icon come from the SAME master as the
# .app icon, so they can never drift apart. Next's file conventions pick up
# src/app/icon.png and src/app/apple-icon.png automatically.
node -e '
const sharp = require("sharp");
sharp("assets/infyield-icon.png").resize(64, 64).png().toFile("src/app/icon.png").catch((e) => { console.error(e); process.exit(1); });
'
sips -s format png -Z 180 "$PNG" --out "$ROOT/src/app/apple-icon.png" >/dev/null 2>&1
sips -s format png -Z 180 "$PNG" --out "$ROOT/apple-touch-icon.png" >/dev/null 2>&1
echo "▶ Emitted web icons: src/app/icon.png, apple-icon.png, apple-touch-icon.png"

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
