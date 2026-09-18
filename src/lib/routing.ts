import type { ModelInfo, ProviderKind, SponsoredAd } from "./types";
import { spendableUsd } from "./funds";
import { toPlan, upstreamChain, type ChainHop } from "./router";
import { PROVIDER_NOT_CONFIGURED, providerStatus, scrubSecrets } from "./credentials";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/**
 * Which upstreams a model may be served from, and the credential that pays for
 * each one.
 *
 * Deliberately *not* a key pool any more. Every hop carries an Infyield-owned
 * credential read from the server environment, and a hop with none is dropped —
 * so there is no path by which a caller's own key could be used to serve a
 * request, and no path by which one could be supplied. See `credentials.ts`.
 */
export function resolveChain(model: ModelInfo): ChainHop[] {
  return upstreamChain(model, toPlan(model));
}

/** Should ads serve harder right now? When genuinely spendable revenue is thin
 * or negative, cadence tightens so the ledger refills — "use ads when needed".
 * Uses the collectible figure rather than the ledger balance, which is inflated
 * by house-inventory bookings (see funds.ts). */
export function adPressure(): number {
  const bal = spendableUsd();
  if (bal >= 1) return 0;
  if (bal >= 0.25) return 1;
  return 2;
}

export function providerLabel(p: ProviderKind): string {
  switch (p) {
    case "openrouter":
      return "OpenRouter";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google AI";
    default:
      return "custom endpoint";
  }
}

/**
 * The refusal an operator can act on when nothing can serve a model.
 *
 * Names the exact variables to set. It never names a *user* action, because
 * there is no user action: credentials belong to the deployment, and telling
 * somebody to connect their own account is the BYOK model this build removed.
 */
export function needsSetupError(model: ModelInfo): string {
  const primary = providerStatus(model.upstream.provider);
  const configured = providerStatus("openrouter").configured;
  const hint = configured
    ? `Infyield holds an OpenRouter credential but this model maps to ${primary.provider}, which has none.`
    : `Set ${primary.envVars.length ? primary.envVars.join(" or ") : "a provider credential"} in the server environment.`;
  return [
    PROVIDER_NOT_CONFIGURED,
    `"${model.label}" resolves to ${primary.provider} (${model.upstream.model}) and Infyield has no credential for it.`,
    hint,
  ].join(" ");
}

/** Scrub anything credential-shaped before an upstream error can be shown. */
export function safeUpstreamError(message: string): string {
  return scrubSecrets(message);
}

export type { SponsoredAd };
export type { ChainHop };
