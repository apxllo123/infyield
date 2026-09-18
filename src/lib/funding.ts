import type { FundingPolicy, LedgerEntry, ModelInfo } from "./types";
import { allEntries, getState } from "./economy";
import { revenueBreakdown } from "./funds";
import { getSettings } from "./settings";
import { providerConfigured } from "./credentials";
import { modeReport } from "./mode";

/**
 * Provider-spend admission control, and the funding measurement behind it.
 *
 * Two questions live in this module, and keeping them apart is the whole design:
 *
 *   "May this request run?"      → `admitRequest`
 *   "Are the ads covering it?"   → `fundingSnapshot`
 *
 * The promise is that a guest pays nothing: the deployment's own credential is
 * what the provider bills, and the ads served while the agent works are what
 * fund that account. So the credential is the *means* of payment and ad revenue
 * is its *coverage* — which is why ad revenue does not authorise each call in
 * advance, and the ledger measures the gap instead. Conflating the two is how
 * either a system spends money it never earned, or a configured, working
 * install refuses to do anything at all.
 *
 * ## Coverage, and why it is not one number
 *
 * ```
 *   collectible revenue        money somebody is on the hook to pay
 * − spend already booked       what providers have already charged
 * − payouts already made       money sent out of the account
 * = available operating balance   ≥ 0 means the ads are covering the bill
 * − reserve                    the floor the reserve tier still respects
 * = provider budget            reported, no longer a precondition
 * ```
 *
 * `providerBudgetUsd` is kept because the reserve tier and the health surface
 * both want it, but it no longer decides whether an ordinary model may run.
 *
 * Only *collectible* revenue counts. Revenue booked from house inventory that
 * nobody will pay for is excluded by `funds.ts` before it reaches this module —
 * see requirement: a placeholder ad is never cash.
 *
 * ## Pending revenue is not spendable
 *
 * Network impressions book as pending until the network's statement lands (see
 * `reconcileRevenue`). Pending money has not been paid by anybody, so it is
 * reported and never budgeted. Counting it is the single easiest way to be
 * insolvent while showing a healthy balance.
 *
 * ## Where the checks sit
 *
 * Admission runs once, *before* a turn starts, and never mid-turn: an in-flight
 * request is never interrupted, because a half-finished agent turn costs money
 * and delivers nothing. A refusal therefore has to happen up front, which is
 * also why the estimate it is checked against is deliberately conservative.
 *
 * What admits a request is a credential the provider will bill; what refuses one
 * is no credential, an operator brake (emergency stop, daily cap, session cap),
 * or a price above the ceiling. What *gates* a model is the reserve tier, which
 * is still earned from ad revenue — expensive models stay earned, everyday ones
 * do not need permission.
 */

export const DEFAULT_FUNDING_POLICY: FundingPolicy = {
  // A reserve that is small in absolute terms. Its job is not to be a meaningful
  // sum of money; it is the margin the reserve tier measures itself against, so
  // "unlock the expensive models" means clearing spend by a margin rather than
  // scraping past it.
  reserveUsd: 0.5,
  dailySpendCapUsd: 10,
  maxRequestCostUsd: 0.5,
  perSessionDailyRequests: 200,
  emergencyStop: false,
};

export type FundingPolicyOverrides = Partial<FundingPolicy>;

function policy(): FundingPolicy {
  const saved = getSettings().funding ?? {};
  return { ...DEFAULT_FUNDING_POLICY, ...saved };
}

export type FundingHealth = "healthy" | "at-risk" | "blocked";

export interface FundingSnapshot {
  /** Revenue somebody is on the hook to pay. */
  confirmedRevenueUsd: number;
  /** Served but unreconciled network revenue — never spendable. */
  pendingRevenueUsd: number;
  /** Booked revenue with no payer behind it (house inventory). Not money. */
  houseRevenueUsd: number;
  /** Total ad revenue as the ledger books it, for cross-checking the split. */
  bookedRevenueUsd: number;
  /** What providers have charged. */
  spendUsd: number;
  spendTodayUsd: number;
  payoutsUsd: number;
  /** collectible − spend − payouts. */
  availableOperatingUsd: number;
  /** availableOperating − reserve: what new requests may draw on. */
  providerBudgetUsd: number;
  reserveUsd: number;
  policy: FundingPolicy;
  health: FundingHealth;
  /** Plain language, safe to render, naming the binding constraint. */
  reason: string;
  /** Simulation flag so a mocked figure is never read as production. */
  simulated: boolean;
}

