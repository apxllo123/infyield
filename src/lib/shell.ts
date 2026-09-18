import path from "node:path";

/**
 * Detecting the packaged macOS app, server-side.
 *
 * The `.app` serves its own Next build in-process, so the server can tell it is
 * running inside a bundle from its own cwd. `settings.ts` uses this to refuse
the bundle directory as the agent's workspace.
 *
 * NOTE: this is deliberately *not* how the UI decides whether to reserve the
 * native title-bar band. These routes are statically prerendered at build time
 * (which happens in the repo, not the bundle), so a server-side check would be
 * baked in as "not the app" and never correct itself. The renderer decides that
 * instead, from its own user agent, before first paint — see `layout.tsx`.
 */
const BUNDLE_MARKER = ".app/Contents/Resources";

export function isAppBundle(dir: string = process.cwd()): boolean {
  return dir.includes(BUNDLE_MARKER);
}

/** The folder the packaged app should treat as a workspace instead of its bundle. */
export function bundleWorkspaceFallback(home: string): string {
  return path.join(home, "Infyield");
}
