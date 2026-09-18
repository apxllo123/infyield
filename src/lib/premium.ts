import type { AdsSettings, ModelInfo } from "./types";
import { MODELS } from "./models";
import { getState } from "./economy";
import { listCampaigns } from "./ads";
import { getSettings } from "./settings";
import { usingServerCredential } from "./credentials";
import { collectibleRevenueUsd, placeholderRevenueUsd, revenueBreakdown, spendableUsd } from "./funds";
import { fundingPressure } from "./autosetup";

/**
 * The premium tier: front-line models that ad revenue has to earn its way up to.
 *
 * The product's promise is that ads pay for the agent. For the everyday catalog
 * that works comfortably — a turn costs a fraction of a cent. For the top of the
 * catalog it does not: a single multi-step turn on o1-pro or GPT-5.5 Pro can cost
 * more than hundreds of ad impressions are worth. Letting those run against an
 * empty ledger would mean spending money the ads have not earned, which is the
 * one thing this product must never do.
 *
 * So a premium model declares `requiresBalanceUsd`, and the router refuses below
 * it. The check only applies to ad-funded serving: when the caller brought their
 * own provider key (BYOK) their provider account is billed directly, the ledger
 * is not the constraint, and gating would be meaningless friction.
 *
 * Everything in here is arithmetic over the real ledger and the real configured
 * CPM. It is used to *show* the economics — accounting never uses these
 * estimates, the ledger always uses the provider's own reported usage.
 */

/**
 * A representative multi-step agent turn: context is re-sent on every upstream
 * call, so a turn that reads a few files and runs a command lands in this range.
 * Deliberately one fixed profile, so every cost in the UI is comparable.
 */
export const TURN_PROFILE = { inputTokens: 120_000, outputTokens: 12_000 } as const;

/** What one representative agent turn costs on this model, in USD. */
export function typicalTurnUsd(model: ModelInfo): number {
  return (
    (TURN_PROFILE.inputTokens / 1e6) * model.priceIn +
    (TURN_PROFILE.outputTokens / 1e6) * model.priceOut
  );
}

export interface ModelAccess {
  /** False only when no provider credential exists, so nothing could be served. */
  enforced: boolean;
  unlocked: boolean;
  requiredUsd: number;
  balanceUsd: number;
  shortfallUsd: number;
  /** Collectible campaigns on record — lets the refusal name the next step. */
  backedCampaigns: number;
}

/**
 * Whether Infyield itself is paying for model calls.
 *
 * Always true in a server-credential build, because that is the only way the
 * app can serve at all: there is no BYOK path by which a caller's own account
 * could be billed instead, so the local ledger is always the constraint. Stated
 * as a function that reads the credential layer rather than as a constant, so
 * the gate and the health surface can never disagree about which mode the app is
 * in.
 */
function isAdFunded(): boolean {
  return usingServerCredential();
}

export function modelAccess(model: ModelInfo): ModelAccess {
  const requiredUsd = model.requiresBalanceUsd ?? 0;
  const balanceUsd = spendableUsd();
  const enforced = requiredUsd > 0 && isAdFunded();
  return {
    enforced,
    unlocked: !enforced || balanceUsd >= requiredUsd,
    requiredUsd,
    balanceUsd,
    shortfallUsd: Math.max(0, requiredUsd - balanceUsd),
    backedCampaigns: revenueBreakdown().backedCampaignIds.length,
  };
}

