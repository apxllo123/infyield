import type { AdProvider } from "./types";
import { readJson, writeJson } from "./store";
import { getSettings } from "./settings";
import { modeReport } from "./mode";

/**
 * The ad lifecycle: what happened to one ad, in order, with evidence.
 *
 * "An ad rendered" and "money was earned" are different claims, and the gap
 * between them is where this product would lie to itself. So every step is a
 * separate, recorded event:
 *
 * ```
 *   requested    the server asked a provider for an ad
 *   served       a provider returned a creative
 *   displayed    the client said the card actually mounted
 *   verified     the provider's own pixel/endpoint accepted the event
 *   pending      revenue booked, but the payer has not settled it
 *   confirmed    the payer is on the hook (advertiser invoiced) or has settled
 * ```
 *
 * Only `displayed` + `verified` reach `pending`/`confirmed`, and a house creative
 * never reaches `confirmed` at all — it has no external payer. A step that did
 * not happen is absent rather than inferred, so a missing `verified` is visible
 * instead of being papered over by a later credit.
 *
 * ## Idempotency
 *
 * Each logical event carries a client-minted id, reused on every retry, and is
 * deduplicated by that id. This mirrors how Freebuff handles it — one UUID per
 * logical client event sent as a header, with the server reporting `deduped`
 * rather than double-counting — and it is what lets the transport retry freely
 * without the ledger moving twice.
 *
 * ## Why the client's id is validated, not trusted
 *
 * The id is an opaque token: bounded length, printable charset, never parsed.
 * It identifies an event; it cannot assert anything about it. The billable facts
 * (which campaign, which provider, what it is worth) are all resolved
 * server-side from ids the server itself minted.
 */

const FILE = "adevents.json";
const MAX_EVENTS = 2_000;

export type AdEventType = "requested" | "served" | "displayed" | "verified" | "pending" | "confirmed" | "click";

export interface AdEvent {
  /** The idempotency key: one per logical event, stable across retries. */
  eventId: string;
  type: AdEventType;
  ts: number;
  /** The server-minted token identifying this served ad. */
  impressionId: string;
  provider: AdProvider | "none";
  placement: string;
  campaignId: string | null;
  sessionId: string | null;
  /** The provider's own event/creative id, when it gave one. */
  networkEventId: string | null;
  /** Derived server-side from the User-Agent; never taken from a request body. */
  clientFamily: ClientFamily;
  /** Client-measured render delay, or null when it could not be measured. */
  renderDelayMs: number | null;
  amountUsd: number | null;
  pending: boolean;
  detail?: string;
  simulated: boolean;
}

interface AdEventFile {
  events: AdEvent[];
  /** Every event id ever recorded, so a retry cannot book twice. */
  seen: string[];
}

function load(): AdEventFile {
  const f = readJson<Partial<AdEventFile>>(FILE, {});
  return {
    events: Array.isArray(f.events) ? f.events : [],
    seen: Array.isArray(f.seen) ? f.seen : [],
  };
}

function save(f: AdEventFile): void {
  writeJson(FILE, { events: f.events.slice(0, MAX_EVENTS), seen: f.seen.slice(-5_000) });
}

/* ------------------------------ input hygiene ------------------------------ */

/**
 * One UUID per logical event, reused on every retry of it.
 *
 * Bounded in length and charset so it can be stored and logged as an opaque
 * token and never has to be escaped or parsed. An unusable id returns null and
 * the caller mints one server-side — a malformed header is never grounds for
 * rejecting a revenue-adjacent ack, since losing the event is worse than losing
 * the id it wanted to be known by.
 */
const EVENT_ID_RE = /^[A-Za-z0-9._:-]+$/;
const EVENT_ID_MAX = 128;

export function readClientEventId(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (value.length > 0 && value.length <= EVENT_ID_MAX && EVENT_ID_RE.test(value)) return value;
  }
  return null;
}

/**
 * A client-measured render delay, clamped rather than rejected.
 *
 * Never derived when absent: filling it in from `served_at` would invent a
 * measurement and make a preloaded ad look like a viewed one. Negative means a
 * backwards clock and stores zero; non-finite stores nothing.
 */
export const RENDER_DELAY_MAX_MS = 86_400_000;

export function clampRenderDelayMs(value: unknown): number | null {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(RENDER_DELAY_MAX_MS, Math.max(0, Math.round(n)));
}

export type ClientFamily = "cli" | "desktop" | "web" | "unknown";

