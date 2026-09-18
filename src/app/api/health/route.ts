import { NextRequest } from "next/server";
import { getSettings } from "@/lib/settings";
import { allProviderStatus } from "@/lib/credentials";
import { modeReport } from "@/lib/mode";
import { fundingSnapshot } from "@/lib/funding";
import { catalogPlans, upstreamChain, modelForId } from "@/lib/router";
import { listCampaigns } from "@/lib/ads";
import { networkConfigured, networkReasonText, networkState } from "@/lib/networks";
import { adPipeline } from "@/lib/adlifecycle";
import { listUsage, usageTotals } from "@/lib/usage";
import { allEntries } from "@/lib/economy";
import { reconcileAll } from "@/lib/reconcile";
import { collectibleRevenueUsd, placeholderRevenueUsd } from "@/lib/funds";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Production health, for the operator.
 *
 * Answers "is this actually working, and what is paying for it?" from live state
 * — never a cached success. Two things it is careful about:
 *
 *  - it never returns a credential, in any form, including a masked tail;
 *  - it distinguishes *not configured* from *failing*. "No provider credential"
 *    and "the provider rejected us" are different problems with different fixes,
 *    and collapsing them into one red dot is how an outage gets mistaken for a
 *    setup mistake.
 *
 * Reachability is probed for real rather than inferred: OpenRouter's model
 * listing needs no credential, so it can be used as a liveness check even when
 * the deployment has none.
 */

interface Reachability {
  reachable: boolean;
  status: number | null;
  models: number | null;
  detail: string;
}

let reachCache: { at: number; value: Reachability } | null = null;
const REACH_TTL_MS = 30_000;

async function probeOpenRouter(): Promise<Reachability> {
  if (reachCache && Date.now() - reachCache.at < REACH_TTL_MS) return reachCache.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  let value: Reachability;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal, cache: "no-store" });
    const body = res.ok ? ((await res.json()) as { data?: unknown[] }) : null;
    value = {
      reachable: res.ok,
      status: res.status,
      models: Array.isArray(body?.data) ? body.data.length : null,
      detail: res.ok ? "Reachable; the public model catalog answered." : `HTTP ${res.status} from OpenRouter.`,
    };
  } catch (e) {
    value = {
      reachable: false,
      status: null,
      models: null,
      detail: e instanceof Error && e.name === "AbortError" ? "Timed out after 5s." : "Could not reach OpenRouter.",
    };
  } finally {
    clearTimeout(timer);
  }
  reachCache = { at: Date.now(), value };
  return value;
}

