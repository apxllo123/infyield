import { provisionCredential } from "./credentials";
import { readJson, writeJson } from "./store";
import { secureEquals } from "./auth";

// One-click OpenRouter onboarding (OAuth 2.0 + PKCE), the documented flow:
//   1. send the browser to https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256
//   2. the user authorizes; OpenRouter redirects back with ?code=…
//   3. POST https://openrouter.ai/api/v1/auth/keys {code, code_verifier, code_challenge_method} → { key }
// The minted credential is written server-side, so no copy-paste and no per-chat
// setup. Omit callback_url for the headless variant, where OpenRouter shows the
// code on screen and the operator pastes it into the app instead.
//
// ## What stops someone else's redirect from provisioning a credential
//
// Three things, and they fail in different ways, so all three are here:
//
//  1. **PKCE.** The `/auth` URL carries a `code_challenge`; the verifier that
//     satisfies it is generated in this process and never leaves it. A code
//     minted against somebody else's challenge cannot be exchanged — OpenRouter
//     answers 403 `Invalid code or code_verifier` and nothing is written.
//  2. **A `state` nonce**, sent with the authorize URL and required back at the
//     callback. Note this is *us* sending it: OpenRouter's published parameter
//     list (openrouter.ai/docs → OAuth PKCE) names `callback_url`,
//     `code_challenge`, `code_challenge_method`, `key_label`, `workspace_id` and
//     `required_workspace_id`, and does not list `state`. If the parameter is
//     dropped in transit the redirect is refused with a diagnostic instead of
//     quietly proceeding unprotected — see `completeOpenRouterRedirect`.
//  3. **A binding cookie**, which is the check that does not depend on the
//     provider's behaviour at all. See below.
//
// ## Why the cookie, given 1 and 2 already
//
// `state` only works if the provider echoes it. The cookie works because
// cookies are scoped to the origin, and a browser reaching this server from
// anywhere else cannot set one for it. When a flow starts we mint a secret that
// appears in **no URL** — not the authorize URL, not the redirect, not browser
// history — and hand it to the browser in an HttpOnly cookie scoped to this
// callback path. A cross-site attacker can forge the query string but cannot
// forge the cookie, so the redirect is bound to the browser that started it.
// Two independent secrets rather than one reused value: a `state` value travels
// through a URL and can leak (history, a referrer, a shoulder), and leaking it
// must not also leak the binding.
//
// The remaining exposure is the *destination* of the redirect, which is why
// `callback_url` is built from `auth.localOrigin()` rather than from the request's
// Host header: an attacker-controlled hostname there would be a way to have the
// code delivered somewhere else.
const FILE = "oauth.json";
const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

/** OpenRouter codes expire after 10 minutes; a pending flow older than this is dead. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * The cookie that binds a redirect to the browser that started the flow.
 *
 * Scoped to the connect endpoints rather than to `/`, so it is not attached to
 * every request the app makes, and `HttpOnly` so nothing in the page — including
 * anything injected into it — can read the value out.
 */
export const BINDING_COOKIE = "infyield_oauth_binding";
export const BINDING_COOKIE_PATH = "/api/connect/openrouter";
export const BINDING_COOKIE_MAX_AGE = PENDING_TTL_MS / 1000;

interface PendingFlow {
  verifier: string;
  challenge: string;
  /** Echoed back as the `state` query parameter when the provider supports it. */
  state: string;
  /** Presented as the binding cookie. Never part of any URL. */
  binding: string;
  createdAt: number;
}

/** What the caller needs to start the browser side of the flow. */
export interface OpenRouterAuthorize {
  url: string;
  /** The value to set as `BINDING_COOKIE`, or `null` for the headless flow. */
  binding: string | null;
}

export type ConnectResult = { ok: true; label: string } | { ok: false; error: string };

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A fresh secret, 32 bytes of CSPRNG. */
function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** OpenRouter reports failures as either a string or an {message, code}
 * object; never let a non-string reach the client as a rendered value. */
function errorText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

async function challengeFor(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(hash));
}

function savePending(flow: PendingFlow): void {
  writeJson(FILE, flow);
}

/**
 * Drop the pending flow.
 *
 * Called on *every* outcome, not just success. A rejected or failed attempt that
 * left its verifier behind would be a stale secret waiting for a later attempt
 * to spend — and since an authorization code is single-use server-side, a failed
 * exchange has already spent it, so there is nothing to go back to anyway.
 */
function clearPending(): void {
  writeJson(FILE, null);
}

function loadPending(): PendingFlow | null {
  const f = readJson<PendingFlow | null>(FILE, null);
  if (!f?.verifier || !f?.challenge) return null;
  // A record written before the nonce and the binding existed has neither, and
  // cannot satisfy the checks below; treat it as no pending flow rather than as
  // one with empty secrets.
  if (!f.state || !f.binding) return null;
  if (Date.now() - f.createdAt > PENDING_TTL_MS) return null;
  return f;
}

