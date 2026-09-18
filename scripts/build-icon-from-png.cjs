/**
 * Build the Infyield icon master from the user's source PNG.
 *
 * Input:  /Users/apxllo/Downloads/7b5ed224-c39a-4583-8faf-eacf08c1363b.png
 *         (1254×1254, glass asterisk on a light backdrop, opaque)
 *
 * Output:
 *   assets/infyield-icon.png — 1024×1024 master: the squircle cropped
 *                         pixel-tight, corners masked with the macOS
 *                         rounded-rect alpha so the Dock shows the glass
 *                         shape itself, not a square photo with baked-in
 *                         backdrop corners. scripts/build-icon.sh derives
 *                         the .icns and every web favicon from it.
 *
 * macOS icon grid: the OS expects the artwork to *be* the rounded square; it
 * applies no additional cropping. Apple's own icons fill ~824/1024 of the
 * canvas with the plate carrying the corner radius — here the source IS the
 * plate at full bleed, so the master is 1024×1024 with a ~22.4% corner radius
 * (the macOS squircle ratio) applied as transparency.
 *
 * Temporary by design: this is a one-shot migration from the old SVG pipeline
 * to a PNG master. The generator script (build-icon.sh) keeps working from the
 * committed master afterwards.
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const SRC = "/Users/apxllo/Downloads/7b5ed224-c39a-4583-8faf-eacf08c1363b.png";
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "assets", "infyield-icon.png");

// The glass tile spans y 126..1192, x ~87..1196 (bluish-channel edge scans).
// Centre the 1054px crop on the TILE body (640, 659), not the earlier
// content bbox — that bbox included the white backing plate's halo above the
// tile, which then hugged the mask boundary as a white sliver. This centre
// puts the mask boundary 6px inside solid glass on the top/bottom and trims
// symmetric margins left/right; the alpha mask is additionally CHOKED inward
// so no backdrop or plate-white can survive at the edge. Verify with the
// neutral-white scan: all four sides must report ~0 plate pixels.
const CENTRE = { x: 640, y: 659 };
const EDGE = 1054; // full width of the squircle, measured edge to edge
const CHOKE = 3;   // px shaved off the mask on every side (of 1024)
const HALF = Math.round(EDGE / 2); // 528

// macOS squircle: corner radius ≈ 22.37% of the icon size.
const RADIUS_RATIO = 0.2237;

(async () => {
  const SIZE = 1024;

  // 1 — crop tight to the squircle (centre-true), supersample the mask.
  const crop = {
    left: Math.round(CENTRE.x - HALF),
    top: Math.round(CENTRE.y - HALF),
    width: EDGE,
    height: EDGE,
  };

  // 2 — rounded-rect alpha mask at the OUTPUT size (composite input must be
  //     ≤ the composited image), supersampled 2× then downscaled by sharp's
  //     density trick for clean corners. The rect is inset by CHOKE so the
  //     outermost CHOKE px of the crop — where backdrop halo lives — go fully
  //     transparent instead of showing a white ring in the Dock.
  const S2 = SIZE * 2;
  const r = Math.round(S2 * RADIUS_RATIO);
  const inset = CHOKE * 2; // mask is authored at 2×
  const mask = Buffer.from(
    `<svg width="${S2}" height="${S2}"><rect x="${inset}" y="${inset}" width="${S2 - inset * 2}" height="${S2 - inset * 2}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  );
  const maskResized = await sharp(mask, { density: 72 })
    .resize(SIZE, SIZE)
    .png()
    .toBuffer();

  const master = await sharp(SRC)
    .extract(crop)
    .resize(SIZE, SIZE)
    .composite([{ input: maskResized, blend: "dest-in" }])
    .png()
    .toBuffer();

  fs.writeFileSync(OUT, master);

  console.log(`wrote assets/infyield-icon.png (1024) from ${EDGE}px square @ (${crop.left},${crop.top})`);
})().catch((e) => { console.error(e); process.exit(1); });