/**
 * Which client sent this, derived server-side from the leading product token of
 * its User-Agent.
 *
 * Deliberately not read from the request body: a client can claim any surface it
 * likes, and a claim must never be what decides how an event is classified. An
 * unrecognised agent is `unknown` rather than a guess.
 */
export function clientFamilyFromUserAgent(raw: string | null | undefined): ClientFamily {
  if (typeof raw !== "string") return "unknown";
  const [first = ""] = raw.trim().split(/\s+/, 1);
  const product = first.split("/", 1)[0]?.toLowerCase() ?? "";
  if (product === "infyield-cli") return "cli";
  if (product === "infyield-desktop") return "desktop";
  if (product === "mozilla") return "web";
  return "unknown";
}

/* ------------------------------- recording -------------------------------- */

export interface RecordAdEventInput {
  type: AdEventType;
  eventId?: string | null;
  impressionId: string;
  provider: AdProvider | "none";
  placement?: string;
  campaignId?: string | null;
  sessionId?: string | null;
  networkEventId?: string | null;
  clientFamily?: ClientFamily;
  renderDelayMs?: number | null;
  amountUsd?: number | null;
  pending?: boolean;
  detail?: string;
}

/**
 * Record one lifecycle event. Returns null when this event id was already seen.
 *
 * The dedupe is the whole point: a client retrying an impression because the
 * response was slow must not book a second credit, and the caller gets `null`
 * so it can answer `alreadyRecorded` instead of pretending it did new work.
 */
export function recordAdEvent(input: RecordAdEventInput): AdEvent | null {
  const f = load();
  const eventId = input.eventId?.trim() || crypto.randomUUID();
  if (f.seen.includes(eventId)) return null;
  const event: AdEvent = {
    eventId,
    type: input.type,
    ts: Date.now(),
    impressionId: input.impressionId,
    provider: input.provider,
    placement: input.placement ?? "cli_chat",
    campaignId: input.campaignId ?? null,
    sessionId: input.sessionId ?? null,
    networkEventId: input.networkEventId ?? null,
    clientFamily: input.clientFamily ?? "unknown",
    renderDelayMs: input.renderDelayMs ?? null,
    amountUsd: input.amountUsd ?? null,
    pending: input.pending ?? false,
    ...(input.detail ? { detail: input.detail } : {}),
    simulated: modeReport().simulated,
  };
  f.events.unshift(event);
  f.seen.push(eventId);
  save(f);
  return event;
}

export function listAdEvents(limit = 100): AdEvent[] {
  return load().events.slice(0, Math.max(0, limit));
}

/* ------------------------------ frequency caps ----------------------------- */

/**
 * Server-enforced ad frequency.
 *
 * The client decides *when* a slot is natural — that is a UI judgement this
 * server cannot make — but it does not decide how often an ad may be requested,
 * because a client is not trusted with a limit. The caps below are checked
 * against recorded events, so a client that asks more often than allowed simply
 * gets no fill.
 *
 * Two of them are per-*time* and two are per-*count*, which is deliberate: a
 * burst of thirty ad requests in ten seconds passes a per-day cap and is exactly
 * the abuse a time floor exists to stop, while a long session passes a time
 * floor and is what a session cap exists to stop.
 */
export interface FrequencyCaps {
  /** Seconds that must pass between two serves, whatever else is true. */
  minSecondsBetweenAds: number;
  /** Serves allowed in one session. */
  maxAdsPerSession: number;
  /** Serves allowed in one day across every session. */
  maxAdsPerDay: number;
  /** Tool steps a response must reach before its first ad. */
  cadenceSteps: number;
  /** Most ads one assistant response may serve. */
  maxAdsPerResponse: number;
}

const DEFAULT_FREQUENCY_CAPS: FrequencyCaps = {
  minSecondsBetweenAds: 20,
  maxAdsPerSession: 20,
  maxAdsPerDay: 200,
  cadenceSteps: 3,
  maxAdsPerResponse: 3,
};

/**
 * A non-negative number from the environment, ignored when unparseable.
 *
 * A typo in a frequency limit must not become "unlimited" — silently removing a
 * protective cap is the worst possible reading of a malformed value.
 */
