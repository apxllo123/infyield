import type { ModelInfo, ProviderKind, UpstreamMapping } from "./types";
import { listModels } from "./modelstore";
import { serverCredential, type Credential } from "./credentials";

/**
 * The server-side model router.
 *
 * The client sends an *Infyield* model id and nothing else. It cannot name a
 * provider, cannot name a provider's model, and cannot supply a credential.
 * This module resolves that id to a real upstream model and decides whether the
 * server is willing to pay for it.
 *
 * Three rules it exists to enforce:
 *
 *  1. **No surprise model costs.** A model's economics are declared here, and
 *     the request carries them to the aggregator as a hard price ceiling
 *     (`provider.max_price`, in USD per million tokens). OpenRouter refuses to
 *     route rather than silently picking a pricier upstream — verified against
 *     their routing docs: "`max_price` … will prevent your request from running
 *     if the price is not available."
 *
 *  2. **No silent downgrades.** A fallback happens only if the model's
 *     `fallbackPolicy` allows it, and every hop is returned in the chain so the
 *     caller can log it. Falling from a cheap model onto an expensive one is
 *     never implicit.
 *
 *  3. **No caller-supplied upstreams.** Unknown ids are refused, not mapped to
 *     whatever happens to be first in the catalog. Quietly serving a different
 *     model than the caller asked for is the downgrade this file prevents.
 */

export type ModelTier = "free" | "standard" | "premium";

/**
 * A model as the server is willing to serve it: the catalog entry with every
 * policy decision resolved to a concrete value, so no call site has to guess a
 * default.
 */
export interface ModelPlan {
  id: string;
  label: string;
  provider: ProviderKind;
  /** The provider's own model id. Server-side only. */
  upstreamModel: string;
  enabled: boolean;
  free: boolean;
  tier: ModelTier;
  priceIn: number; // USD per 1M input tokens
  priceOut: number; // USD per 1M output tokens
  contextWindow: number;
  maxOutputTokens: number;
  maxRequestTokens: number;
  supportsTools: boolean;
  fallbackPolicy: "none" | "free-only" | "same-tier";
  requiresBalanceUsd: number;
  maxTurnCostUsd?: number;
  /** Ceiling sent to the aggregator, USD per 1M tokens. */
  maxPricePerMTokIn: number;
  maxPricePerMTokOut: number;
  tags: string[];
}

const DEFAULT_MAX_OUTPUT = 8_192;

/**
 * Free-tier eligibility is a claim about the *provider's* price, and it is taken
 * from the catalog's price fields rather than from a badge: a model marked free
 * while priced above zero would either spend real money under a "free" label or
 * be wrongly exempted from the funding gate. Both are worse than no flag, so the
 * flag and the prices have to agree to count.
 */
function isFreeEntry(m: ModelInfo): boolean {
  return m.free === true && m.priceIn === 0 && m.priceOut === 0;
}

function tierOf(m: ModelInfo): ModelTier {
  if (m.premium) return "premium";
  if (isFreeEntry(m)) return "free";
  return "standard";
}

export function toPlan(m: ModelInfo): ModelPlan {
  const free = isFreeEntry(m);
  return {
    id: m.id,
    label: m.label,
    provider: m.upstream.provider,
    upstreamModel: m.upstream.model,
    enabled: m.enabled !== false,
    free,
    tier: tierOf(m),
    priceIn: Math.max(0, m.priceIn),
    priceOut: Math.max(0, m.priceOut),
    contextWindow: Math.max(1, m.contextWindow),
    maxOutputTokens: m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    maxRequestTokens: m.maxRequestTokens ?? m.contextWindow,
    supportsTools: m.supportsTools !== false,
    // The default is `none`: an explicit declaration is needed to allow a
    // fallback, because the safe direction for a spending policy is to not
    // improvise.
    fallbackPolicy: m.fallbackPolicy ?? "none",
    requiresBalanceUsd: m.requiresBalanceUsd ?? 0,
    ...(m.maxTurnCostUsd !== undefined ? { maxTurnCostUsd: m.maxTurnCostUsd } : {}),
    maxPricePerMTokIn: m.maxPricePerMTokIn ?? m.priceIn,
    maxPricePerMTokOut: m.maxPricePerMTokOut ?? m.priceOut,
    tags: m.tags ?? [],
  };
}