/** A refusal the user can act on, rather than a stack trace or a silent downgrade. */
export function premiumGateError(model: ModelInfo, access: ModelAccess): string {
  // The next step is an operator one, because that is where the money comes
  // from: revenue only becomes collectible once an advertiser or a network is on
  // the hook for it. There is deliberately no instruction to connect a key —
  // that model is gone.
  const path = access.backedCampaigns > 0
    ? `More of the delivered inventory needs an advertiser behind it: invoice the campaigns you are running on Economy → Campaigns, or raise their CPM.`
    : `Revenue only becomes collectible once somebody is on the hook for it: mark a campaign advertiser-backed and invoice it on Economy → Campaigns, or set a real ad-network publisher id on Settings → Ads.`;
  return [
    `${model.label} is a reserve-tier model and the collectible balance is ${usd(access.balanceUsd)},`,
    `below the ${usd(access.requiredUsd)} it needs before it may run.`,
    `Advertising funds this account: confirm about ${impressionsFor(access.shortfallUsd)} more sponsored`,
    `impressions worth of collectible revenue. ${path}`,
  ].join(" ");
}

// ------------------------------- earning ------------------------------------

export interface EarnMath {
  /** Value of one served impression at the configured CPM. */
  perImpressionUsd: number;
  /** Value of one clicked card. */
  perClickUsd: number;
  /** Impressions needed to earn a given amount, rounded up. */
  impressionsFor(usd: number): number;
  /** Clicked cards needed to earn a given amount, rounded up. */
  clicksFor(usd: number): number;
}

export function earnMath(ads: AdsSettings = getSettings().ads): EarnMath {
  const perImpressionUsd = Math.max(0, ads.cpmUsd) / 1000;
  const perClickUsd = Math.max(0, ads.clickBonusUsd);
  const need = (amount: number, unit: number) =>
    unit <= 0 ? Infinity : Math.max(0, Math.ceil(amount / unit));
  return {
    perImpressionUsd,
    perClickUsd,
    impressionsFor: (amount: number) => need(amount, perImpressionUsd),
    clicksFor: (amount: number) => need(amount, perClickUsd),
  };
}

/** Ad intensity presets. One control writes both knobs the scheduler reads. */
export const AD_INTENSITY = {
  relaxed: { label: "Relaxed", cadenceSteps: 4, maxAdsPerResponse: 1, blurb: "One card, and rarely. Quietest." },
  steady: { label: "Steady", cadenceSteps: 3, maxAdsPerResponse: 2, blurb: "The default: present but unobtrusive." },
  aggressive: { label: "Aggressive", cadenceSteps: 2, maxAdsPerResponse: 3, blurb: "More cards, more often. Earns noticeably faster." },
  maximum: { label: "Maximum", cadenceSteps: 1, maxAdsPerResponse: 4, blurb: "A card at every tool step. Earns fastest, busiest to read." },
} as const;

export type AdIntensity = keyof typeof AD_INTENSITY;