function startOfToday(): number {
  return new Date().setHours(0, 0, 0, 0);
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const settings = getSettings();
  const mode = modeReport();
  const funding = fundingSnapshot();
  const providers = allProviderStatus();
  const configured = providers.some((p) => p.configured);

  const plans = catalogPlans();
  const servable = plans.filter((p) => {
    const m = modelForId(p.id);
    return m ? upstreamChain(m, p).length > 0 : false;
  });

  const reach = await probeOpenRouter();
  const ads = settings.ads;
  const networkStateNow = networkState();
  const campaigns = listCampaigns();
  const pipeline = adPipeline();
  const reconcile = reconcileAll();
  const usage = listUsage(1_000);
  const totals = usageTotals(usage);
  const dayStart = startOfToday();

  const lastModel = usage.find((u) => u.status !== "running") ?? null;
  const settledToday = usage.filter((u) => u.status !== "running" && u.finishedAt && u.finishedAt >= dayStart);
  const spendTodayUsd = settledToday.reduce((n, u) => n + u.costUsd, 0);

  // Confirmed revenue *today* comes from the ledger's dated entries, since the
  // running total carries no date of its own. Only the revenue kinds count;
  // `estimate` entries are pending and a `spend` entry is negative.
  let confirmedTodayUsd = 0;
  for (const e of allEntries()) {
    if (e.ts < dayStart || e.delta <= 0) continue;
    if (e.kind !== "ad-impression" && e.kind !== "ad-click" && e.kind !== "reconcile") continue;
    confirmedTodayUsd += e.delta;
  }

  // The active network decides which credential counts: a Carbon placement id
  // is meaningless when EthicalAds is selected, and vice versa. Checking only
  // the EthicalAds id used to report a fully working Carbon setup as
  // NOT_CONFIGURED.
  const activeId = ads.network === "carbon" ? (ads.carbonPlacementId ?? "") : ads.ethicalAdsPublisherId;
  const adsConfigured = networkConfigured(activeId);

  return Response.json({
    checkedAt: Date.now(),
    mode,

    aiProvider: {
      // Configured is not the same as working; both are reported.
      status: configured ? "CONNECTED" : "NOT_CONFIGURED",
      providers: providers.map((p) => ({
        provider: p.provider,
        configured: p.configured,
        source: p.source,
        envVars: p.envVars,
      })),
    },

    openRouter: {
      reachable: reach.reachable,
      models: reach.models,
      detail: reach.detail,
      // A reachable aggregator with no credential is a setup problem, not an
      // outage, and the two must not be reported as one.
      status: reach.reachable ? "HEALTHY" : "ERROR",
    },

    modelCatalog: {
      status: servable.length > 0 ? "HEALTHY" : configured ? "ERROR" : "NOT_CONFIGURED",
      total: plans.length,
      servable: servable.length,
      enabled: plans.filter((p) => p.enabled).length,
      detail:
        servable.length > 0
          ? `${servable.length} of ${plans.length} models have a credential and can run.`
          : "No model can run: no provider credential is configured.",
    },

    adProvider: {
      network: ads.network,
      configured: adsConfigured,
      status: adsConfigured ? (networkStateNow?.reason === "ok" ? "CONNECTED" : "DEGRADED") : "NOT_CONFIGURED",
      lastReason: networkStateNow?.reason ?? null,
      lastDetail: networkStateNow?.detail ?? null,
      lastAt: networkStateNow?.at ?? null,
      text: networkReasonText(networkStateNow, adsConfigured),
    },

    adInventory: {
      status: campaigns.some((c) => c.active) ? "AVAILABLE" : "EMPTY",
      campaigns: campaigns.length,
      active: campaigns.filter((c) => c.active).length,
      // Campaigns with a paying advertiser behind them. Only these can convert
      // delivery into collectible revenue.
      advertiserBacked: campaigns.filter((c) => c.advertiserAccount).length,
      detail: campaigns.some((c) => c.active)
        ? `${campaigns.filter((c) => c.active).length} active creatives.`
        : "No active creative: nothing can be served.",
    },

    revenuePipeline: {
      status: reconcile.errors > 0 ? "ERROR" : funding.health === "blocked" ? "DELAYED" : "HEALTHY",
      pendingUsd: funding.pendingRevenueUsd,
      confirmedUsd: funding.confirmedRevenueUsd,
      collectibleUsd: collectibleRevenueUsd(),
      houseUsd: placeholderRevenueUsd(),
      lastServedAt: pipeline.lastServedAt,
      lastImpressionAt: pipeline.lastDisplayedAt,
      lastVerifiedAt: pipeline.lastVerifiedAt,
      lastPendingAt: pipeline.lastPendingAt,
      lastConfirmedAt: pipeline.lastConfirmedAt,
      lastClickAt: pipeline.lastClickAt,
      unverifiedServes: pipeline.unverified,
    },

    ledger: {
      status: reconcile.ok ? "HEALTHY" : "ERROR",
      entries: reconcile.figures.ledgerEntries,
      spendUsd: funding.spendUsd,
      netUsd: funding.confirmedRevenueUsd - funding.spendUsd,
      reconcileOk: reconcile.ok,
      errors: reconcile.errors,
      warnings: reconcile.warnings,
      discrepancies: reconcile.discrepancies,
    },

    lastModelRequest: lastModel
      ? {
          at: lastModel.finishedAt ?? lastModel.startedAt,
          model: lastModel.modelLabel,
          provider: lastModel.provider,
          costUsd: lastModel.costUsd,
          costMethod: lastModel.costMethod,
          status: lastModel.status,
        }
      : null,

    providerSpend: {
      todayUsd: spendTodayUsd,
      totalUsd: funding.spendUsd,
      requestsToday: settledToday.length,
      requests: totals.requests,
      errors: totals.errors,
      // The gap between what providers charged and what the price table expects.
      // Drift here is the first sign the catalog needs revisiting.
      catalogDriftUsd: totals.driftUsd,
      providerReportedUsd: totals.providerReportedUsd,
      catalogCalculatedUsd: totals.catalogCalculatedUsd,
    },

    funding: {
      status: funding.health === "healthy" ? "HEALTHY" : funding.health === "at-risk" ? "AT_RISK" : "BLOCKED",
      ...funding,
    },

    confirmedTodayUsd,
  });
}


