import { NextRequest, NextResponse } from "next/server";
import {
  BINDING_COOKIE,
  BINDING_COOKIE_MAX_AGE,
  BINDING_COOKIE_PATH,
  beginOpenRouterConnect,
  completeOpenRouterConnect,
  hasPendingConnect,
} from "@/lib/connect";
import { localOrigin, requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * GET  → the OpenRouter authorize URL (one click, no copy-paste).
 *        `?headless=1` omits the callback so OpenRouter shows a code to paste.
 * POST → exchange that pasted/redirected code for a key and provision it.
 *
 * Both are operator actions, so both require the admin password — and the
 * callback URL is built from this deployment's own origin rather than from the
 * request. The authorize URL contains the PKCE `code_challenge`, which is what
 * makes the code useless to anyone who does not also hold the verifier, so it is
 * not something an unauthenticated caller should be able to read.
 *
 * The redirect flow also gets the binding cookie set here — the secret the
 * callback checks against, delivered to the browser that started the flow and to
 * no one else. `SameSite=Lax` is what keeps it attached across the cross-site
 * navigation OpenRouter sends the user back with; `HttpOnly` keeps page script
 * from reading it; the path is the connect endpoints so it is not sent with
 * every other request.
 */
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const headless = new URL(req.url).searchParams.get("headless") === "1";
  const callback = headless ? undefined : `${localOrigin(req)}/api/connect/openrouter/callback`;
  const authorize = await beginOpenRouterConnect(callback);

  const res = NextResponse.json({
    url: authorize.url,
    headless,
    pending: hasPendingConnect(),
  });
  if (authorize.binding) {
    res.cookies.set(BINDING_COOKIE, authorize.binding, {
      httpOnly: true,
      sameSite: "lax",
      path: BINDING_COOKIE_PATH,
      maxAge: BINDING_COOKIE_MAX_AGE,
    });
  }
  return res;
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { code?: string };
  const res = await completeOpenRouterConnect(b.code ?? "");
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, provider: "openrouter", label: res.label });
}
