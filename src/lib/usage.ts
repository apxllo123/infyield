import type { ProviderKind } from "./types";
import { readJson, writeJson } from "./store";
import { recordSpend } from "./economy";
import { modeReport } from "./mode";

/**
 * Server-side model usage accounting.
 *
 * Every model request gets a record here, whether it succeeded or failed, and
 * the ledger debit is derived from that record rather than issued alongside it.
 * The separation matters: the record is what the provider will be reconciled
 * against, and the debit is money. Deriving one from the other means a retry, a
 * double `finish`, or a crashed request cannot book the same spend twice.
 *
 * ## Which cost is the real one
 *
 * The provider's own reported charge is authoritative and is always preferred:
 * OpenRouter states the actual upstream cost on the final stream chunk
 * (`usage.cost`), and that number already accounts for provider selection,
 * caching, and any discount the router applied. A catalog calculation would be a
 * *different* number — usually close, sometimes not — and booking it while the
 * provider bills the real one produces a ledger that never reconciles.
 *
 * So `costMethod` records which was used, and `calculatedCostUsd` is kept even
 * when it was not booked, because the gap between the two is the only way to
 * notice the catalog price table drifting from reality.
 */

const FILE = "usage.json";
const MAX_RECORDS = 500;

export type CostMethod = "provider-reported" | "catalog-calculated" | "none";

export interface UsageRecord {
  requestId: string;
  /** Groups the turns of one conversation, for per-session caps. */
  sessionId: string | null;
  modelId: string;
  modelLabel: string;
  provider: ProviderKind;
  upstreamModel: string;
  startedAt: number;
  finishedAt: number | null;
  promptTokens: number;
  completionTokens: number;
  /** The provider's authoritative figure, when it reported one. */
  providerCostUsd: number | null;
  /** What the catalog price table says it should have cost. */
  calculatedCostUsd: number;
  /** What was actually debited. */
  costUsd: number;
  costMethod: CostMethod;
  status: "running" | "ok" | "error";
  error?: string;
  /** True when a mock provider served this — never production money. */
  simulated: boolean;
}

interface UsageFile {
  records: UsageRecord[];
  /** Request ids whose debit has been booked, so a retry cannot book it again. */
  settled: string[];
}

function load(): UsageFile {
  const f = readJson<Partial<UsageFile>>(FILE, {});
  return {
    records: Array.isArray(f.records) ? f.records : [],
    settled: Array.isArray(f.settled) ? f.settled : [],
  };
}

function save(f: UsageFile): void {
  writeJson(FILE, { records: f.records.slice(0, MAX_RECORDS), settled: f.settled.slice(-2_000) });
}

export function listUsage(limit = 50): UsageRecord[] {
  return load().records.slice(0, Math.max(0, limit));
}

export function usageForRequest(requestId: string): UsageRecord | undefined {
  return load().records.find((r) => r.requestId === requestId);
}

export interface BeginRequestInput {
  sessionId?: string | null;
  modelId: string;
  modelLabel: string;
  provider: ProviderKind;
  upstreamModel: string;
}

/**
 * Open a record before the request goes out.
 *
 * Written before the call rather than after so a request that crashes, times out
 * or is killed still leaves evidence it was attempted. A record that only exists
 * on success makes a hung provider invisible.
 */
export function beginRequest(input: BeginRequestInput): UsageRecord {
  const f = load();
  const record: UsageRecord = {
    requestId: crypto.randomUUID(),
    sessionId: input.sessionId ?? null,
    modelId: input.modelId,
    modelLabel: input.modelLabel,
    provider: input.provider,
    upstreamModel: input.upstreamModel,
    startedAt: Date.now(),
    finishedAt: null,
    promptTokens: 0,
    completionTokens: 0,
    providerCostUsd: null,
    calculatedCostUsd: 0,
    costUsd: 0,
    costMethod: "none",
    status: "running",
    simulated: modeReport().simulated,
  };
  f.records.unshift(record);
  save(f);
  return record;
}

export interface FinishRequestInput {
  requestId: string;
  promptTokens: number;
  completionTokens: number;
  /** The provider's own charge, when it reported one. */
  providerCostUsd?: number | null;
  /** What the catalog says, used only when the provider reported nothing. */
  calculatedCostUsd: number;
  status: "ok" | "error";
  error?: string;
}

/**
 * Close a record and book its cost exactly once.
 *
 * The idempotency key is the request id: `settled` is checked before the debit
 * and appended after, so calling this twice for one request — a retry, a racing
 * finally block, a client that reconnects — books the spend once. The second
 * call still returns the record, so a caller always sees the final state.
 */
export function finishRequest(input: FinishRequestInput): UsageRecord | undefined {
  const f = load();
  const i = f.records.findIndex((r) => r.requestId === input.requestId);
  if (i === -1) return undefined;
  const existing = f.records[i];

  // Already settled: return what was booked rather than re-booking.
  if (f.settled.includes(input.requestId)) return existing;

  const reported = typeof input.providerCostUsd === "number" && Number.isFinite(input.providerCostUsd)
    ? Math.max(0, input.providerCostUsd)
    : null;
  // A provider that reports $0 genuinely charged nothing (a free route, or a
  // cached response); that is a reported figure, not a missing one, so it is
  // honoured rather than being treated as absent.
  const cost = reported !== null ? reported : Math.max(0, input.calculatedCostUsd);
  const costMethod: CostMethod = reported !== null ? "provider-reported" : cost > 0 ? "catalog-calculated" : "none";

  const record: UsageRecord = {
    ...existing,
    finishedAt: Date.now(),
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    providerCostUsd: reported,
    calculatedCostUsd: Math.max(0, input.calculatedCostUsd),
    costUsd: cost,
    costMethod,
    status: input.status,
    ...(input.error ? { error: input.error } : {}),
  };
  f.records[i] = record;
  f.settled.push(input.requestId);

  // The debit is derived from the record, so the two cannot disagree. Booked
  // even at $0 when the provider reported a figure, because a $0 charge from a
  // metered route is a real accounting event and its absence would be
  // indistinguishable from a request that was never billed.
  if (cost > 0) {
    recordSpend(cost, `${existing.modelLabel} · request ${input.requestId.slice(0, 8)}`, existing.modelLabel, {
      requestId: input.requestId,
      origin: "provider",
      provider: existing.provider,
      // `none` is a usage-record state, not a ledger one: an entry only exists
      // when something was charged, so by here it is always one of the two
      // real methods.
      ...(costMethod === "provider-reported" || costMethod === "catalog-calculated"
        ? { costMethod }
        : {}),
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
    });
  }

  save(f);
  return record;
}

export interface UsageTotals {
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  /** Spend as the provider reported it. */
  providerReportedUsd: number;
  /** Spend as the catalog priced it — kept to expose drift. */
  catalogCalculatedUsd: number;
  /** Provider-reported minus catalog-calculated. Non-zero means drift. */
  driftUsd: number;
  simulated: boolean;
}

export function usageTotals(records: UsageRecord[] = load().records): UsageTotals {
  let providerReportedUsd = 0;
  let catalogCalculatedUsd = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let errors = 0;
  for (const r of records) {
    if (r.status === "error") errors += 1;
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    catalogCalculatedUsd += r.calculatedCostUsd;
    if (r.costMethod === "provider-reported") providerReportedUsd += r.providerCostUsd ?? 0;
  }
  return {
    requests: records.length,
    errors,
    promptTokens,
    completionTokens,
    providerReportedUsd,
    catalogCalculatedUsd,
    driftUsd: providerReportedUsd - catalogCalculatedUsd,
    simulated: modeReport().simulated,
  };
}