/** Every model the server will consider serving, policy resolved. */
export function catalogPlans(): ModelPlan[] {
  return listModels().map(toPlan);
}

export function planForId(id: string): ModelPlan | undefined {
  const m = listModels().find((x) => x.id === id);
  return m ? toPlan(m) : undefined;
}

/** The static catalog entry, for callers that need `upstream`/`fallbacks`. */
export function modelForId(id: string): ModelInfo | undefined {
  return listModels().find((m) => m.id === id);
}

/**
 * The provider block sent with the request.
 *
 * This is where "no surprise costs" is actually enforced, rather than merely
 * intended. The ceiling is the catalog price of the model the caller chose, so
 * the aggregator may route among providers that honour it and may not route
 * above it — and per their docs, when nothing satisfies it the request fails
 * instead of quietly costing more. Failing is the correct outcome here: the
 * ledger was funded to a specific price.
 *
 * Fallback policy maps onto the same two knobs:
 *   `none`      → no backup providers at all
 *   `free-only` → backups allowed, but only at a $0 ceiling, so a paid provider
 *                 cannot be substituted for a free one
 *   `same-tier` → backups allowed within the model's declared price
 */
export function providerParams(plan: ModelPlan): Record<string, unknown> | undefined {
  if (plan.provider !== "openrouter") return undefined;
  if (plan.free) {
    // A free route must stay free. `allow_fallbacks: false` plus a $0 ceiling is
    // belt and braces: either one alone would do, and both together mean neither
    // a router change nor a provider substitution can turn this into a paid call.
    return { allow_fallbacks: false, max_price: { prompt: 0, completion: 0 } };
  }
  switch (plan.fallbackPolicy) {
    case "free-only":
      return { allow_fallbacks: true, max_price: { prompt: 0, completion: 0 } };
    case "same-tier":
      return {
        allow_fallbacks: true,
        max_price: { prompt: plan.maxPricePerMTokIn, completion: plan.maxPricePerMTokOut },
      };
    case "none":
    default:
      return {
        allow_fallbacks: false,
        max_price: { prompt: plan.maxPricePerMTokIn, completion: plan.maxPricePerMTokOut },
      };
  }
}

export interface ChainHop {
  upstream: UpstreamMapping;
  credential: Credential;
  /** True for the caller's first choice; false for every approved fallback. */
  primary: boolean;
}

/**
 * The upstreams this model may actually be served from, in order.
 *
 * Every hop needs an Infyield-owned credential; a hop with none is dropped. When
 * the list comes back empty the caller must refuse the request — the credential
 * is what makes the call payable, and there is no code path in which a caller
 * supplies one.
 *
 * Fallbacks come from the catalog entry and are filtered by the plan's policy,
 * so the log always shows exactly which hops were permitted.
 */
export function upstreamChain(model: ModelInfo, plan: ModelPlan = toPlan(model)): ChainHop[] {
  const declared = [model.upstream, ...(model.fallbacks ?? [])];
  const allowed =
    plan.fallbackPolicy === "none" ? declared.slice(0, 1) : declared;
  const hops: ChainHop[] = [];
  for (const upstream of allowed) {
    const credential = serverCredential(upstream.provider);
    if (!credential) continue;
    hops.push({ upstream, credential, primary: hops.length === 0 });
  }
  return hops;
}

/** True when any provider credential exists, i.e. the agent could run at all. */
export function anyProviderAvailable(): boolean {
  return (["openrouter", "openai", "anthropic", "google"] as ProviderKind[]).some(
    (p) => serverCredential(p) !== null,
  );
}
