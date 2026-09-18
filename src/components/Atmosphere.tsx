/**
 * The atmospheric canvas every page floats on.
 *
 * Layered, in order: ink base → drifting colour fields → masked grid → grain →
 * scrim → vignette. Each layer is barely visible on its own; together they give
 * the interface depth and a focal point without ever competing with text.
 * Pure CSS and inline SVG — no image assets to ship.
 */
export default function Atmosphere() {
  return (
    <div className="atmo" aria-hidden="true">
      {/* Focal light: mint from the upper right, cyan lower left, violet rim.
          Cinematic tuning: tighter, brighter pools so they read as practical
          light sources over the deeper ink, like the Wallspace reference. */}
      <div
        className="atmo-glow"
        style={{
          top: "-30vh",
          right: "-12vw",
          width: "62vw",
          height: "62vw",
          background: "radial-gradient(circle at 50% 50%, rgba(53,224,161,0.46), rgba(53,224,161,0.09) 42%, transparent 66%)",
          animation: "au-drift 26s var(--ease) infinite",
        }}
      />
      <div
        className="atmo-glow"
        style={{
          bottom: "-38vh",
          left: "-16vw",
          width: "66vw",
          height: "66vw",
          background: "radial-gradient(circle at 50% 50%, rgba(70,200,232,0.36), rgba(70,200,232,0.07) 45%, transparent 68%)",
          animation: "au-drift-slow 34s var(--ease) infinite",
        }}
      />
      <div
        className="atmo-glow"
        style={{
          top: "16vh",
          left: "20vw",
          width: "42vw",
          height: "42vw",
          background: "radial-gradient(circle at 50% 50%, rgba(139,123,240,0.28), transparent 64%)",
          animation: "au-drift 30s var(--ease) infinite reverse",
        }}
      />

      {/* Structure: a masked grid that fades out before it reaches the edges */}
      <div className="atmo-grid" />

      {/* Scrim: keeps the top band and the lower half legible */}
      <div
        className="atmo-scrim"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,6,10,0.82) 0%, rgba(6,6,10,0.28) 18%, rgba(6,6,10,0.5) 46%, rgba(6,6,10,0.9) 78%, var(--ink-0) 100%)",
        }}
      />
      {/* The page reads as one continuous surface: the light fades out as you
          scroll into content instead of stopping at a hard edge. */}
      <div className="atmo-grain" />
      <div className="atmo-vignette" />
    </div>
  );
}
