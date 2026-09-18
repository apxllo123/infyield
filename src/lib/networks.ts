import http2 from "node:http2";
import type { SponsoredAd } from "./types";
import { readJson, writeJson } from "./store";

/**
 * Real ad-network inventory (EthicalAds, the successor to Carbon Ads).
 *
 * This is the one place money can arrive without you selling an ad yourself, so
 * the contract is implemented against the live API rather than against prose.
 * A real decision response looks like this (probed 2026-09-16):
 *
 *   {
 *     "id": "bruno-v03-20260730",
 *     "text": "<a href=\"https://server.ethicalads.io/proxy/click/10786/<nonce>/\">…",
 *     "body": "Test APIs. Commit them. Bruno works with Git, your IDE, and your agents. Try Bruno",
 *     "copy": { "headline": "Test APIs. Commit them.", "cta": "Try Bruno", "content": "Bruno works with Git, …" },
 *     "link": "https://server.ethicalads.io/proxy/click/10786/<nonce>/",
 *     "link_domain": "usebruno.com",
 *     "view_url": "https://server.ethicalads.io/proxy/view/10786/<nonce>/",
 *     "view_time_url": "https://server.ethicalads.io/proxy/viewtime/10786/<nonce>/",
 *     "nonce": "…", "display_type": "text-v1", "campaign_type": "paid"
 *   }
 *
 * Four things here are easy to get wrong, and all four were wrong in the first
 * implementation of this file — with the result that no network ad could ever be
 * served, so the "real network revenue" path silently earned exactly nothing:
 *
 *  1. The click target is `link`, not `click_url`. `click_url` does not exist.
 *  2. `url` does not exist either. Requiring it rejected every real fill.
 *  3. `campaign_type` is "paid", not "text"/"text_v1" (that is `display_type`).
 *  4. `copy` carries clean headline/cta/content, so ad copy never needs HTML
 *     stripping or string surgery.
 *
 * Anything that is not `campaign_type: "paid"` pays nothing: the network also
 * returns house/community promos, and booking revenue for those would be
 * inventing income. They are refused so the caller falls back to your own
 * campaigns, and the refusal is recorded so the UI can say why.
 *
 * Eligibility is a separate matter and worth stating plainly: EthicalAds is
 * invite-only, reviews the placement on a *public site*, and pays out at $50 via
 * PayPal/Stripe/etc. Their display policy requires the ad to appear above the
 * fold on first visit, outside the reading flow, and to be the only ad on the
 * page — an inline card inside a local desktop app does not qualify. See the
 * README's operator playbook for what this means for earning.
 */

/**
 * The decision endpoint. Overridable so a mock network can exercise the whole
 * paid path — fill, unpaid creative, rejection, no fill, and a failing pixel —
 * without inventing traffic against a real advertiser. Server-side only: there
 * is no UI for it, because pointing production at a test endpoint would be a way
 * to book revenue from a network that does not exist.
 */
const DECISION_URL = process.env.INFYIELD_ETHICALADS_DECISION_URL?.trim() || "https://server.ethicalads.io/api/v1/decision/";
const DECISION_TIMEOUT_MS = 3000;
const PIXEL_TIMEOUT_MS = 4000;
/** Their client fires the view-time pixel once the ad has actually been seen;
 * the inline card is on screen as soon as it renders, so a short beat after the
 * view pixel is the honest equivalent. */
const VIEW_TIME_DELAY_MS = 1200;

export interface NetworkAd extends SponsoredAd {
  /** Our own tracking endpoints (so the ledger sees the same events). */
  networkViewUrl: string;
  networkClickUrl: string;
  networkViewTimeUrl: string;
  /**
   * The network's own creative/campaign id, kept for provenance.
   *
   * This names the campaign, not the serve: the same value comes back every time
   * that creative is chosen, which is why it must never be used to identify an
   * impression. See `serveAd` in `ads.ts`, which mints a per-serve token beside it.
   */
  networkCreativeId: string;
  /**
   * True when the network counts the impression at SERVE time (Carbon's
   * BuySellAds model: the JSON fetch itself is the impression), so the ledger
   * books without waiting on a pixel. EthicalAds leaves this false — it pays
   * for impressions its own view pixel actually received.
   */
  verifiedOnServe?: boolean;
}