function envNumber(name: string): number | undefined {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function caps(): FrequencyCaps {
  const ads = getSettings().ads;
  return {
    ...DEFAULT_FREQUENCY_CAPS,
    minSecondsBetweenAds: envNumber("INFYIELD_MIN_SECONDS_BETWEEN_ADS") ?? DEFAULT_FREQUENCY_CAPS.minSecondsBetweenAds,
    maxAdsPerSession: envNumber("INFYIELD_MAX_ADS_PER_SESSION") ?? DEFAULT_FREQUENCY_CAPS.maxAdsPerSession,
    maxAdsPerDay: envNumber("INFYIELD_MAX_ADS_PER_DAY") ?? DEFAULT_FREQUENCY_CAPS.maxAdsPerDay,
    // The operator's ad-intensity setting drives cadence; the floors above stay
    // in force underneath it.
    cadenceSteps: Math.max(1, ads.cadenceSteps),
    maxAdsPerResponse: Math.max(0, ads.maxAdsPerResponse),
  };
}

/** The caps in force, for the health surface and the UI to report. */
function frequencyCaps(): FrequencyCaps {
  return caps();
}

export interface FrequencyVerdict {
  allowed: boolean;
  reason: string;
  /** Recorded so the refusal is auditable rather than a silent no-fill. */
  code: "ok" | "too-soon" | "session-cap" | "daily-cap" | "disabled";
}

export function checkAdFrequency(opts: { sessionId?: string | null; now?: number } = {}): FrequencyVerdict {
  const capsIn = caps();
  const ads = getSettings().ads;
  if (!ads.enabled) return { allowed: false, reason: "Ads are disabled on this server.", code: "disabled" };
  const now = opts.now ?? Date.now();
  const events = load().events.filter((e) => e.type === "served");
  const last = events[0];
  if (last && now - last.ts < capsIn.minSecondsBetweenAds * 1000) {
    const wait = Math.ceil((capsIn.minSecondsBetweenAds * 1000 - (now - last.ts)) / 1000);
    return { allowed: false, reason: `Frequency floor: ${wait}s until the next ad may serve.`, code: "too-soon" };
  }
  if (opts.sessionId) {
    const inSession = events.filter((e) => e.sessionId === opts.sessionId).length;
    if (inSession >= capsIn.maxAdsPerSession) {
      return {
        allowed: false,
        reason: `This session has served ${inSession} ads, at the configured ceiling of ${capsIn.maxAdsPerSession}.`,
        code: "session-cap",
      };
    }
  }
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const today = events.filter((e) => e.ts >= dayStart).length;
  if (today >= capsIn.maxAdsPerDay) {
    return {
      allowed: false,
      reason: `Today has served ${today} ads, at the configured ceiling of ${capsIn.maxAdsPerDay}.`,
      code: "daily-cap",
    };
  }
  return { allowed: true, reason: "Within every frequency cap.", code: "ok" };
}

/* -------------------------------- diagnostics ------------------------------ */

export interface AdPipeline {
  lastRequestedAt: number | null;
  lastServedAt: number | null;
  lastDisplayedAt: number | null;
  lastVerifiedAt: number | null;
  lastClickAt: number | null;
  lastPendingAt: number | null;
  lastConfirmedAt: number | null;
  served: number;
  displayed: number;
  verified: number;
  clicks: number;
  /** Serves whose provider never verified them — the money that did not arrive. */
  unverified: number;
  byProvider: Record<string, number>;
  simulated: boolean;
}

/**
 * What the ad system has actually done, from recorded events only.
 *
 * `unverified` is the number worth watching: a served ad whose provider never
 * confirmed it is a slot that earned nothing, and it is invisible in any figure
 * that only counts serves.
 */
export function adPipeline(): AdPipeline {
  const events = load().events;
  const lastOf = (type: AdEventType): number | null => events.find((e) => e.type === type)?.ts ?? null;
  const countOf = (type: AdEventType): number => events.filter((e) => e.type === type).length;
  const byProvider: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== "served") continue;
    byProvider[e.provider] = (byProvider[e.provider] ?? 0) + 1;
  }
  const served = countOf("served");
  const verified = countOf("verified");
  return {
    lastRequestedAt: lastOf("requested"),
    lastServedAt: lastOf("served"),
    lastDisplayedAt: lastOf("displayed"),
    lastVerifiedAt: lastOf("verified"),
    lastClickAt: lastOf("click"),
    lastPendingAt: lastOf("pending"),
    lastConfirmedAt: lastOf("confirmed"),
    served,
    displayed: countOf("displayed"),
    verified,
    clicks: countOf("click"),
    unverified: Math.max(0, served - verified),
    byProvider,
    simulated: modeReport().simulated,
  };
}
