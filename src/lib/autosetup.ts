import type { FundingPolicy } from "./types";
import { getSettings, saveSettings } from "./settings";

import { seedHouseAdsIfEmpty } from "./ads";
import { getState } from "./economy";
import { collectibleRevenueUsd, placeholderRevenueUsd, spendableUsd } from "./funds";
import { allProviderStatus, providerConfigured, providerStatus } from "./credentials";
import { modeReport } from "./mode";
import { readJson, writeJson } from "./store";
import { warnIfUnprotected } from "./auth";

/**
 * Zero-config bootstrap.
 *
 * A fresh install must already be usable, which in this build means Infyield
 * holds its own provider credential and the ads the app serves fund that bill.
 * Nothing is asked of the person chatting: no key, no account, no per-chat
 * setup.
 *
 * What this file deliberately no longer does is pool credentials from the
 * environment into a per-request key pool. That indirection existed to support
 * two billing models at once — the operator's keys and the caller's — and it is
 * exactly the ambiguity that let a caller's own account be reported as
 * ad-funded. Credentials are now read directly, server-side, by
 * `credentials.ts`, and there is one billing model: Infyield's.
 */
const MARKER = "autosetup.json";

interface Marker {
  settingsImported?: boolean;
}

function readMarker(): Marker {
  return readJson<Marker>(MARKER, {});
}

/** Settings the operator can pre-set through the environment, applied once so
 * later UI edits are never clobbered. */
function importEnvSettings(): void {
  const marker = readMarker();
  if (marker.settingsImported) return;
  const s = getSettings();
  const publisher = (process.env.INFYIELD_ETHICALADS_PUBLISHER ?? "").trim();
  const carbon = (process.env.INFYIELD_CARBON_PLACEMENT ?? "").trim();
  const funding = fundingFromEnv();
  const ads = { ...s.ads };
  let useNetwork = false;
  if (publisher && !ads.ethicalAdsPublisherId) {
    ads.ethicalAdsPublisherId = publisher;
    ads.network = "ethicalads";
    useNetwork = true;
  }
  if (carbon && !ads.carbonPlacementId) {
    ads.carbonPlacementId = carbon;
    // Carbon only wins the slot if EthicalAds was not also provisioned.
    if (ads.network !== "ethicalads") ads.network = "carbon";
    useNetwork = true;
  }
  saveSettings({
    ...s,
    ads,
    ...(useNetwork ? { useNetworkAds: true } : {}),
    ...(Object.keys(funding).length ? { funding: { ...s.funding, ...funding } as FundingPolicy } : {}),
  });
  writeJson(MARKER, { ...marker, settingsImported: true });
}

/**
 * The funding policy, overridable from the environment.
 *
 * Environment-first so a deployment can tighten the limits without editing a
 * settings file inside the app, and so the verification suites can set a policy
 * a human would never type. An unparseable value is ignored rather than treated
 * as zero: a typo in a spend limit must not silently become "spend nothing" or,
 * worse, fall through to a default that spends everything.
 */
