import { allEntries, getState } from "./economy";
import { listUsage, type UsageRecord } from "./usage";
import { adPipeline, listAdEvents } from "./adlifecycle";
import { revenueBreakdown } from "./funds";
import { modeReport } from "./mode";

/**
 * Reconciliation: does the book of record agree with the things it describes?
 *
 * Everything in this app is a claim about an external event — a provider charged
 * this much, an advertiser owes this much. Bookkeeping can be internally perfect
 * and still be describing something that did not happen, so each check below
 * compares the ledger against a *second* source: the usage records for spend,
 * the ad events for delivery, and the arithmetic identity for the totals.
 *
 * Two severities, and the difference matters:
 *
 *   `error`   — the ledger disagrees with itself, or a figure has no external
 *               support at all. Money is being described wrongly.
 *   `warning` — the ledger is fine but something is unverifiable or drifting: an
 *               entry with no source id, a price table that no longer matches
 *               what providers charge, an impression nobody verified.
 *
 * Nothing here silently corrects anything. A reconciliation that edits the books
 * to make itself pass is worse than no reconciliation, so this only reports.
 */

export interface Discrepancy {
  severity: "error" | "warning";
  code: string;
  detail: string;
}

export interface ReconcileReport {
  ok: boolean;
  errors: number;
  warnings: number;
  discrepancies: Discrepancy[];
  /** Every figure the checks compared, so a report can be read without rerunning. */
  figures: {
    ledgerEntries: number;
    bookedRevenueUsd: number;
    confirmedByKindUsd: number;
    pendingBookedUsd: number;
    pendingByKindUsd: number;
    spendUsd: number;
    usageSettledUsd: number;
    collectibleUsd: number;
    houseRevenueUsd: number;
    unverifiableSpendEntries: number;
    unverifiableRevenueEntries: number;
    adServes: number;
    adVerified: number;
    unverifiedServes: number;
  };
  simulated: boolean;
  checkedAt: number;
}

/** Requests left `running` past this are treated as abandoned, not in flight. */
const STALE_REQUEST_MS = 15 * 60 * 1000;
/** Provider-vs-catalog price disagreement worth reporting. */
const PRICE_DRIFT_RATIO = 0.25;

const EPS = 1e-6;

