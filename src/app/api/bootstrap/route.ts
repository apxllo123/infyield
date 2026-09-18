import { listModels } from "@/lib/modelstore";
import { resolveChain } from "@/lib/routing";
import { getState } from "@/lib/economy";
import { allProviderStatus, providerConfigured } from "@/lib/credentials";
import { fundingStatus, runAutoSetup, missingProviderHint } from "@/lib/autosetup";
import { earnPlan } from "@/lib/premium";
import { fundingSnapshot } from "@/lib/funding";
import { modeReport } from "@/lib/mode";

export const dynamic = "force-dynamic";

/**
 * The startup check the app and its UI both read.
 *
 * One question: is this deployment able to serve, and what is paying for it?
 * `ready` is false only when Infyield holds no provider credential — there is no
 * BYOK fallback, so that is a configuration error the operator has to fix rather
 * than something a user can work around.
 */
export async function GET() {
  runAutoSetup();
  const models = listModels();
  const servable = models.filter((m) => resolveChain(m).length > 0);
  const funding = fundingStatus();
  const configured = providerConfigured();
  return Response.json({
    ready: servable.length > 0,
    /** Actionable when false: exactly which variables are missing. */
    missingProviderEnv: configured ? [] : missingProviderHint(),
    servableCount: servable.length,
    totalModels: models.length,
    // Kept for existing callers: "does the server have a way to call a model?"
    hasAnyKey: configured,
    keys: 0,
    autoImported: 0,
    providers: allProviderStatus().map((s) => ({
      provider: s.provider,
      configured: s.configured,
      source: s.source,
      envVars: s.envVars,
    })),
    mode: modeReport(),
    funding,
    fundingSnapshot: fundingSnapshot(),
    economy: getState(),
    // The funding readout in the nav polls this, so it must carry the honest
    // figures: `economy.adRevenueUsd` includes house-inventory bookings, which
    // are recorded for delivery but will never be paid. `earn` separates them.
    earn: (() => {
      const p = earnPlan();
      return {
        collectibleUsd: p.collectibleRevenueUsd,
        placeholderUsd: p.placeholderRevenueUsd,
        spendableUsd: p.spendableUsd,
        targetUsd: p.targetUsd,
        intensity: p.intensity,
        // Campaigns with a paying advertiser behind them: the only inventory
        // whose delivery can become collectible revenue.
        backedCampaigns: p.backedCampaigns,
        placeholderCampaigns: p.placeholderCampaigns,
      };
    })(),
  });
}
