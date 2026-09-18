import { NextRequest } from "next/server";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import { requireApi } from "@/lib/auth";
import { modelAccess, typicalTurnUsd } from "@/lib/premium";
import { catalogPlans, providerParams, upstreamChain, modelForId } from "@/lib/router";
import { providerLabel } from "@/lib/routing";

export const dynamic = "force-dynamic";

/**
 * The catalog as the *server* will serve it.
 *
 * Every entry is the resolved policy — prices, limits, tier, tool support,
 * fallback rule — so a client can show the real constraints without guessing at
 * them, and can tell an unavailable model from a gated one before it sends a
 * turn. It deliberately exposes no upstream that the server would not choose:
 * the price ceiling and provider block are reported as *facts about the policy*
 * (what the economics permit) rather than as fields a caller could use to
 * redirect the request.
 */
export async function GET(req: NextRequest) {
  const denied = requireApi(req);
  if (denied) return denied;

  const models = catalogPlans().map((plan) => {
    // `catalogPlans()` is derived from the same list, so the lookup always hits.
    const model = modelForId(plan.id)!;
    const chain = upstreamChain(model, plan);
    // Gated only when the policy says so; a $0 route is never gated.
    const access = plan.requiresBalanceUsd > 0 ? modelAccess(model) : null;
    const constraints = providerParams(plan) ?? null;
    return {
      id: plan.id,
      label: plan.label,
      blurb: model?.blurb ?? "",
      provider: plan.provider,
      providerLabel: providerLabel(plan.provider),
      contextWindow: plan.contextWindow,
      priceIn: plan.priceIn,
      priceOut: plan.priceOut,
      free: plan.free,
      tier: plan.tier,
      enabled: plan.enabled,
      supportsTools: plan.supportsTools,
      maxOutputTokens: plan.maxOutputTokens,
      maxRequestTokens: plan.maxRequestTokens,
      fallbackPolicy: plan.fallbackPolicy,
      maxTurnCostUsd: plan.maxTurnCostUsd ?? null,
      /** The hard price ceiling the server sends upstream, USD per 1M tokens. */
      priceCeiling: constraints?.max_price ?? null,
      unmetered: model?.unmetered ?? false,
      tags: plan.tags,
      reasoning: plan.tags.includes("reasoning"),
      available: chain.length > 0,
      via: chain[0] ? providerLabel(chain[0].upstream.provider) : null,
      // Approved alternates that may serve this model, in order. Empty means the
      // policy forbids falling back.
      fallbacks: chain.slice(1).map((h) => providerLabel(h.upstream.provider)),
      premium: plan.tier === "premium",
      requiresBalanceUsd: plan.requiresBalanceUsd,
      typicalTurnUsd: model ? typicalTurnUsd(model) : 0,
      unlocked: access ? access.unlocked : true,
      shortfallUsd: access ? access.shortfallUsd : 0,
      gateEnforced: access ? access.enforced : false,
    };
  });

  return Response.json({ models, defaultModelId: DEFAULT_MODEL_ID });
}