export function hasPendingConnect(): boolean {
  return loadPending() !== null;
}

/** Start the flow. `callbackUrl` omitted → headless (code shown on screen). */
export async function beginOpenRouterConnect(callbackUrl?: string): Promise<OpenRouterAuthorize> {
  const verifier = newSecret();
  const challenge = await challengeFor(verifier);
  const state = newSecret();
  // Minted for the headless flow too, even though there is no browser to send it
  // to: the stored record always has one, so a record that is missing it is a
  // record written before this check existed, not a valid flow.
  const binding = newSecret();
  savePending({ verifier, challenge, state, binding, createdAt: Date.now() });

  const params = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: "S256",
    key_label: "Infyield",
  });
  if (callbackUrl) {
    params.set("callback_url", callbackUrl);
    // Only the redirect flow can carry a nonce back, so only that flow sends
    // one: the headless flow's URL stays exactly the shape OpenRouter documents
    // as the working one.
    params.set("state", state);
  }
  return { url: `https://openrouter.ai/auth?${params.toString()}`, binding: callbackUrl ? binding : null };
}

/** Exchange a code for a key and provision it as the server's credential. */
async function exchange(code: string, verifier: string): Promise<ConnectResult> {
  if (!code.trim()) return { ok: false, error: "Missing authorization code." };

  let key = "";
  try {
    const res = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: code.trim(),
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { key?: string; error?: unknown };
    if (!res.ok || !body.key) {
      return { ok: false, error: errorText(body.error) || `OpenRouter rejected the code (HTTP ${res.status}).` };
    }
    key = body.key;
  } catch (err) {
    return { ok: false, error: `Could not reach OpenRouter: ${(err as Error).message}` };
  }

  const label = "OpenRouter (connected)";

  // The credential has to land where the router actually reads it. It used to be
  // written to a key pool, which the agent no longer consults — so connecting an
  // account appeared to succeed and changed nothing, and every model still
  // refused with "AI provider is not configured". `provisionCredential` writes
  // the server-side `provider.env` that `serverCredential()` reads, which is the
  // same place an operator-set `OPENROUTER_API_KEY` comes from.
  const provisioned = provisionCredential("openrouter", key);
  if (!provisioned.ok) {
    return { ok: false, error: provisioned.error ?? "The credential could not be stored." };
  }
  return { ok: true, label };
}

/**
 * Finish a redirect flow: the callback a browser lands on after authorizing.
 *
 * Both nonces are required and both must match, and the order matters for the
 * diagnosis rather than for the outcome. The binding cookie is checked first
 * because it is the one an attacker cannot produce: a caller that fails that
 * check is not the browser that started this flow. A caller that *passes* it and
 * then fails the `state` check is this flow's own browser encountering a
 * provider that did not return the parameter — a different bug, and it says so.
 */
export async function completeOpenRouterRedirect(input: {
  code: string;
  state: string;
  binding: string;
}): Promise<ConnectResult> {
  const pending = loadPending();
  if (!pending) {
    return { ok: false, error: "No pending connect request (or it expired). Click Connect again." };
  }

  // Single-use from here on, whatever happens next.
  clearPending();

  if (!secureEquals(input.state, pending.state)) {
    return {
      ok: false,
      error: secureEquals(input.binding, pending.binding)
        ? "OpenRouter returned no state (or a different one) for this request. The browser binding matched, so this looks like the provider not echoing `state` rather than an attack — the connect flow needs its nonce check relaxed. Click Connect again to retry."
        : "State mismatch on the OpenRouter redirect: this callback did not come from the browser that started the flow, so it was refused.",
    };
  }
  if (!secureEquals(input.binding, pending.binding)) {
    return {
      ok: false,
      error:
        "The browser that completed this redirect is not the one that started the flow (its binding cookie did not match), so it was refused.",
    };
  }

  return exchange(input.code, pending.verifier);
}

/**
 * Finish a pasted code — the headless flow, and the fallback when a redirect
 * cannot reach the app.
 *
 * Nothing to bind here: the caller already had to present the admin password to
 * reach this, and there was no browser redirect to hijack. PKCE still applies,
 * so the code is only redeemable against the verifier written when the flow
 * started.
 */
export async function completeOpenRouterConnect(code: string): Promise<ConnectResult> {
  const pending = loadPending();
  if (!pending) {
    return { ok: false, error: "No pending connect request (or it expired). Click Connect again." };
  }
  clearPending(); // an authorization code is single-use, so this attempt spends the flow
  return exchange(code, pending.verifier);
}
