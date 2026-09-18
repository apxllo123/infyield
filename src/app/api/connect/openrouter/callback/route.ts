import { NextRequest, NextResponse } from "next/server";
import { BINDING_COOKIE, BINDING_COOKIE_PATH, completeOpenRouterRedirect } from "@/lib/connect";
import { isTrustedOriginRequest, localOrigin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * OpenRouter redirects here with ?code=… and ?state=… after the user authorizes.
 * We exchange the code for a real credential, provision it server-side, then
 * bounce back into the app so the connect flow feels like one click and needs no
 * copy-paste.
 *
 * This is the one write path that cannot require the admin password: it arrives
 * as a browser redirect from OpenRouter's side of the flow. Three things stand
 * in for the password, and they are stated here because their absence would look
 * like an oversight:
 *
 *  1. **Only a trusted origin may reach it.** A local install accepts this from
 *     this machine only; `INFYIELD_PUBLIC_ORIGIN` adds the one public address a
 *     proxied deployment declares as its own.
 *  2. **The exchange needs our PKCE verifier.** A `code` is only redeemable
 *     against the `code_challenge` sent when the flow started, and that verifier
 *     is generated in-process. A code an attacker obtained elsewhere fails the
 *     exchange, so this endpoint cannot be used to provision a credential of
 *     somebody else's choosing.
 *  3. **The redirect is bound to the browser that started it.** `state` must come
 *     back and match, and the `HttpOnly` binding cookie set by
 *     `GET /api/connect/openrouter` must match too — a cross-site attacker can
 *     forge a query string but cannot set a cookie for this origin. Both checks
 *     and the single-use rule live in `completeOpenRouterRedirect`, which is the
 *     one place that decides whether a redirect is allowed to provision
 *     anything.
 *
 * The redirect target is this deployment's own origin, never the request's Host
 * header, so a forged Host cannot turn this into an open redirect.
 */
export async function GET(req: NextRequest) {
  if (!isTrustedOriginRequest(req)) {
    return NextResponse.json(
      {
        error: "This callback must be completed from this machine, or from the origin in INFYIELD_PUBLIC_ORIGIN.",
        code: "not-local",
      },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const binding = req.cookies.get(BINDING_COOKIE)?.value ?? "";
  const origin = localOrigin(req);

  const res = await completeOpenRouterRedirect({ code, state, binding });

  // The binding is spent either way, so it goes even when the exchange worked:
  // a cookie left on disk is a credential, and this one has no future use.
  const back = NextResponse.redirect(
    res.ok
      ? `${origin}/?connect=ok`
      : `${origin}/?connect=error&reason=${encodeURIComponent(res.error)}`,
    302,
  );
  back.cookies.set(BINDING_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: BINDING_COOKIE_PATH,
    maxAge: 0,
  });
  return back;
}