function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function spendToday(entries: LedgerEntry[], now = Date.now()): number {
  const from = startOfToday(now);
  let total = 0;
  for (const e of entries) {
    if (e.kind !== "spend") continue;
    if (e.ts < from) continue;
    total += Math.abs(e.delta);
  }
  return total;
}

function requestsToday(entries: LedgerEntry[], now = Date.now()): number {
  const from = startOfToday(now);
  let n = 0;
  for (const e of entries) {
    if (e.kind !== "spend") continue;
    if (e.ts < from) continue;
    n += 1;
  }
  return n;
}

export function fundingSnapshot(now = Date.now()): FundingSnapshot {
  const state = getState();
  const p = policy();
  const breakdown = revenueBreakdown();
  const entries = allEntries();
  const confirmed = breakdown.collectibleUsd;
  const booked = state.adRevenueUsd;
  const available = confirmed - state.spendUsd - (state.payoutsUsd ?? 0);
  const budget = available - p.reserveUsd;
  const today = spendToday(entries, now);

  // Health answers one question: is advertising keeping up with the bill? It is
  // deliberately NOT "may a request run" — that is `admitRequest`, and conflating
  // the two is what made a configured, working install report itself blocked.
  //
  // `blocked` is reserved for states where nothing can pay or the operator has
  // pulled the brake; a deployment running on its own balance with ads lagging is
  // `at-risk`, which is true and is exactly what you want to see while revenue
  // builds.
  let health: FundingHealth;
  let reason: string;
  if (p.emergencyStop) {
    health = "blocked";
    reason = "Spending is stopped by the operator (emergency stop).";
  } else if (!providerConfigured()) {
    health = "blocked";
    reason = "Infyield has no provider credential, so no request could be paid for.";
  } else if (p.dailySpendCapUsd > 0 && today >= p.dailySpendCapUsd) {
    health = "blocked";
    reason = `Today's provider spend ($${today.toFixed(4)}) has reached the $${p.dailySpendCapUsd.toFixed(2)} daily cap.`;
  } else if (available === 0 && confirmed === 0 && state.spendUsd === 0) {
    // Nothing spent and nothing collected. Calling that "ads are covering the
    // bill" would be a vacuous claim — 0 ≥ 0 — and the health line is read as
    // "all is well", so it must not say that before anything has happened.
    health = "at-risk";
    reason = "Nothing spent and no ad revenue collected yet, so coverage is unproven.";
  } else if (available >= 0) {
    health = "healthy";
    reason = `Ads are covering the bill: $${confirmed.toFixed(4)} collected against $${state.spendUsd.toFixed(4)} of provider spend.`;
  } else {
    health = "at-risk";
    reason =
      confirmed <= 0
        ? `Running on the deployment's own balance: $${state.spendUsd.toFixed(4)} of provider spend with no ad revenue collected yet.`
        : `Ads have not caught up: $${confirmed.toFixed(4)} collected against $${state.spendUsd.toFixed(4)} of provider spend ($${Math.abs(available).toFixed(4)} behind).`;
  }

  return {
    confirmedRevenueUsd: confirmed,
    pendingRevenueUsd: state.estimatedRevenueUsd,
    houseRevenueUsd: breakdown.placeholderUsd,
    bookedRevenueUsd: booked,
    spendUsd: state.spendUsd,
    spendTodayUsd: today,
    payoutsUsd: state.payoutsUsd ?? 0,
    availableOperatingUsd: available,
    providerBudgetUsd: Math.max(0, budget),
    reserveUsd: p.reserveUsd,
    policy: p,
    health,
    reason,
    simulated: modeReport().simulated,
  };
}

