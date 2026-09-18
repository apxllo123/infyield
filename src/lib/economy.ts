import type { EconomyState, LedgerEntry } from "./types";
import { readJson, writeJson } from "./store";

/**
 * The economy ledger, in USD.
 *
 * Two sides: advertising credits revenue, model calls debit spend. The product
 * promise — a guest pays nothing and Infyield pays the provider out of ad
 * revenue — is only checkable if the two sides are *separate* and every entry
 * can be traced to the external thing that caused it.
 *
 * ## The buckets, and why one number is not enough
 *
 * ```
 *   estimatedRevenueUsd   network impressions the network has not yet paid for
 *   adRevenueUsd          booked revenue — see the split below
 *   spendUsd              what providers charged
 *   payoutsUsd            money already sent out of the account
 * ```
 *
 * `adRevenueUsd` is not the same as "money". Whether a booked dollar has a payer
 * behind it depends on the campaign, and that judgement lives in `funds.ts`,
 * which owns `collectibleRevenueUsd()`. Keeping the rule there and the totals
 * here is what lets this file stay a plain book of record.
 *
 * ## Every entry carries its evidence
 *
 * `sourceId` is the provider's request id or the ad event id; `origin` says whose
 * money it is; `costMethod` says whether the figure came from the provider or
 * from a price table. Without those, a balance is unauditable: you can see that
 * $0.07 moved and not which request moved it, which is precisely the state in
 * which a system mistakes its own bookkeeping for income.
 *
 * ## Pending is never spendable
 *
 * Network revenue books as pending (`creditEstimatedRevenue`) and only becomes
 * confirmed when the network's statement is reconciled into it. Nothing may
 * budget against an estimate.
 */
const FILE = "economy.json";

interface EconomyFile {
  adRevenueUsd: number;
  estimatedRevenueUsd: number;
  spendUsd: number;
  payoutsUsd: number;
  refundsUsd: number;
  impressions: number;
  clicks: number;
  entries: LedgerEntry[];
  /**
   * The next entry id to issue. Optional because a file written before this
   * field existed does not have it; see `nextEntryId()`.
   */
  nextEntryId?: number;
}

function load(): EconomyFile {
  return readJson<EconomyFile>(FILE, {
    adRevenueUsd: 0,
    estimatedRevenueUsd: 0,
    spendUsd: 0,
    payoutsUsd: 0,
    refundsUsd: 0,
    impressions: 0,
    clicks: 0,
    entries: [],
  });
}

function save(e: EconomyFile): void {
  writeJson(FILE, e);
}

function push(e: EconomyFile, entry: Omit<LedgerEntry, "id" | "ts">): void {
  const id = nextEntryId(e);
  e.nextEntryId = id + 1;
  e.entries.unshift({ id, ts: Date.now(), ...entry });
  e.entries = e.entries.slice(0, LEDGER_ENTRY_CAP);
}