export function reconcileAll(now = Date.now()): ReconcileReport {
  const entries = allEntries();
  const state = getState();
  const usage = listUsage(1_000);
  const adEvents = listAdEvents(1_000);
  const pipeline = adPipeline();
  const breakdown = revenueBreakdown();
  const discrepancies: Discrepancy[] = [];

  const add = (severity: Discrepancy["severity"], code: string, detail: string) =>
    discrepancies.push({ severity, code, detail });

  /* ---- 1. Ad revenue booked by kind must equal the revenue total ---------- */
  let confirmedByKind = 0;
  let estimateKind = 0;
  let reconcileKind = 0;
  let unverifiableRevenueEntries = 0;
  for (const e of entries) {
    const revenueKind =
      e.kind === "ad-impression" || e.kind === "ad-click" || e.kind === "reconcile" || e.kind === "grant";
    if (revenueKind) {
      confirmedByKind += e.delta;
      // `grant` is an operator adjustment and `reconcile` is a network
      // statement — neither is a single delivery event, so neither has (or
      // needs) an event id. Everything else must name the ad event it came from.
      if (!e.sourceId && e.kind !== "grant" && e.kind !== "reconcile") unverifiableRevenueEntries += 1;
    }
    if (e.kind === "estimate") estimateKind += e.delta;
    if (e.kind === "reconcile") reconcileKind += e.delta;
  }
  // Reconciliation *draws on* the pending bucket, so what remains pending is
  // what was estimated minus what has since been confirmed. Summing the
  // `estimate` entries alone would report the original estimate forever and
  // flag a correct ledger as broken.
  const pendingByKind = estimateKind - reconcileKind;
  if (Math.abs(confirmedByKind - state.adRevenueUsd) > 1e-4) {
    add(
      "error",
      "revenue-total-mismatch",
      `Booked revenue is $${state.adRevenueUsd.toFixed(6)} but its entries sum to $${confirmedByKind.toFixed(6)}.`,
    );
  }
  if (Math.abs(pendingByKind - state.estimatedRevenueUsd) > 1e-4) {
    add(
      "error",
      "pending-total-mismatch",
      `Pending revenue is $${state.estimatedRevenueUsd.toFixed(6)} but its entries sum to $${pendingByKind.toFixed(6)}.`,
    );
  }

  /* ---- 2. Spend must equal what the settled usage records charged --------- */
  const settled = usage.filter((r) => r.status !== "running");
  const usageSettledUsd = settled.reduce((n, r) => n + r.costUsd, 0);
  if (Math.abs(usageSettledUsd - state.spendUsd) > 1e-4) {
    add(
      "error",
      "spend-mismatch",
      `Ledger spend is $${state.spendUsd.toFixed(6)} but settled usage records total $${usageSettledUsd.toFixed(6)}. Entries predating usage accounting, or a debit with no record, would explain this.`,
    );
  }

  /* ---- 3. Every spend entry must name the request it came from ----------- */
  let unverifiableSpendEntries = 0;
  for (const e of entries) {
    if (e.kind !== "spend") continue;
    if (!e.sourceId) {
      unverifiableSpendEntries += 1;
    }
  }
  if (unverifiableSpendEntries > 0) {
    add(
      "warning",
      "spend-entry-without-source",
      `${unverifiableSpendEntries} spend entr${unverifiableSpendEntries === 1 ? "y has" : "ies have"} no request id, so the charge cannot be traced to a provider record.`,
    );
  }
  if (unverifiableRevenueEntries > 0) {
    add(
      "warning",
      "revenue-entry-without-source",
      `${unverifiableRevenueEntries} revenue entr${unverifiableRevenueEntries === 1 ? "y has" : "ies have"} no ad event id.`,
    );
  }

  /* ---- 4. Stale in-flight requests --------------------------------------- */
  const stale = usage.filter((r) => r.status === "running" && now - r.startedAt > STALE_REQUEST_MS);
  if (stale.length > 0) {
    add(
      "warning",
      "stale-requests",
      `${stale.length} model request${stale.length === 1 ? "" : "s"} never finished recording — the provider may have charged for work whose outcome we never saw.`,
    );
  }

  /* ---- 5. Price-table drift, per settled request with a reported cost ---- */
  const drifting = settled.filter((r) => {
    if (r.costMethod !== "provider-reported" || r.calculatedCostUsd <= 0) return false;
    const base = Math.max(r.providerCostUsd ?? 0, 1e-9);
    return Math.abs((r.providerCostUsd ?? 0) - r.calculatedCostUsd) / base > PRICE_DRIFT_RATIO;
  });
  if (drifting.length > 0) {
    add(
      "warning",
      "catalog-price-drift",
      `${drifting.length} request${drifting.length === 1 ? "" : "s"} cost more than ${Math.round(PRICE_DRIFT_RATIO * 100)}% away from the catalog price — the price table needs revisiting, or provider routing is picking costlier upstreams than the ceiling allows.`,
    );
  }

  /* ---- 6. Ad delivery: a serve nobody verified earned nothing ------------ */
  const verifiedByImpression = new Set(adEvents.filter((e) => e.type === "verified").map((e) => e.impressionId));
  const unverifiedServes = adEvents.filter(
    (e) => e.type === "served" && e.impressionId && !verifiedByImpression.has(e.impressionId),
  ).length;
  if (unverifiedServes > 0) {
    add(
      "warning",
      "unverified-serves",
      `${unverifiedServes} ad${unverifiedServes === 1 ? "" : "s"} were served but never verified by the provider, so they earned nothing.`,
    );
  }

  /* ---- 7. The arithmetic identity the whole ledger rests on ------------- */
  const payouts = state.payoutsUsd ?? 0;
  const netFromEntries = confirmedByKind - state.spendUsd - payouts;
  const netFromState = state.adRevenueUsd - state.spendUsd - payouts;
  if (Math.abs(netFromEntries - netFromState) > 1e-4) {
    add(
      "error",
      "identity-broken",
      `Entries and totals disagree on the operating net ($${netFromEntries.toFixed(6)} vs $${netFromState.toFixed(6)}).`,
    );
  }

  /* ---- 8. Confirmed revenue cannot be spent twice ----------------------- */
  if (state.spendUsd + payouts > state.adRevenueUsd + EPS && state.spendUsd > EPS) {
    // Not an error: a deployment can be in the red. But it must be *visible*,
    // because every funding decision downstream assumes it cannot go lower.
    add(
      "warning",
      "overdrawn",
      `Spend plus payouts ($${(state.spendUsd + payouts).toFixed(4)}) exceed booked revenue ($${state.adRevenueUsd.toFixed(4)}). The provider budget is zero and requests will be deferred until revenue is confirmed.`,
    );
  }

  /* ---- 9. Collectible must never exceed booked -------------------------- */
  if (breakdown.collectibleUsd > state.adRevenueUsd + EPS) {
    add(
      "error",
      "collectible-exceeds-booked",
      `Collectible revenue ($${breakdown.collectibleUsd.toFixed(6)}) exceeds booked revenue ($${state.adRevenueUsd.toFixed(6)}), which would let more be spent than was ever earned.`,
    );
  }

  const errors = discrepancies.filter((d) => d.severity === "error").length;
  const warnings = discrepancies.length - errors;

  return {
    ok: errors === 0,
    errors,
    warnings,
    discrepancies,
    figures: {
      ledgerEntries: entries.length,
      bookedRevenueUsd: state.adRevenueUsd,
      confirmedByKindUsd: confirmedByKind,
      pendingBookedUsd: state.estimatedRevenueUsd,
      pendingByKindUsd: pendingByKind,
      spendUsd: state.spendUsd,
      usageSettledUsd,
      collectibleUsd: breakdown.collectibleUsd,
      houseRevenueUsd: breakdown.placeholderUsd,
      unverifiableSpendEntries,
      unverifiableRevenueEntries,
      adServes: pipeline.served,
      adVerified: pipeline.verified,
      unverifiedServes,
    },
    simulated: modeReport().simulated,
    checkedAt: now,
  };
}
