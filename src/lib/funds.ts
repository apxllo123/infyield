import { allEntries, getState } from "./economy";
import { isAdvertiserBacked, listCampaigns } from "./ads";

/**
 * What the ads have actually earned — as opposed to what the ledger says.
 *
 * The ledger's `adRevenueUsd` is "confirmed" revenue, but on a fresh install most
 * or all of it comes from seeded first-party campaigns that have no advertiser
 * behind them. Those impressions credit the numbers exactly like real ones and
 * will never be paid by anybody.
 *
 * Money is only collectible when somebody is on the hook for it:
 *
 *  - a campaign with a paying advertiser on record and an issued/paid invoice
 *    (see `attachAdvertiser` in ads.ts), or
 *  - network revenue, which the ad network reconciles and pays on its own
 *    schedule.
 *
 * Network revenue needs saying precisely, because it does not arrive the way the
 * other kind does. An accepted network impression is credited to the *pending*
 * bucket (`creditEstimatedRevenue`) and writes no ledger entry at all; it only
 * becomes a ledger entry when `reconcileRevenue` moves the statement's amount
 * from pending into confirmed, and that entry's kind is `reconcile`. Counting
 * only `ad-impression`/`ad-click` therefore missed every dollar the network paid:
 * reconciled revenue was neither collectible (so it could not unlock the reserve
 * tier) nor payable (so it could not be withdrawn). Pending revenue stays
 * non-collectible on purpose — the network has not paid it yet.
 *
 * Everything that decides how much real money may be spent depends on this:
 *
 *  - the reserve tier gate (`premium.ts`), which must not unlock expensive models
 *    on the strength of revenue that cannot settle a bill;
 *  - the budget-adaptive ad cadence (`autosetup.ts`, `routing.ts`), which would
 *    otherwise think the account is flush — and serve ads *relaxed* — while it
 *    cannot actually afford the next model call.
 *
 * It lives in its own module because `economy.ts` and `ads.ts` are mutually
 * entangled by the recording path, so neither can host it.
 */

function backedCampaignIds(): Set<string> {
  return new Set(listCampaigns().filter(isAdvertiserBacked).map((c) => c.id));
}

export interface RevenueBreakdown {
  /** Revenue with a party on the hook for it: invoiced campaigns + network. */
  collectibleUsd: number;
  /** Booked revenue from placeholder inventory. Counts, but never gets paid. */
  placeholderUsd: number;
  /** Sum of every ad impression/click entry, i.e. the displayed confirmed total. */
  confirmedUsd: number;
  /** Campaign ids currently able to settle a bill. */
  backedCampaignIds: string[];
}

/**
 * The full split, from the untruncated ledger.
 *
 * Sums entries rather than reading the running totals, so each dollar is
 * attributed to the campaign that earned it. `getState().entries` is capped for
 * display, which is why this walks `allEntries()` instead.
 */
export function revenueBreakdown(): RevenueBreakdown {
  const backed = backedCampaignIds();
  let collectible = 0;
  for (const entry of allEntries()) {
    // `reconcile` entries are network revenue whose statement landed; the other
    // two are advertiser-campaign impressions and clicks.
    if (entry.kind !== "ad-impression" && entry.kind !== "ad-click" && entry.kind !== "reconcile") continue;
    // Network impressions/clicks have no campaign id; the network pays those.
    if (!entry.campaignId) {
      collectible += entry.delta;
      continue;
    }
    if (backed.has(entry.campaignId)) collectible += entry.delta;
  }
  const confirmed = getState().adRevenueUsd;
  return {
    collectibleUsd: collectible,
    placeholderUsd: Math.max(0, confirmed - collectible),
    confirmedUsd: confirmed,
    backedCampaignIds: [...backed],
  };
}

/** Ad revenue that can genuinely settle a bill. */
export function collectibleRevenueUsd(): number {
  return revenueBreakdown().collectibleUsd;
}

/** Confirmed revenue from inventory nobody is going to pay for. */
export function placeholderRevenueUsd(): number {
  return revenueBreakdown().placeholderUsd;
}

/** Collectible revenue minus spend and payouts: what is genuinely left to spend. */
export function spendableUsd(): number {
  const s = getState();
  return collectibleRevenueUsd() - s.spendUsd - (s.payoutsUsd ?? 0);
}