/** The highest id present in a set of entries, or 0 when there are none. */
function highestEntryId(entries: LedgerEntry[]): number {
  let max = 0;
  for (const x of entries) {
    const id = Number(x?.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

/**
 * The next entry id, from a counter that only ever moves forward.
 *
 * The id used to be `entries.length + 1`, which was right until the array hit
 * its 500-entry cap: from then on the length stayed at 500 while `slice` dropped
 * the oldest entry, so every new entry was issued id 501 — the same id the entry
 * already holding 501 had. Two ledger lines sharing an id are indistinguishable
 * to anything that keys on one (attribution, receipt matching, a correction
 * entry), which is why an id may not be derived from the array's current shape.
 *
 * A file written before this field existed has no counter. It is not migrated and
 * never rewritten just to add one: the fallback is one more than the highest id
 * the file already carries (entries are newest-first, so that is the head). Old
 * and new files therefore agree on what comes next, and an existing
 * `economy.json` needs no migration to be read.
 */
function nextEntryId(e: EconomyFile): number {
  const stored = Number(e.nextEntryId);
  if (Number.isFinite(stored) && stored > 0) return Math.floor(stored);
  return highestEntryId(e.entries) + 1;
}

/** Provenance shared by every entry kind, so no write can omit it by habit. */
export interface EntryEvidence {
  campaignId?: string;
  /** The provider request id or the ad network event/creative id. */
  sourceId?: string;
  origin?: LedgerEntry["origin"];
  provider?: string;
  costMethod?: LedgerEntry["costMethod"];
}

export function creditAdRevenue(
  amount: number,
  kind: "ad-impression" | "ad-click" | "grant",
  note: string,
  evidence: EntryEvidence = {},
): EconomyState {
  const e = load();
  e.adRevenueUsd += amount;
  if (kind === "ad-impression") e.impressions += 1;
  if (kind === "ad-click") e.clicks += 1;
  push(e, { delta: amount, kind, note, ...evidence });
  save(e);
  return getState();
}

/**
 * A network ad rendered and the network accepted it.
 *
 * Booked as pending, not confirmed: the network counts the impression on its own
 * side and pays on its own schedule, and Infyield has not yet been told what it
 * is worth or that it will be paid. `sourceId` is the network's creative id so
 * the eventual statement can be matched against it.
 */
export function creditEstimatedRevenue(
  amount: number,
  note: string,
  evidence: EntryEvidence = {},
  tally: "impression" | "click" = "impression",
): EconomyState {
  const e = load();
  e.estimatedRevenueUsd += amount;
  // A network click is not an impression. The previous tally always incremented
  // `impressions`, so a click-through inflated delivery counts and under-counted
  // the actual click.
  if (tally === "click") e.clicks += 1;
  else e.impressions += 1;
  push(e, {
    delta: amount,
    kind: "estimate",
    note,
    pending: true,
    costMethod: "estimated",
    ...evidence,
    origin: evidence.origin ?? "network",
  });
  save(e);
  return getState();
}

/**
 * The network's statement arrived: move pending revenue into confirmed.
 *
 * Bounded by what is actually pending. Reconciling more than the pending balance
 * would be inventing confirmed revenue out of nothing, which is the single most
 * damaging thing this file could be made to do.
 */
export function reconcileRevenue(
  amount?: number,
  note?: string,
  evidence: EntryEvidence = {},
): EconomyState | { error: string } {
  const e = load();
  const amountIn = amount === undefined ? e.estimatedRevenueUsd : Number(amount);
  if (!Number.isFinite(amountIn) || amountIn < 0) return { error: "Reconciliation amount must be a positive number." };
  if (amountIn > e.estimatedRevenueUsd + 1e-9) {
    return { error: `Only $${e.estimatedRevenueUsd.toFixed(4)} is pending reconciliation.` };
  }
  e.estimatedRevenueUsd -= amountIn;
  e.adRevenueUsd += amountIn;
  push(e, {
    delta: amountIn,
    kind: "reconcile",
    note: note || "Reconciled pending network revenue into confirmed",
    origin: "network",
    ...evidence,
  });
  save(e);
  return getState();
}

export interface SpendEvidence extends EntryEvidence {
  /** The server-side usage record this debit came from. */
  requestId?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export function recordSpend(
  amount: number,
  note: string,
  model?: string,
  evidence: SpendEvidence = {},
): EconomyState {
  const e = load();
  e.spendUsd += amount;
  push(e, {
    delta: -amount,
    kind: "spend",
    note,
    ...(model ? { model } : {}),
    ...evidence,
    origin: evidence.origin ?? "provider",
    ...(evidence.requestId ? { sourceId: evidence.requestId } : {}),
  });
  save(e);
  return getState();
}

/**
 * Money returned by a provider — a failed run, a billing correction.
 *
 * A distinct kind rather than a negative spend: netting it into `spendUsd` would
 * make "what we were charged" and "what we got back" a single number, and the
 * two are what a reconciliation compares.
 */
export function recordRefund(amount: number, note: string, evidence: EntryEvidence = {}): EconomyState | { error: string } {
  if (!(amount > 0)) return { error: "Refund amount must be positive." };
  const e = load();
  e.refundsUsd = (e.refundsUsd ?? 0) + amount;
  // Its own kind, and so excluded from the ad-revenue identity: a refund is
  // money the provider gave back, not advertising somebody was charged for.
  push(e, { delta: amount, kind: "refund", note, origin: "provider", ...evidence });
  save(e);
  return getState();
}

/** A manual correction, always requiring a note saying why. */
export function recordAdjustment(amount: number, note: string): EconomyState {
  const e = load();
  e.adRevenueUsd += amount;
  push(e, { delta: amount, kind: "grant", note, origin: "operator" });
  save(e);
  return getState();
}

/** Payout moves confirmed revenue out to the operator's real account. */
export function recordPayout(amount: number, note: string): EconomyState | { error: string } {
  const e = load();
  const available = e.adRevenueUsd - (e.payoutsUsd ?? 0);
  if (amount <= 0) return { error: "Payout amount must be positive." };
  if (amount > available + 1e-9) return { error: `Only $${available.toFixed(2)} confirmed ad revenue is available.` };
  e.payoutsUsd = (e.payoutsUsd ?? 0) + amount;
  push(e, { delta: -amount, kind: "payout", note, origin: "operator" });
  save(e);
  return getState();
}

export function getState(): EconomyState {
  const e = load();
  const payouts = e.payoutsUsd ?? 0;
  const refunds = e.refundsUsd ?? 0;
  const estimated = e.estimatedRevenueUsd ?? 0;
  return {
    adRevenueUsd: e.adRevenueUsd,
    estimatedRevenueUsd: estimated,
    spendUsd: e.spendUsd,
    payoutsUsd: payouts,
    balanceUsd: e.adRevenueUsd - e.spendUsd - payouts,
    availableUsd: e.adRevenueUsd - payouts,
    impressions: e.impressions,
    clicks: e.clicks,
    // The UI only ever renders the tail; arithmetic must not read this field.
    entries: e.entries.slice(0, 50),
    // The five concepts, kept distinct. `confirmedUsd` includes house-inventory
    // bookings because that is what the ledger holds; `funds.ts` is what decides
    // how much of it somebody is actually on the hook to pay.
    pendingUsd: estimated,
    confirmedUsd: e.adRevenueUsd,
    modelSpendUsd: e.spendUsd,
    netUsd: e.adRevenueUsd - e.spendUsd + refunds,
  };
}

/**
 * The whole ledger, untruncated.
 *
 * `getState().entries` is capped for display. Anything that sums entries
 * (per-campaign accrual, collectible revenue, spend-today) has to read them all,
 * or the figure silently stops growing once a busy day pushes old entries off
 * the tail — which would under-report what an advertiser actually owes.
 *
 * The 500-entry cap `push()` applies is therefore a real limitation, not a
 * display one, and is called out here so nobody has to rediscover it: revenue
 * attribution beyond 500 entries needs a store that is not a JSON file.
 */
export function allEntries(): LedgerEntry[] {
  return load().entries;
}

const LEDGER_ENTRY_CAP = 500;