export type AdmissionCode =
  | "ok"
  | "provider-not-configured"
  | "emergency-stop"
  | "no-revenue"
  | "reserve-floor"
  | "daily-cap"
  | "request-ceiling"
  | "session-cap"
  | "model-disabled"
  | "premium-locked";

export interface AdmissionDecision {
  allowed: boolean;
  /**
   * `defer` means the request could succeed later without anything changing
   * except time or revenue; `deny` means it will not succeed by waiting.
   * The distinction is what lets the UI say "try again shortly" honestly
   * instead of inviting a retry that cannot work.
   */
  disposition: "proceed" | "defer" | "deny";
  code: AdmissionCode;
  message: string;
  estimatedCostUsd: number;
  snapshot: FundingSnapshot;
  /** For `defer`: roughly how long until it is worth trying again. */
  retryAfterSec?: number;
}

/**
 * A conservative estimate of what a turn will cost.
 *
 * Deliberately pessimistic — an extra context pass on a multi-step turn is
 * normal, so the estimate assumes more input than the prompt alone implies — and
 * priced from the catalog, not from a provider quote, because no request has
 * been made yet. When the provider later reports its authoritative charge, that
 * figure is what the ledger books; this one only decides whether to start.
 */
export function estimateTurnCostUsd(model: ModelInfo, promptTokens: number): number {
  const inputTokens = Math.max(2_000, promptTokens) * 1.5;
  const outputTokens = Math.min(model.maxOutputTokens ?? 8_192, 4_000);
  return (inputTokens / 1e6) * model.priceIn + (outputTokens / 1e6) * model.priceOut;
}

/**
 * The gate. Called once, before a turn starts.
 *
 * Order matters: the cheapest and most certain refusals are checked first so the
 * message a caller gets is the most specific true one, and a `free` route — one
 * the provider charges $0 for — skips the revenue checks entirely, because
 * refusing a request that costs nothing over a funding rule would be nonsense.
 */
