import type { ModelInfo } from "./types";

// Catalog named after the Freebuff picker (README). Each entry maps to a real
// upstream model via `upstream`, paid for with the deployment's own credential —
// clients never see provider keys or tokens. Adjust mappings in one place.
export const MODELS: ModelInfo[] = [
  {
    id: "glm-5.3-flash",
    label: "GLM 5.3 Flash",
    blurb: "The default everywhere; deepest reasoning, unmetered",
    contextWindow: 200_000,
    priceIn: 0.6,
    priceOut: 2.2,
    upstream: { provider: "openrouter", model: "z-ai/glm-4.6" },
    fallbacks: [{ provider: "custom", model: "glm-4.6", baseUrl: "https://api.z.ai/api/paas/v4" }],
    unmetered: true,
    // "reasoning" is a capability claim, not decoration: the composer only sends
    // a thinking-effort parameter to models tagged with it.
    tags: ["default", "tools", "reasoning"],
  },
  {
    id: "deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash",
    blurb: "Fast coding and tool use, unmetered",
    contextWindow: 128_000,
    priceIn: 0.28,
    priceOut: 1.1,
    upstream: { provider: "openrouter", model: "deepseek/deepseek-chat" },
    fallbacks: [{ provider: "custom", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }],
    unmetered: true,
    tags: ["fast", "tools", "reasoning"],
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    blurb: "Strong all-around with native images",
    contextWindow: 400_000,
    priceIn: 1.25,
    priceOut: 10,
    upstream: { provider: "openrouter", model: "openai/gpt-4o" },
    fallbacks: [{ provider: "openai", model: "gpt-4o" }],
    tags: ["tools", "images"],
  },
  {
    id: "mimo-2.5",
    label: "MiMo 2.5",
    blurb: "Balanced performance with image support",
    contextWindow: 200_000,
    priceIn: 0.5,
    priceOut: 2,
    upstream: { provider: "openrouter", model: "openai/gpt-4o-mini" },
    fallbacks: [{ provider: "openai", model: "gpt-4o-mini" }],
    tags: ["tools"],
  },
  {
    id: "solar-pro-4",
    label: "Solar Pro 4",
    blurb: "Long-context text model; 524K context",
    contextWindow: 524_288,
    priceIn: 0.7,
    priceOut: 2.8,
    upstream: { provider: "openrouter", model: "google/gemini-2.0-flash-001" },
    fallbacks: [{ provider: "google", model: "gemini-2.0-flash" }],
    unmetered: true,
    tags: ["tools"],
  },
  {
    id: "muse-spark-1.2",
    label: "Muse Spark 1.2",
    blurb: "Agentic coding model; 1M context",
    contextWindow: 1_000_000,
    priceIn: 3,
    priceOut: 15,
    upstream: { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
    fallbacks: [{ provider: "anthropic", model: "claude-sonnet-4-20250514" }],
    tags: ["tools", "reasoning"],
  },

  // ---------------- Heavyweight tier ----------------
  // Front-line models, priced above the everyday catalog. Every id and price
  // here is taken from OpenRouter's live /api/v1/models (checked against it
  // rather than guessed), so the ledger's cost accounting is real. They are
  // OpenRouter-only on purpose: no invented direct-provider ids that could 404.
  //
  // These are the models ads have to earn their way up to, hence
  // `requiresBalanceUsd` — see src/lib/premium.ts.
  {
    id: "gpt-astra-pro",
    label: "GPT Astra Pro",
    blurb: "Frontier reasoning with a 1M context window",
    contextWindow: 1_050_000,
    priceIn: 10,
    priceOut: 50,
    upstream: { provider: "openrouter", model: "openai/gpt-6-astra-pro" },
    premium: true,
    requiresBalanceUsd: 4,
    tags: ["premium", "reasoning", "long-context"],
  },
  {
    id: "claude-fable-5.1",
    label: "Claude Fable 5.1",
    blurb: "Anthropic's heavyweight writer and reasoner; 1M context",
    contextWindow: 1_000_000,
    priceIn: 10,
    priceOut: 50,
    upstream: { provider: "openrouter", model: "anthropic/claude-fable-5.1" },
    premium: true,
    requiresBalanceUsd: 4,
    tags: ["premium", "writing", "long-context"],
  },
  {
    id: "claude-opus-4.1",
    label: "Claude Opus 4.1",
    blurb: "The deepest Claude; slow, careful, expensive",
    contextWindow: 200_000,
    priceIn: 15,
    priceOut: 75,
    upstream: { provider: "openrouter", model: "anthropic/claude-opus-4.1" },
    premium: true,
    requiresBalanceUsd: 5,
    tags: ["premium", "reasoning"],
  },
  {
    id: "o3-pro",
    label: "o3 Pro",
    blurb: "Long deliberation before it answers",
    contextWindow: 200_000,
    priceIn: 20,
    priceOut: 80,
    upstream: { provider: "openrouter", model: "openai/o3-pro" },
    premium: true,
    requiresBalanceUsd: 6,
    tags: ["premium", "reasoning"],
  },
  {
    id: "gpt-5-pro",
    label: "GPT-5 Pro",
    blurb: "Extended reasoning pass over the whole task",
    contextWindow: 400_000,
    priceIn: 15,
    priceOut: 120,
    upstream: { provider: "openrouter", model: "openai/gpt-5-pro" },
    premium: true,
    requiresBalanceUsd: 8,
    tags: ["premium", "reasoning"],
  },
  {
    id: "gpt-5.5-pro",
    label: "GPT-5.5 Pro",
    blurb: "The most capable GPT tier; 1M context",
    contextWindow: 1_050_000,
    priceIn: 30,
    priceOut: 180,
    upstream: { provider: "openrouter", model: "openai/gpt-5.5-pro" },
    premium: true,
    requiresBalanceUsd: 12,
    tags: ["premium", "reasoning", "long-context"],
  },
  {
    id: "o1-pro",
    label: "o1 Pro",
    blurb: "The most expensive model in the catalog; reserve tier",
    contextWindow: 200_000,
    priceIn: 150,
    priceOut: 600,
    upstream: { provider: "openrouter", model: "openai/o1-pro" },
    premium: true,
    requiresBalanceUsd: 40,
    tags: ["premium", "reasoning"],
  },
];

export const DEFAULT_MODEL_ID = "glm-5.3-flash";

export function estimateCostUsd(m: ModelInfo, promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1e6) * m.priceIn + (completionTokens / 1e6) * m.priceOut;
}