interface DecisionResponse {
  id?: string;
  text?: string;
  body?: string;
  html?: string;
  copy?: { headline?: string; cta?: string; content?: string };
  link?: string;
  link_domain?: string;
  view_url?: string;
  view_time_url?: string;
  nonce?: string;
  display_type?: string;
  campaign_type?: string;
}

export interface NetworkFetch {
  ad: NetworkAd | null;
  /** Machine-ish reason, recorded so a silent fallback becomes visible. */
  reason: "ok" | "not-configured" | "invalid-publisher" | "no-fill" | "unpaid-creative" | "http-error" | "offline";
  detail?: string;
}

export function networkConfigured(publisherId: string): boolean {
  return publisherId.trim().length > 0;
}

const UA = "Infyield/0.1 (+local agent; ad delivery only)";

/**
 * HTTP/2, not fetch.
 *
 * The ad network sits behind Cloudflare, which refuses Node's HTTP/1.1 client
 * outright — every request came back `403 Request Blocked` while the identical
 * request from curl returned a filled creative. curl negotiates HTTP/2 and Node's
 * fetch does not, which is the whole difference: the same URL over HTTP/2 via
 * `node:http2` returns 200. So the network request has to be HTTP/2 or the slot
 * silently earns nothing, however correct the parsing is.
 *
 * The session is cached and dropped on error/close; ads are requested a handful
 * of times per turn, so one warm connection per origin is plenty.
 */
let session: http2.ClientHttp2Session | null = null;
let sessionOrigin = "";

function httpsSession(origin: string): http2.ClientHttp2Session {
  if (session && sessionOrigin === origin && !session.closed && !session.destroyed) return session;
  const next = http2.connect(origin);
  next.on("error", () => {
    if (session === next) session = null;
  });
  next.on("close", () => {
    if (session === next) session = null;
  });
  // Idle sessions are not worth keeping forever.
  next.setTimeout(60_000, () => next.close());
  session = next;
  sessionOrigin = origin;
  return next;
}

interface HttpResult {
  status: number;
  body: string;
}

function h2Get(url: string, timeoutMs: number): Promise<HttpResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: HttpResult | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return finish(null);
    }
    let client: http2.ClientHttp2Session;
    try {
      client = httpsSession(target.origin);
    } catch {
      return finish(null);
    }
    const req = client.request({
      ":method": "GET",
      ":path": target.pathname + target.search,
      accept: "application/json, text/plain, */*",
      "user-agent": UA,
    });
    const timer = setTimeout(() => {
      req.close();
      finish(null);
    }, timeoutMs);
    let status = 0;
    let body = "";
    req.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    req.on("data", (chunk: Buffer) => {
      // Decision payloads are small; pixels are 1x1. Cap defensively.
      if (body.length < 512_000) body += chunk.toString("utf8");
    });
    req.on("end", () => {
      clearTimeout(timer);
      finish({ status, body });
    });
    req.on("error", () => {
      clearTimeout(timer);
      if (session === client) session = null;
      finish(null);
    });
    req.end();
  });
}

/**
 * One GET that works against both the real network (HTTPS, HTTP/2 required) and
 * a local mock (plain HTTP, where h2c is not worth requiring).
 */
async function httpGet(url: string, timeoutMs: number): Promise<HttpResult | null> {
  if (url.startsWith("https:")) return h2Get(url, timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { accept: "*/*", "user-agent": UA } });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch one text ad. Never throws: failure is normal (no fill, offline, bad
 * publisher id) and the reason is returned so it can be surfaced. */