export function admitRequest(opts: {
  model: ModelInfo;
  estimatedCostUsd: number;
  sessionId?: string;
  now?: number;
}): AdmissionDecision {
  const now = opts.now ?? Date.now();
  const snap = fundingSnapshot(now);
  const { model, estimatedCostUsd } = opts;
  const deny = (code: AdmissionCode, message: string): AdmissionDecision => ({
    allowed: false,
    disposition: "deny",
    code,
    message,
    estimatedCostUsd,
    snapshot: snap,
  });
  const defer = (code: AdmissionCode, message: string, retryAfterSec: number): AdmissionDecision => ({
    allowed: false,
    disposition: "defer",
    code,
    message,
    estimatedCostUsd,
    snapshot: snap,
    retryAfterSec,
  });

  if (model.enabled === false) {
    return deny("model-disabled", `${model.label} is disabled on this server.`);
  }

  // A route the provider charges nothing for consumes no revenue, so the
  // funding rules below cannot apply to it. Checked from the *catalog price*,
  // which is the number the ledger would use; a "free" badge on a priced model
  // would be worse than no badge at all.
  const costsNothing =
    model.free === true && model.priceIn === 0 && model.priceOut === 0 && estimatedCostUsd <= 0;

  const p = snap.policy;
  if (p.emergencyStop) {
    return deny("emergency-stop", "Spending is stopped by the operator (emergency stop). New requests are refused.");
  }
  if (!providerConfigured()) {
    return deny("provider-not-configured", "AI provider is not configured.");
  }
  if (costsNothing) {
    return {
      allowed: true,
      disposition: "proceed",
      code: "ok",
      message: `${model.label} is served at no provider cost, so no ad revenue is consumed.`,
      estimatedCostUsd,
      snapshot: snap,
    };
  }

  // Premium tier is gated by the model's own threshold as well as the policy.
  const required = model.requiresBalanceUsd ?? 0;
  if (required > 0 && snap.availableOperatingUsd < required) {
    return deny(
      "premium-locked",
      `${model.label} needs $${required.toFixed(2)} of collectible revenue and the account holds $${snap.availableOperatingUsd.toFixed(4)}.`,
    );
  }
  if (p.maxRequestCostUsd > 0 && estimatedCostUsd > p.maxRequestCostUsd) {
    return deny(
      "request-ceiling",
      `This turn is predicted to cost $${estimatedCostUsd.toFixed(4)}, above the $${p.maxRequestCostUsd.toFixed(2)} per-request ceiling. Pick a cheaper model or raise the ceiling.`,
    );
  }
  if (model.maxTurnCostUsd !== undefined && estimatedCostUsd > model.maxTurnCostUsd) {
    return deny(
      "request-ceiling",
      `${model.label} is capped at $${model.maxTurnCostUsd.toFixed(4)} per turn and this one is predicted at $${estimatedCostUsd.toFixed(4)}.`,
    );
  }
  // Ad revenue does NOT gate an ordinary model request, and that is a correction
  // rather than an omission.
  //
  // These three checks used to sit here: no confirmed revenue → defer everything;
  // provider budget exhausted → defer; turn costs more than the budget → defer.
  // Their effect was that a fresh install could not run a single turn. Connect a
  // real OpenRouter credential, confirm the key works against the provider, and
  // the agent still refused every request until an advertiser had paid — a cliff
  // between "connected" and "usable" with nothing in between, and not how the
  // product is meant to work.
  //
  // Freebuff's free mode is the reference: their server grants a model call at
  // zero credits because *their* provider account pays for it, and the ads the
  // client shows are what fund that account. The equivalent here is the
  // deployment's own credential (see `credentials.ts`) — it is what the provider
  // actually bills — so ad revenue's job is to *cover* that bill, not to
  // authorise each call in advance. The ledger still measures coverage exactly
  // (confirmed revenue − spend − payouts), `fundingSnapshot().health` reports
  // whether ads are keeping up, and the reserve tier below is still earned.
  //
  // What still refuses, and why those are the right things to keep:
  //   · no credential at all → nothing could pay, so nothing may run
  //   · emergency stop, daily cap, per-session cap → the operator's brakes
  //   · per-request ceiling and the reserve tier → a runaway bill stays
  //     impossible, which is the protection the old gate was really providing
  if (p.dailySpendCapUsd > 0 && snap.spendTodayUsd + estimatedCostUsd > p.dailySpendCapUsd) {
    return defer(
      "daily-cap",
      `Today's spend ($${snap.spendTodayUsd.toFixed(4)}) plus this turn would pass the $${p.dailySpendCapUsd.toFixed(2)} daily cap.`,
      // Roughly how long until the next day rolls over, so "try again" is a
      // real instruction rather than a shrug.
      Math.max(60, Math.ceil((startOfToday(now) + 86_400_000 - now) / 1000)),
    );
  }
  if (p.perSessionDailyRequests > 0) {
    const used = requestsToday(allEntries(), now);
    if (used >= p.perSessionDailyRequests) {
      return defer(
        "session-cap",
        `This session has started ${used} requests today, at the configured ceiling of ${p.perSessionDailyRequests}.`,
        Math.max(60, Math.ceil((startOfToday(now) + 86_400_000 - now) / 1000)),
      );
    }
  }

  // Admitted because the deployment holds a credential that the provider will
  // bill. The message states the coverage position rather than implying the ad
  // revenue authorised the call, because it did not.
  const covered = snap.confirmedRevenueUsd >= snap.spendUsd + snap.payoutsUsd;
  return {
    allowed: true,
    disposition: "proceed",
    code: "ok",
    message: covered
      ? `Paid on the deployment's credential. Ads cover it: $${snap.confirmedRevenueUsd.toFixed(4)} collected against $${snap.spendUsd.toFixed(4)} of provider spend.`
      : `Paid on the deployment's credential. Ads have not caught up yet: $${snap.confirmedRevenueUsd.toFixed(4)} collected against $${snap.spendUsd.toFixed(4)} of provider spend.`,
    estimatedCostUsd,
    snapshot: snap,
  };
}
