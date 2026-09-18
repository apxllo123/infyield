import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { getSettings } from "./settings";

/**
 * Access control for the HTTP surface.
 *
 * Every route used to carry its own copy of the same `adminOk` check, which is
 * how two of them ended up with no check at all and why "set a password" was
 * only half a policy. There is one rule now, and one place that states it:
 *
 * ```
 *   a password is set   →  a matching Bearer token is the only way in
 *   no password is set  →  the request must have come from this machine
 * ```
 *
 * The second half is the important one. The shipped default has no password, and
 * a default that says "everything is open" is a default that is open on whatever
 * network the machine happens to be on. So an unauthenticated install accepts
 * requests only when the request *claims* to be local, and the deployment binds
 * to loopback (`-H 127.0.0.1` in the npm scripts, `HOSTNAME=127.0.0.1` in the
 * Electron shell) so that a remote client cannot reach the port to claim
 * anything at all.
 *
 * ## What the loopback check is, and is not
 *
 * A `Host` header is a *claim*, not a fact: route handlers do not get the peer
 * socket address, and a proxy can rewrite whatever it likes. This check is
 * therefore **defence in depth layered on top of the loopback bind** — it stops
 * a DNS-rebinding page or a misconfigured proxy from reaching an unauthenticated
 * install, but the bind is what actually keeps other machines out. That is why
 * the refusal below names the password *and* the bind, rather than implying the
 * header check is a substitute for either.
 *
 * `Origin` is checked too, when present: a browser sends it for cross-origin and
 * for non-GET same-origin requests, so its absence is normal and its presence is
 * evidence worth using.
 */

/** A value that already carries a scheme, e.g. an `Origin` header. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/** Names a request may legitimately use to reach this machine's own ports. */
const LOOPBACK_LITERAL = new Set(["localhost", "::1"]);

/**
 * The hostname a `Host` header or an `Origin` header names, with the port and any
 * IPv6 brackets removed.
 *
 * Both shapes have to work, and they are not the same shape: a `Host` is a bare
 * authority (`127.0.0.1:3777`) while an `Origin` is a full URL
 * (`http://127.0.0.1:3777`). Parsing one as the other is silent — every origin
 * becomes unparseable and therefore "not local" — so both are attempted, and a
 * value that parses as neither returns `""`, which callers treat as "not local"
 * rather than as "unknown, so allow".
 */
