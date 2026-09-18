import type { ModelInfo, ProviderKind } from "./types";
import { MODELS } from "./models";
import { readJson, writeJson } from "./store";

// Dynamic catalog: operator-added models (Admin → Models) persist in
// .data/custom-models.json and merge over the built-ins. This is what makes
// "add any API/model and let the ads fund it" a UI action, not a code change.
const FILE = "custom-models.json";

const PROVIDERS: ProviderKind[] = ["openrouter", "openai", "anthropic", "google", "custom"];

function load(): ModelInfo[] {
  const custom = readJson<ModelInfo[]>(FILE, []);
  return custom.filter((m) => m && m.id && m.upstream);
}

function save(list: ModelInfo[]): void {
  writeJson(FILE, list);
}

export function listModels(): ModelInfo[] {
  return [...MODELS, ...load()];
}

export function getModelDyn(id: string): ModelInfo | undefined {
  return listModels().find((m) => m.id === id);
}

export function addCustomModel(input: {
  label: string;
  provider: ProviderKind;
  upstreamModel: string;
  baseUrl?: string;
  priceIn?: number;
  priceOut?: number;
  contextWindow?: number;
  blurb?: string;
  /** Capability tags. `reasoning` is the one that matters functionally: it is
   * what lets the composer's thinking control reach this model. Without it a
   * custom model can never be given a deliberation level, because sending a
   * reasoning parameter to a model that does not support one is a request error
   * rather than a hint. */
  tags?: string[];
}): ModelInfo {
  const slug =
    input.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || `custom-${Date.now()}`;
  let id = slug;
  let n = 2;
  while (getModelDyn(id)) id = `${slug}-${n++}`;

  const m: ModelInfo = {
    id,
    label: input.label,
    blurb: input.blurb || `Custom ${input.provider} model served from your key pool`,
    contextWindow: input.contextWindow && input.contextWindow > 0 ? input.contextWindow : 128_000,
    priceIn: Math.max(0, input.priceIn ?? 1),
    priceOut: Math.max(0, input.priceOut ?? 2),
    upstream: {
      provider: PROVIDERS.includes(input.provider) ? input.provider : "custom",
      model: input.upstreamModel,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    },
    tags: [...new Set(["custom", "tools", ...(input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)])],
  };
  const list = load();
  list.push(m);
  save(list);
  return m;
}

export function deleteCustomModel(id: string): boolean {
  const list = load();
  const next = list.filter((m) => m.id !== id);
  save(next);
  return next.length !== list.length;
}
