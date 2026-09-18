import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import Atmosphere from "@/components/Atmosphere";
import TopNav from "@/components/TopNav";

export const metadata: Metadata = {
  title: "Infyield — the free, ad-funded coding agent",
  description: "An open, self-hosted Freebuff-style coding agent. Inline text ads fund the API keys; users never need tokens.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
          The macOS shell draws its traffic lights over the web content, so the
          page reserves a title-bar band for them (--nav-top in globals.css).

          This has to be decided in the renderer, not on the server: these
          routes are statically prerendered at build time, which happens in the
          repo rather than inside the .app, so any server-side check would be
          baked in as "not the desktop app" and never correct itself. The script
          runs before first paint, so there is no flash of an unshifted layout.
        */}
        <Script id="shell-detect" strategy="beforeInteractive">
          {`if(/Electron/i.test(navigator.userAgent))document.documentElement.dataset.shell='mac'`}
        </Script>
        <Atmosphere />
        <div className="titlebar-drag" aria-hidden="true" />
        {/*
          Scrim for the floating nav. The capsule is translucent, so page
          content scrolling underneath stays fully legible through it and reads
          as a collision rather than as depth. This band dims what passes behind
          the nav and fades out below it — a plain gradient, deliberately not a
          backdrop-filter, which on a transformed element samples the wrong box.
        */}
        <div className="nav-scrim" aria-hidden="true" />
        <TopNav />
        <div className="shell">
          <div
            className="shell-inner"
            style={{ paddingTop: "calc(var(--nav-top) + var(--nav-h) + var(--nav-gap))", paddingBottom: "var(--s-9)" }}
          >
            {children}
          </div>
        </div>
      </body>
    </html>
  );
}