export async function fetchEthicalAds(
  publisherId: string,
  opts: { keywords?: string[]; timeoutMs?: number } = {},
): Promise<NetworkFetch> {
  if (!networkConfigured(publisherId)) return { ad: null, reason: "not-configured" };

  const params = new URLSearchParams({
    publisher: publisherId.trim(),
    ad_types: "text-v1",
    format: "json",
    div_ids: "infyield-inline",
  });
  if (opts.keywords?.length) params.set("keywords", opts.keywords.slice(0, 8).join(","));

  const res = await httpGet(`${DECISION_URL}?${params.toString()}`, opts.timeoutMs ?? DECISION_TIMEOUT_MS);
  if (!res) return { ad: null, reason: "offline" };
  if (res.status === 400) {
    // Shape: {"publisher":["Invalid publisher"]},
    // or {"placements":[{"div_id":["This field may not be blank."]}]} when
    // div_ids is missing — both mean the network will not serve us.
    return { ad: null, reason: "invalid-publisher", detail: res.body.slice(0, 160) };
  }
  if (res.status === 403) {
    // Cloudflare's bot shield. Worth its own reason: it means the request shape
    // (protocol, not content) is wrong, which is a code problem here.
    return { ad: null, reason: "http-error", detail: "HTTP 403 blocked at the network edge" };
  }
  if (res.status < 200 || res.status >= 300) return { ad: null, reason: "http-error", detail: `HTTP ${res.status}` };

  let body: DecisionResponse | null = null;
  try {
    body = JSON.parse(res.body) as DecisionResponse;
  } catch {
    body = null;
  }
  if (!body) return { ad: null, reason: "no-fill", detail: "unparseable response" };

  const link = (body.link ?? "").trim();
  const viewUrl = (body.view_url ?? "").trim();
  const copy = body.copy ?? {};
  const plain = (body.body ?? "").trim();
  const headline = (copy.headline ?? "").trim() || domainOf(link) || "Sponsored";

  // A creative we cannot render, click or count is no fill.
  if (!link || !viewUrl || (!plain && !copy.content)) {
    return { ad: null, reason: "no-fill", detail: `id=${body.id ?? "?"} missing link/view_url/copy` };
  }
  // Paid only. Booking revenue for a house promo would be inventing money.
  if ((body.campaign_type ?? "").toLowerCase() !== "paid") {
    return { ad: null, reason: "unpaid-creative", detail: `campaign_type=${body.campaign_type ?? "unknown"}` };
  }

  const domain = (body.link_domain ?? "").trim() || domainOf(link);
  const content = (copy.content ?? "").trim();
  const cta = (copy.cta ?? "").trim() || "Learn more";
  // Fall back to the flat body only if the structured copy is absent: strip the
  // headline/CTA off the front of it so the card is not a wall of repetition.
  const adText = content || stripHtml(plain.slice(headline.length).replace(cta, "").trim()) || stripHtml(plain);

  return {
    reason: "ok",
    ad: {
      adText,
      title: headline,
      cta,
      url: link,
      domain,
      provider: "ethicalads",
      placementId: "cli_chat",
      // Our own endpoints: the ledger records the same event the network does.
      clickUrl: `/api/ads/click?n=${encodeURIComponent(body.id ?? "")}`,
      impUrl: `/api/ads/impression?n=${encodeURIComponent(body.id ?? "")}`,
      networkViewUrl: viewUrl,
      networkClickUrl: link,
      networkViewTimeUrl: (body.view_time_url ?? "").trim(),
      networkCreativeId: (body.id ?? "").trim(),
    },
  };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Carbon Ads (BuySellAds) — the second network Freebuff's fill chain uses, and
 * the one with a public serve contract: `GET
 * https://srv.buysellads.com/ads/{placementId}?json` returns a paid creative
 * for an approved placement. Unlike EthicalAds, the *fetch itself* is the
 * impression (BuySellAds counts serves), clicks go through `statlink`, and the
 * creative carries its own icon — which is what gives the card its picture.
 *
 * An unapproved or wrong id comes back `{"ads":[{"error":true,...}]}` or with
 * an empty array; both are no-fill, never booked.
 */
export async function fetchCarbonAds(placementId: string, opts: { timeoutMs?: number } = {}): Promise<NetworkFetch> {
  const id = placementId.trim();
  if (!id) return { ad: null, reason: "not-configured" };

  const res = await httpGet(`https://srv.buysellads.com/ads/${encodeURIComponent(id)}?json`, opts.timeoutMs ?? DECISION_TIMEOUT_MS);
  if (!res) return { ad: null, reason: "offline" };
  if (res.status === 403) return { ad: null, reason: "http-error", detail: "HTTP 403 blocked at the network edge" };
  if (res.status < 200 || res.status >= 300) return { ad: null, reason: "http-error", detail: `HTTP ${res.status}` };

  let body: { ads?: unknown[] } | null = null;
  try {
    body = JSON.parse(res.body) as { ads?: unknown[] };
  } catch {
    body = null;
  }
  const raw = body?.ads?.[0] as Record<string, unknown> | undefined;
  if (!raw) return { ad: null, reason: "no-fill", detail: "empty ads array" };
  if ((raw as { error?: unknown }).error === true) {
    return { ad: null, reason: "invalid-publisher", detail: "the network rejected that placement id" };
  }

  const company = String(raw.company ?? "").trim();
  const description = String(raw.description ?? raw.tagline ?? "").trim();
  const statlink = String(raw.statlink ?? "").trim();
  const cta = String(raw.callToAction ?? raw.cta ?? "Learn more").trim();
  const icon = String(raw.icon ?? raw.image ?? "").trim();
  const landing = String(raw.landingPage ?? raw.url ?? "").trim();
  // A creative we cannot show or click is no fill, same rule as EthicalAds.
  if (!statlink || (!description && !company)) {
    return { ad: null, reason: "no-fill", detail: "missing statlink/copy" };
  }
  const creativeId = String(raw.adid ?? raw.id ?? "").trim();
  const domain = landing ? domainOf(landing) : "";

  return {
    reason: "ok",
    ad: {
      adText: description || company,
      title: company || domain || "Sponsored",
      cta: cta || "Learn more",
      url: landing || statlink,
      domain: domain || domainOf(statlink),
      ...(icon && icon.startsWith("http") ? { icon } : {}),
      provider: "carbon",
      placementId: "cli_chat",
      // The ledger records the same events the network does.
      clickUrl: `/api/ads/click?n=${encodeURIComponent(creativeId || id)}`,
      impUrl: `/api/ads/impression?n=${encodeURIComponent(creativeId || id)}`,
      networkViewUrl: "",
      networkClickUrl: statlink,
      networkViewTimeUrl: "",
      networkCreativeId: creativeId || id,
      verifiedOnServe: true,
    },
  };
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fire the network's impression pixel. Unlike the first implementation this is
 * awaited and its outcome reported: the network only counts (and therefore only
 * pays for) impressions whose pixel it actually received, so booking revenue
 * after a failed pixel would be booking money that will never arrive.
 */
export async function ackNetworkImpression(viewUrl: string): Promise<boolean> {
  if (!viewUrl) return false;
  const res = await httpGet(viewUrl, PIXEL_TIMEOUT_MS);
  return !!res && res.status >= 200 && res.status < 400;
}

/**
 * Fire the view-time pixel, which is how the network decides a view was real
 * rather than a preload. Deliberately not awaited by the caller: it is a
 * background confirmation, and blocking a user's impression ack on it would make
 * the transcript wait on an ad server.
 */
export function ackNetworkViewTime(viewTimeUrl: string): void {
  if (!viewTimeUrl) return;
  setTimeout(() => {
    void httpGet(viewTimeUrl, PIXEL_TIMEOUT_MS);
  }, VIEW_TIME_DELAY_MS);
}

/* --------------------------- visible network state -------------------------- */
//
// Failure used to be invisible: a rejected publisher id fell back to house
// campaigns forever and the app still looked like it was "serving ads". The last
// outcome is recorded so Settings and Economy can say what actually happened.

const STATE_FILE = "netstate.json";

export interface NetworkState {
  reason: NetworkFetch["reason"];
  detail?: string;
  at: number;
  publisherId?: string;
}

export function recordNetworkOutcome(outcome: NetworkFetch, publisherId: string): void {
  writeJson(STATE_FILE, { reason: outcome.reason, detail: outcome.detail, at: Date.now(), publisherId });
}

export function networkState(): NetworkState | null {
  const s = readJson<NetworkState | null>(STATE_FILE, null);
  return s && typeof s.reason === "string" ? s : null;
}

/** Plain-language explanation for the UI. */
export function networkReasonText(state: NetworkState | null, configured: boolean): string {
  if (!configured) return "No publisher id set — inventory comes from your own campaigns.";
  if (!state) return "No ad has been requested from the network yet.";
  switch (state.reason) {
    case "ok":
      return "The network returned a paid creative and its tracking pixels were received.";
    case "invalid-publisher":
      return `The network rejected that publisher id${state.detail ? ` (${state.detail})` : ""} — no network revenue is possible until it is corrected.`;
    case "unpaid-creative":
      return `The network returned a non-paid creative${state.detail ? ` (${state.detail})` : ""}; it pays nothing, so it was refused.`;
    case "no-fill":
      return "The network had no ad to fill this request (normal, especially at low traffic).";
    case "offline":
      return "The ad network could not be reached.";
    case "http-error":
      return `The ad network returned an error${state.detail ? ` (${state.detail})` : ""}.`;
    default:
      return "No network ad has been served yet.";
  }
}