/** Which preset the current settings correspond to (closest match). */
export function intensityFor(ads: AdsSettings): AdIntensity {
  const keys = Object.keys(AD_INTENSITY) as AdIntensity[];
  let best: AdIntensity = "steady";
  let bestScore = Infinity;
  for (const key of keys) {
    const p = AD_INTENSITY[key];
    const score = Math.abs(p.cadenceSteps - ads.cadenceSteps) + Math.abs(p.maxAdsPerResponse - ads.maxAdsPerResponse);
    if (score < bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return best;
}

/** Roughly how many impressions one agent turn serves at a given intensity. */
export function impressionsPerTurn(intensity: AdIntensity): number {
  return AD_INTENSITY[intensity].maxAdsPerResponse;
}

export interface PremiumModelPlan {
  id: string;
  label: string;
  priceIn: number;
  priceOut: number;
  requiredUsd: number;
  typicalTurnUsd: number;
  /** Impressions at the configured CPM needed to reach the unlock threshold. */
  impressionsToUnlock: number;
  /** Impressions needed to earn back one representative turn on this model. */
  impressionsPerTurnFunded: number;
  unlocked: boolean;
  shortfallUsd: number;
}

export interface EarnPlan {
  /** Whether spend is the app's own (ads fund it) or the caller's key. */
  adFunded: boolean;
  balanceUsd: number;
  confirmedRevenueUsd: number;
  pendingRevenueUsd: number;
  spendUsd: number;
  /** Revenue that can actually settle a bill (excludes placeholder inventory). */
  collectibleRevenueUsd: number;
  /** Confirmed revenue from seeded campaigns with no advertiser behind it. */
  placeholderRevenueUsd: number;
  /** Collectible revenue minus spend and payouts — what the reserve tier gates on. */
  spendableUsd: number;
  targetUsd: number;
  targetReached: boolean;
  /** Earnings still needed to hit the target. */
  toTargetUsd: number;
  impressionsToTarget: number;
  clicksToTarget: number;
  perImpressionUsd: number;
  perClickUsd: number;
  intensity: AdIntensity;
  cadenceSteps: number;
  maxAdsPerResponse: number;
  /** Budget-adaptive pressure currently applied on top of the intensity. */
  adPressure: number;
  network: string;
  /** House campaigns are placeholders and earn no real money — say so. */
  usingPlaceholderInventory: boolean;
  /** Campaigns with a paying advertiser + issued/paid invoice behind them. */
  backedCampaigns: number;
  /** Campaigns whose impressions are booked but never billed. */
  placeholderCampaigns: number;
  premium: PremiumModelPlan[];
}

export function earnPlan(): EarnPlan {
  const settings = getSettings();
  const ads = settings.ads;
  const state = getState();
  const math = earnMath(ads);
  const intensity = intensityFor(ads);
  const target = Math.max(0, settings.earnTargetUsd ?? 0);
  const collectible = collectibleRevenueUsd();
  const breakdown = revenueBreakdown();
  // The target tracks the figure that actually unlocks models, not the ledger's
  // confirmed total — saving towards revenue that can never be collected would
  // be saving towards nothing.
  const spendable = spendableUsd();
  // With no target set there is nothing to save towards — don't report a
  // shortfall against zero, which would read as a debt.
  const toTarget = target > 0 ? Math.max(0, target - spendable) : 0;

  return {
    adFunded: isAdFunded(),
    balanceUsd: state.balanceUsd,
    confirmedRevenueUsd: state.adRevenueUsd,
    pendingRevenueUsd: state.estimatedRevenueUsd,
    spendUsd: state.spendUsd,
    collectibleRevenueUsd: collectible,
    placeholderRevenueUsd: placeholderRevenueUsd(),
    spendableUsd: spendable,
    targetUsd: target,
    targetReached: target > 0 && spendable >= target,
    toTargetUsd: toTarget,
    impressionsToTarget: math.impressionsFor(toTarget),
    clicksToTarget: math.clicksFor(toTarget),
    perImpressionUsd: math.perImpressionUsd,
    perClickUsd: math.perClickUsd,
    intensity,
    cadenceSteps: ads.cadenceSteps,
    maxAdsPerResponse: ads.maxAdsPerResponse,
    adPressure: fundingPressure(),
    network: ads.network,
    usingPlaceholderInventory: ads.network === "house" || !ads.ethicalAdsPublisherId,
    backedCampaigns: breakdown.backedCampaignIds.length,
    placeholderCampaigns: listCampaigns().length - breakdown.backedCampaignIds.length,
    premium: MODELS.filter((m) => m.premium).map((m) => {
      const access = modelAccess(m);
      const turn = typicalTurnUsd(m);
      return {
        id: m.id,
        label: m.label,
        priceIn: m.priceIn,
        priceOut: m.priceOut,
        requiredUsd: m.requiresBalanceUsd ?? 0,
        typicalTurnUsd: turn,
        impressionsToUnlock: math.impressionsFor(access.shortfallUsd),
        impressionsPerTurnFunded: math.impressionsFor(turn),
        unlocked: access.unlocked,
        shortfallUsd: access.shortfallUsd,
      };
    }),
  };
}

function usd(v: number): string {
  return `$${v.toFixed(4)}`;
}

function impressionsFor(v: number): number {
  return earnMath().impressionsFor(v);
}