function fundingFromEnv(): Partial<FundingPolicy> {
  const num = (name: string): number | undefined => {
    const raw = (process.env[name] ?? "").trim();
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const flag = (name: string): boolean | undefined => {
    const raw = (process.env[name] ?? "").trim().toLowerCase();
    if (!raw) return undefined;
    return raw === "1" || raw === "true" || raw === "yes";
  };
  return {
    ...(num("INFYIELD_RESERVE_USD") !== undefined ? { reserveUsd: num("INFYIELD_RESERVE_USD")! } : {}),
    ...(num("INFYIELD_DAILY_SPEND_CAP_USD") !== undefined
      ? { dailySpendCapUsd: num("INFYIELD_DAILY_SPEND_CAP_USD")! }
      : {}),
    ...(num("INFYIELD_MAX_REQUEST_USD") !== undefined
      ? { maxRequestCostUsd: num("INFYIELD_MAX_REQUEST_USD")! }
      : {}),
    ...(num("INFYIELD_MAX_DAILY_REQUESTS") !== undefined
      ? { perSessionDailyRequests: num("INFYIELD_MAX_DAILY_REQUESTS")! }
      : {}),
    ...(flag("INFYIELD_EMERGENCY_STOP") !== undefined
      ? { emergencyStop: flag("INFYIELD_EMERGENCY_STOP")! }
      : {}),
  };
}

export interface FundingStatus {
  /**
   * `sponsored` — Infyield holds a credential and funds the calls from ad
   * revenue. `unfunded` — it holds none, so nothing can be served.
   *
   * There is no BYOK mode. It was removed rather than defaulted away, because a
   * mode that exists is a mode that can be selected by accident.
   */
  mode: "sponsored" | "unfunded";
  ready: boolean;
  /** Whether Infyield's own provider credential is present. */
  hasOperatorKey: boolean;
  estimatedRevenueUsd: number;
  /** Booked ad revenue, including house inventory nobody will pay. */
  confirmedRevenueUsd: number;
  spendUsd: number;
  /** Booked minus spend and payouts. Kept for compatibility; prefer spendableUsd. */
  balanceUsd: number;
  /** Revenue an advertiser or network is on the hook to pay. */
  collectibleRevenueUsd: number;
  /** Booked revenue from house inventory with no advertiser behind it. */
  placeholderRevenueUsd: number;
  /** Collectible minus spend minus payouts — the figure `adPressure` reads. */
  spendableUsd: number;
  /** 0 = relaxed, 2 = ads serving as hard as they can */
  adPressure: number;
  adBudgetPerResponse: number;
  /** Which providers Infyield holds credentials for — never the credentials. */
  providers: { provider: string; configured: boolean; source: string | null }[];
  simulated: boolean;
}

/**
 * How hard ads should work right now: thin funds → more impressions.
 *
 * Deliberately keyed on SPENDABLE revenue, not the ledger balance. The ledger's
 * booked figure includes house inventory, so a fresh install reads as
 * comfortably funded while it cannot actually afford the next model call —
 * which had the adaptive cadence serving ads *relaxed* exactly when money was
 * most needed.
 */
export function fundingPressure(): number {
  const bal = spendableUsd();
  if (bal >= 1) return 0;
  if (bal >= 0.25) return 1;
  return 2;
}

export function adBudgetPerResponse(): number {
  const p = fundingPressure();
  if (p === 2) return 3;
  if (p === 1) return 2;
  return 1;
}

export function fundingStatus(): FundingStatus {
  const e = getState();
  // One predicate, shared with the reserve-tier gate and the health surface, so
  // the three can never disagree about whether the ads are paying.
  const hasOperatorKey = providerConfigured();
  return {
    mode: hasOperatorKey ? "sponsored" : "unfunded",
    ready: hasOperatorKey,
    hasOperatorKey,
    estimatedRevenueUsd: e.estimatedRevenueUsd,
    confirmedRevenueUsd: e.adRevenueUsd,
    spendUsd: e.spendUsd,
    balanceUsd: e.balanceUsd,
    collectibleRevenueUsd: collectibleRevenueUsd(),
    placeholderRevenueUsd: placeholderRevenueUsd(),
    spendableUsd: spendableUsd(),
    adPressure: fundingPressure(),
    adBudgetPerResponse: adBudgetPerResponse(),
    providers: allProviderStatus().map((s) => ({
      provider: s.provider,
      configured: s.configured,
      source: s.source,
    })),
    simulated: modeReport().simulated,
  };
}

/**
 * The exact variable names an operator still has to set.
 *
 * Flat, not grouped: a startup check that says "OPENROUTER_API_KEY or
 * INFYIELD_OPENROUTER_KEY" as one string cannot be matched against, and a
 * consumer that wants to name the alternatives can join them itself.
 */
export function missingProviderHint(): string[] {
  return allProviderStatus().flatMap((s) => (s.configured ? [] : s.envVars));
}

/** Runs on every bootstrap/chat request; cheap after the first time. */
export function runAutoSetup(): { importedKeys: string[] } {
  seedHouseAdsIfEmpty();
  importEnvSettings();
  // Say it once, on the first request, when the deployment has no password: an
  // unauthenticated server is then loopback-only, and the operator should learn
  // that from the log rather than from the source. See src/lib/auth.ts.
  warnIfUnprotected();
  // No keys are imported any more: the credential layer reads the environment
  // directly, so there is nothing to pool and nothing to rotate.
  return { importedKeys: [] };
}

export { providerStatus };