function hostnameOf(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  // Deciding by shape, not by trial and error: `http://http://127.0.0.1:3777`
  // does not throw, it parses with the hostname `http`, so a "try one shape, fall
  // back on an exception" approach silently returns the wrong answer instead of
  // trying the other shape.
  const candidate = HAS_SCHEME.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(candidate).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True only for an address that is this machine.
 *
 * The whole 127/8 block is loopback, so it is matched as a range rather than as
 * the single literal `127.0.0.1`. Anything that merely *contains* a loopback
 * address — `127.0.0.1.example.com`, `127.0.0.1@attacker.example` — is a
 * different host and is refused, because the parser resolves those to the real
 * hostname before this sees them.
 */
export function isLoopbackHostname(authority: string): boolean {
  const name = hostnameOf(authority);
  if (!name) return false;
  if (LOOPBACK_LITERAL.has(name)) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** Whether this request may be treated as coming from this machine. */
export function isLoopbackRequest(req: NextRequest): boolean {
  if (!isLoopbackHostname(req.headers.get("host") ?? "")) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  // `null` is what a sandboxed frame or a `file://` page sends, and neither has
  // any business reaching an unauthenticated server.
  if (origin.trim().toLowerCase() === "null") return false;
  return isLoopbackHostname(origin);
}

/** The token from an `Authorization: Bearer …` header, or `""`. */
function bearerToken(req: NextRequest): string {
  const header = (req.headers.get("authorization") ?? "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

/**
 * Compare two secrets without leaking their length or content through timing.
 *
 * A length mismatch has to return early (the comparison primitive requires equal
 * lengths), but the length of a password is not the secret worth protecting, and
 * every comparison that matters is against a value the caller had to know in
 * full to reach.
 *
 * An empty value never matches, on either side: "no password configured" must
 * not be satisfied by "no token presented". Exported because the OAuth flow
 * compares a nonce against its stored value and should do it the same way — one
 * comparison, one implementation.
 */
export function secureEquals(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The refusal for a request that is neither authenticated nor local.
 *
 * It names both halves of the rule, because an operator hitting this needs to
 * know which one to change, and it deliberately does not say *which* of the two
 * checks failed beyond that — a caller probing the surface learns nothing about
 * the configuration.
 */
function notLocal(): Response {
  return Response.json(
    {
      error:
        "This request did not come from this machine, and no password is set. Set an admin or API password in Settings → Privacy, or reach the server from localhost.",
      code: "not-local",
    },
    { status: 403 },
  );
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Guard for the operator surfaces: settings, keys, campaigns, payments, payouts,
 * the ledger, the workspace listing and health.
 *
 * Returns `null` when the request may proceed, or the response to send when it
 * may not, so a route reads as one line rather than as a block:
 *
 * ```ts
 * const denied = requireAdmin(req);
 * if (denied) return denied;
 * ```
 */
export function requireAdmin(req: NextRequest): Response | null {
  const password = getSettings().adminPassword.trim();
  if (password) return secureEquals(bearerToken(req), password) ? null : unauthorized();
  if (isLoopbackRequest(req)) return null;
  return notLocal();
}

/**
 * Guard for the model surfaces: `/api/chat`, `/api/models` and the
 * OpenAI-compatible `/v1` endpoints.
 *
 * The API password is a separate secret from the admin one on purpose: a program
 * pointed at this server can be given the ability to hold a conversation without
 * also being given the ability to change the deployment.
 */
export function requireApi(req: NextRequest): Response | null {
  const password = getSettings().apiPassword.trim();
  if (password) return secureEquals(bearerToken(req), password) ? null : unauthorized();
  if (isLoopbackRequest(req)) return null;
  return notLocal();
}

/**
 * Whether the deployment is currently protected by anything at all.
 *
 * Read by the startup warning and by Settings, so the two cannot disagree about
 * whether "no password" means "no protection".
 */
export function protectionState(): { admin: boolean; api: boolean } {
  const s = getSettings();
  return { admin: s.adminPassword.trim().length > 0, api: s.apiPassword.trim().length > 0 };
}

/**
 * The port from a `Host`/`Origin` authority, or `""` when there is none.
 *
 * Only the port is ever taken from a request. It identifies which of this
 * machine's listening sockets the caller reached, and unlike a hostname it cannot
 * be used to redirect a credential somewhere else.
 */
function portFromAuthority(authority: string): string {
  try {
    const port = new URL(`http://${authority.trim()}`).port;
    return /^\d{1,5}$/.test(port) ? port : "";
  } catch {
    return "";
  }
}

/**
 * The origin this deployment answers on, for the URLs it has to hand out — the
 * OAuth callback and the page the browser lands on afterwards.
 *
 * Configuration first, and a request's `Host` is *never* trusted for the
 * hostname: a `callback_url` built from that header would deliver the user's
 * authorization code to whoever set it. `INFYIELD_PUBLIC_ORIGIN` is how a
 * deployment behind a tunnel or a proxy says what its real address is; without
 * it, the answer is loopback, which is where a local install actually lives.
 */
export function localOrigin(req?: NextRequest): string {
  const configured = (process.env.INFYIELD_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const port = portFromAuthority(req?.headers.get("host") ?? "") || (process.env.PORT ?? "").trim();
  return `http://127.0.0.1${/^\d{1,5}$/.test(port) ? `:${port}` : ""}`;
}

/**
 * Whether a request came from an origin this deployment claims as its own: this
 * machine, or the public origin the operator configured.
 *
 * Used by the one endpoint that cannot carry a token — the OAuth callback, which
 * arrives as a browser redirect from OpenRouter — so that "unauthenticated
 * because it has to be" does not become "reachable from anywhere".
 */
export function isTrustedOriginRequest(req: NextRequest): boolean {
  if (isLoopbackRequest(req)) return true;
  const configured = (process.env.INFYIELD_PUBLIC_ORIGIN ?? "").trim();
  if (!configured) return false;
  try {
    return (req.headers.get("host") ?? "").trim().toLowerCase() === new URL(configured).host.toLowerCase();
  } catch {
    return false;
  }
}

let warned = false;

/**
 * Say it once, at startup, when nothing is protected.
 *
 * A security posture that is only discoverable by reading the source is one an
 * operator will not know about, and "it worked fine on my laptop" is exactly how
 * an open local server ends up on a shared network.
 */
export function warnIfUnprotected(): void {
  if (warned) return;
  warned = true;
  const { admin, api } = protectionState();
  if (admin && api) return;
  const missing = [admin ? null : "admin", api ? null : "API"].filter(Boolean).join(" and ");
  console.warn(
    `[infyield] No ${missing} password is set. Requests are accepted from loopback only — ` +
      "make sure the server is bound to 127.0.0.1, or set a password in Settings → Privacy to allow other hosts.",
  );
}
