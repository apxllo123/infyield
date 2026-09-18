/**
 * The hero artifact: an abstract rendering of what Infyield does — a stack of
 * glass planes (the agent's surface) with a mint signal passing through them
 * (the flow that pays for itself). Built from CSS layers only, so it stays
 * crisp at any size and costs nothing to ship.
 */
export default function HeroVisual() {
  return (
    <div className="relative aspect-[5/4] w-full select-none" aria-hidden="true">
      {/* Halo behind the artifact */}
      <div
        className="absolute inset-[6%] rounded-full opacity-80"
        style={{
          background: "radial-gradient(circle at 62% 38%, rgba(53,224,161,0.32), rgba(70,200,232,0.14) 45%, transparent 72%)",
          filter: "blur(42px)",
        }}
      />

      {/* Orbit rings */}
      <div
        className="absolute inset-[10%] rounded-full border border-[rgba(255,255,255,0.07)]"
        style={{ animation: "au-spin-slow 90s linear infinite" }}
      >
        <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--mint)] shadow-[0_0_18px_4px_rgba(53,224,161,0.5)]" />
      </div>
      <div className="absolute inset-[20%] rounded-full border border-[rgba(255,255,255,0.05)]" />

      {/* The glass stack: three planes in perspective.
          NOTE: do not put `backdrop-filter` on these. Chromium samples the
          backdrop over the element's *untransformed* box, so a rotated plane
          leaves a hard axis-aligned rectangle of blurred backdrop floating
          over the page. Depth comes from the fills, borders and shadows. */}
      <div className="absolute inset-0 grid place-items-center" style={{ perspective: "1200px" }}>
        <div className="relative h-[62%] w-[74%]" style={{ transformStyle: "preserve-3d", transform: "rotateX(46deg) rotateZ(-26deg)" }}>
          {[
            { z: 0, o: 0.5 },
            { z: 34, o: 0.74 },
            { z: 68, o: 1 },
          ].map((plane, i) => (
            <div
              key={i}
              className="absolute inset-0 rounded-[var(--r-lg)] border border-[var(--border-2)]"
              style={{
                transform: `translateZ(${plane.z}px)`,
                background: `linear-gradient(150deg, rgba(255,255,255,${0.11 * plane.o}), rgba(255,255,255,${0.022 * plane.o}) 62%, rgba(53,224,161,${0.05 * plane.o}))`,
                boxShadow: `0 44px 96px -56px rgba(0,0,0,0.95), inset 0 1px 0 rgba(255,255,255,${0.16 * plane.o})`,
              }}
            />
          ))}
          {/* The signal: a mint trace crossing the top plane */}
          <div className="absolute inset-0 overflow-hidden rounded-[var(--r-lg)]" style={{ transform: "translateZ(69px)" }}>
            <svg viewBox="0 0 300 220" className="h-full w-full" fill="none">
              <defs>
                <linearGradient id="hero-trace" x1="10" y1="180" x2="290" y2="40" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#46c8e8" stopOpacity="0.15" />
                  <stop offset="0.55" stopColor="#35e0a1" stopOpacity="0.9" />
                  <stop offset="1" stopColor="#35e0a1" />
                </linearGradient>
                <linearGradient id="hero-area" x1="0" y1="220" x2="0" y2="60" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#35e0a1" stopOpacity="0" />
                  <stop offset="1" stopColor="#35e0a1" stopOpacity="0.16" />
                </linearGradient>
              </defs>
              <path d="M8 186 L62 150 L104 168 L150 108 L204 124 L292 44 L292 220 L8 220 Z" fill="url(#hero-area)" />
              <path d="M8 186 L62 150 L104 168 L150 108 L204 124 L292 44" stroke="url(#hero-trace)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="150" cy="108" r="3.4" fill="#35e0a1" />
              <circle cx="292" cy="44" r="4.4" fill="#35e0a1" />
              <circle cx="292" cy="44" r="10" fill="#35e0a1" fillOpacity="0.18" />
            </svg>
          </div>
        </div>
      </div>

      {/* Specular sweep across the whole artifact (clipped to the artifact, not
          to a rectangle — no backdrop sampling involved). */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
        <div
          className="absolute -inset-y-10 w-1/3"
          style={{
            background: "linear-gradient(100deg, transparent, rgba(255,255,255,0.07), transparent)",
            animation: "au-sheen 9s var(--ease) infinite",
          }}
        />
      </div>
    </div>
  );
}
