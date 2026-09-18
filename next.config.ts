import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output lets the macOS .app bundle a self-contained server.
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // A release build gets its own directory. `next dev` rewrites .next in place,
  // and the in-app agent may well start one — sharing a directory would let it
  // clobber the assets the packaged app serves (that is exactly how a shipped
  // bundle ended up with an unstyled UI). scripts/build-app.sh sets this.
  distDir: process.env.INFYIELD_DIST_DIR || ".next",
  // Keep the dev-mode badge off: it floats over the sidebar's economy footer.
  devIndicators: false,
  // The workspace route's folder picker reaches the running Electron main
  // process through `require("electron")`. Without this, webpack bundles the
  // npm `electron` package — whose index.js is just a string pointing at the
  // downloaded binary — so the route could never see the real module and the
  // native folder dialog silently degraded to a typed path. Externalized, the
  // require happens at runtime, where Electron's own module resolver answers it.
  serverExternalPackages: ["electron"],
};

export default nextConfig;
