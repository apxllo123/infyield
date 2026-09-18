import type {
  AccessMode,
  AdsSettings,
  ChatMessage,
  Skill,
  SponsoredAd,
  StreamEvent,
  ThinkingIntensity,
} from "./types";
import { READONLY_BLOCKED_TOOLS } from "./types";
import { MODELS, estimateCostUsd } from "./models";
import { getModelDyn } from "./modelstore";
import { TOOLS, executeTool } from "./tools";
import {
  streamOpenAICompatible,
  streamAnthropic,
  makeClient,
  toWireMessages,
  toWireTools,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type OutgoingMessage,
  type WireContentPart,
} from "./providers";
import { allowedToolNames, resolveSkills } from "./skills";
import { attachmentManifest, hydrateAttachments } from "./attachments";
import { getSettings } from "./settings";
import { serveAd } from "./ads";
import { resolveChain, needsSetupError, adPressure, safeUpstreamError, providerLabel } from "./routing";
import { runAutoSetup } from "./autosetup";
import { beginRequest, finishRequest } from "./usage";
import { toPlan, providerParams } from "./router";

const SYSTEM_PROMPT = `You are Infyield, a free AI coding agent working directly in the user's project. You are practical, persistent, and action-oriented — closer to a colleague at the keyboard than a documentation page.

Working rules:
- Act, don't ask. When a task is clear, start working immediately. Ask only when genuinely blocked on a decision only the user can make.
- Never invent file contents. Read first (read_file, search, list_dir), then edit. Keep edits minimal and match the project's existing style.
- You have a real shell. Use run_command freely to inspect state (git status, ls, cat, find, grep, node -e, curl) and to do things the file tools can't. The working directory persists across calls: \`cd packages/app\` once and every later command runs there. State the directory you are in only when it changed.
- Verify your work. After a non-trivial change, run the project's own checks (run_tests, or the relevant build/typecheck/lint command) and read the actual output. If it fails, fix it and run again — do not report success from hope.
- Keep going until the task is done. Work through errors instead of stopping at the first obstacle; a failing test is information, not a reason to give up.
- Prefer several small steps over one huge change, so the user can follow what happened.
- When you finish, summarize concisely: what changed, how you verified it, and anything the user should do next.

The user sees your tool activity live as steps; no need to narrate every call.`;

/**
 * Compose the system prompt for a turn: the base rules, then each active skill's
 * workflow, then a note describing the tool set the skill permits. Telling the
 * model what it cannot do is what keeps a read-only skill from wasting a step
 * trying to write a file it will be refused.
 */
function buildSystemPrompt(skills: Skill[], allowed: Set<string> | null, workspaceRoot: string, access: AccessMode): string {
  const parts = [SYSTEM_PROMPT];
  parts.push(`Workspace root: ${workspaceRoot}. File paths are relative to it, and shell commands start (and stay) in the current working directory inside it.`);
  if (access === "readonly") {
    parts.push("This is a READ-ONLY turn: the write, edit and command tools are absent. Inspect and explain, and say what you would change rather than changing it.");
  }
  if (skills.length) {
    parts.push(`Active skills: ${skills.map((s) => s.name).join(", ")}. Follow each workflow.`);
    for (const s of skills) parts.push(`## ${s.name}\n${s.instructions}`);
  }
  if (allowed) {
    parts.push(
      `Tools available this turn: ${[...allowed].join(", ")}. No other tool can be called — if the task needs one of them (for example writing a file), say so instead of attempting it.`,
    );
  }
  return parts.join("\n\n");
}

/**
 * Map the composer's thinking level onto whatever the upstream actually accepts.
 * Only sent when the model advertises reasoning support, because handing an
 * unknown parameter to a non-reasoning model is a request error, not a hint.
 */
function reasoningParam(
  provider: string,
  thinking: ThinkingIntensity,
  modelSupportsReasoning: boolean,
): Record<string, unknown> | undefined {
  if (thinking === "off" || !modelSupportsReasoning) return undefined;
  if (provider === "openrouter") return { reasoning: { effort: thinking } };
  if (provider === "openai") return { reasoning_effort: thinking };
  return undefined;
}

/** The tail of the conversation, as the ad auction's targeting context. */
export function recentContext(messages: OutgoingMessage[]): string {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-4)
    .map((m) => m.content)
    .join(" ");
}

/**
 * A conversation arriving from the browser carries each past turn as a user
 * message and an assistant message with `toolEvents` — but not the `role:"tool"`
 * result messages, which exist only inside the turn that produced them and are
 * not part of the saved transcript. Replayed verbatim, that history hands the
 * provider assistant tool calls that are never answered, and OpenAI-compatible
 * upstreams reject the shape outright: the second message of any tool-using
 * conversation would fail after the first succeeded.
 *
 * So the results are rebuilt from the transcript, which stores each step's
 * output verbatim — this is exactly what was sent upstream when the step ran.
 * Results already present (history built server-side) are left untouched.
 */
export function withRebuiltToolResults(messages: OutgoingMessage[]): OutgoingMessage[] {
  const out: OutgoingMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== "assistant" || !m.toolEvents?.length) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) answered.add(messages[j].id);
    for (const t of m.toolEvents) {
      if (answered.has(t.callId)) continue;
      out.push({
        id: t.callId,
        role: "tool",
        content: JSON.stringify({
          ok: t.status === "done",
          ...(t.status === "running" ? { output: "This step was interrupted before it finished." } : { output: t.output ?? "" }),
        }),
      });
    }
  }
  return out;
}

/**
 * Expand a message's attachments into wire content parts: text files as fenced
 * blocks, images as data URLs. The manifest is prepended so the model knows what
 * it was given even when a file could not be read.
 */
function toWireParts(m: ChatMessage): WireContentPart[] | undefined {
  const hydrated = hydrateAttachments(m.attachments);
  if (!hydrated.length) return undefined;
  const parts: WireContentPart[] = [];
  const manifest = attachmentManifest(hydrated);
  const textBlocks: string[] = [m.content, manifest].filter(Boolean);
  for (const a of hydrated) {
    if (a.kind === "text" && a.text !== undefined) {
      textBlocks.push(`\`\`\`${a.name}\n${a.text}\n\`\`\``);
    }
  }
  parts.push({ type: "text", text: textBlocks.join("\n\n") });
  for (const a of hydrated) {
    if (a.kind === "image" && a.dataUrl) parts.push({ type: "image_url", image_url: { url: a.dataUrl } });
  }
  return parts;
}

const MIN_TOOL_STEPS_BEFORE_AD = 1; // the first tool batch is real work too
const MIN_CHARS_BETWEEN_ADS = 600;
// A text-only reply is a slot too, but only a substantive one: a card after a
// one-line answer reads as spam, and the dock banner already covers short turns.
const MIN_CHARS_FOR_TEXT_AD = 240;
const MAX_STEPS = 24;

// Ad slots are only ever offered at a break in real work: after a tool result
// has landed, never mid-stream, never before the response has done anything. The
// server-side frequency caps in `adlifecycle.ts` sit underneath this and are what
// actually bound the rate — this scheduler is the UI judgement about *when* a
// slot is natural, not the limit on how many there may be.

/** Decides when an inline sponsored card may appear, mirroring Freebuff's
 * "interspersed response slots" idea: never before real work, never spammy. */
class AdScheduler {
  shown = 0;
  lastAdStep = 0;
  lastAdChars = 0;
  recentCampaignIds: string[] = [];

  constructor(private ads: AdsSettings) {}

  shouldServe(step: number, chars: number, pressure: number = 0): boolean {
    if (!this.ads.enabled) return false;
    if (this.shown >= this.ads.maxAdsPerResponse) return false;
    const stepsSince = step - this.lastAdStep;
    const charsSince = chars - this.lastAdChars;
    // Budget-adaptive: thin ledger balance tightens cadence (min 1 step).
    // `step` is 0 for the FIRST tool batch of a turn, so the first-ad threshold
    // is "batches completed before the first card": MIN=1 puts the first card
    // on the first batch (it is real work), MIN=2 on the second.
    const firstStepIndex = Math.max(0, MIN_TOOL_STEPS_BEFORE_AD - pressure - 1);
    const cadence = Math.max(1, this.ads.cadenceSteps - pressure);
    if (this.shown === 0) return stepsSince >= firstStepIndex;
    return stepsSince >= cadence && charsSince >= MIN_CHARS_BETWEEN_ADS;
  }

  async serve(context: string, sessionId?: string): Promise<SponsoredAd | null> {
    const { ad, campaignId } = await serveAd(context, this.recentCampaignIds, { sessionId });
    if (!ad) return null;
    this.shown += 1;
    if (campaignId) this.recentCampaignIds.push(campaignId);
    return ad;
  }

  mark(step: number, chars: number): void {
    this.lastAdStep = step;
    this.lastAdChars = chars;
  }
}

export async function* runAgentTurn(opts: {
  messages: ChatMessage[];
  modelId: string;
  /** Skill ids selected in the composer for this turn. */
  skills?: string[];
  /** Composer thinking level; ignored by models without reasoning support. */
  thinking?: ThinkingIntensity;
  /** How much of the machine this turn may touch. Default: full. */
  access?: AccessMode;
  /** Groups this turn's ad serves, shell cwd and usage for the per-session caps. */
  sessionId?: string;
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  // Operator credentials from the environment are imported on first use, so a
  // fresh install needs no per-chat setup (Freebuff's model).
  runAutoSetup();

  const model = getModelDyn(opts.modelId) ?? MODELS[0];
  const plan = toPlan(model);
  const settings = getSettings();
  const chain = resolveChain(model);

  // No credential means no call. Refused here with a message naming the missing
  // configuration, rather than attempted and failed, so the failure is a
  // configuration error rather than a provider error that looks like an outage.
  if (!chain.length) {
    yield { type: "error", message: needsSetupError(model), needsSetup: true };
    return;
  }
  // Fallbacks are only reachable when the model's policy allows them, and each
  // hop is logged so a fallback is never invisible.
  const { upstream, credential } = chain[0];
  if (chain.length > 1) {
    yield {
      type: "notice",
      message: `Approved fallbacks for ${model.label}: ${chain
        .slice(1)
        .map((h) => providerLabel(h.upstream.provider))
        .join(", ")}.`,
    };
  }

  const scheduler = new AdScheduler(settings.ads);
  let chars = 0;

  // Skills decide both the instructions and the tool set for this turn, and the
  // access mode can only ever narrow it further: a readonly turn loses every
  // tool that could change anything, and that is enforced again at execution.
  const skills = resolveSkills(opts.skills);
  const allowed = allowedToolNames(skills);
  const access: AccessMode = opts.access === "readonly" ? "readonly" : "full";
  const baseAllowed = allowed ? new Set(allowed) : null;
  if (access === "readonly" && baseAllowed) for (const t of READONLY_BLOCKED_TOOLS) baseAllowed.delete(t);
  const effectiveAllowed = access === "readonly" ? (baseAllowed ?? new Set([...TOOLS].map((t) => t.name).filter((n) => !READONLY_BLOCKED_TOOLS.has(n)))) : baseAllowed;
  const tools = effectiveAllowed ? TOOLS.filter((t) => effectiveAllowed.has(t.name)) : TOOLS;
  const system = buildSystemPrompt(skills, effectiveAllowed, settings.workspaceRoot, access);
  const thinking: ThinkingIntensity = opts.thinking ?? settings.thinking ?? "medium";
  const reasoning = reasoningParam(upstream.provider, thinking, !!model?.tags?.includes("reasoning"));

  // Attachments are expanded once, before the loop: every tool step re-sends the
  // context, and re-reading and re-encoding the same files each round trip is
  // pure waste.
  const messages: OutgoingMessage[] = withRebuiltToolResults(
    opts.messages.map((m) => {
      const wireParts = m.role === "user" ? toWireParts(m) : undefined;
      return wireParts ? { ...m, wireParts } : { ...m };
    }),
  );

  for (let step = 0; step < MAX_STEPS; step++) {
    let toolYielded = false;
    const usage = { promptTokens: 0, completionTokens: 0 };
    let actualCostUsd: number | null = null;
    const assistant: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: "", toolEvents: [] };

    // The hard price ceiling and fallback policy for this model, sent with the
    // request so the aggregator cannot route above the price the ledger was
    // funded for. See `providerParams` in router.ts.
    const constraints = providerParams(plan);

    // Upstream calls get one silent retry when the failed attempt streamed
    // nothing at all — and the retry drops the reasoning-effort hint. Reasoning
    // models occasionally come back from the aggregator with reasoning tokens
    // and the stream cut before a single content token ("Provider returned
    // reasoning without a final answer"); replaying the identical request asks
    // the model to drown the same way twice, so the retry asks it to just
    // answer. A turn that already emitted text or tool steps is never retried,
    // because a retry would replay them.
    let streamedAnything = false;
    let attemptReasoning = reasoning;
    let request = beginRequest({
      sessionId: opts.sessionId ?? null,
      modelId: model.id,
      modelLabel: model.label,
      provider: upstream.provider,
      upstreamModel: upstream.model,
    });
    for (let attempt = 0; ; attempt++) {
      usage.promptTokens = 0;
      usage.completionTokens = 0;
      actualCostUsd = null;
      const stream =
        upstream.provider === "anthropic"
          ? streamAnthropic({
              apiKey: credential.key,
              model: upstream.model,
              system,
              messages,
              tools,
              signal: opts.signal,
            })
          : streamOpenAICompatible({
              client: makeClient(upstream, credential.key),
              model: upstream.model,
              messages: toWireMessages(messages, system),
              tools: toWireTools(tools),
              signal: opts.signal,
              // Always capped: an omitted max_tokens makes the aggregator size its
              // affordability check against the model's maximum output, which
              // refuses calls a modestly funded account could serve.
              maxTokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
              meterActualCost: upstream.provider === "openrouter",
              ...(constraints ? { providerParams: constraints } : {}),
              ...(attemptReasoning ? { reasoning: attemptReasoning } : {}),
            });

      try {
        while (true) {
          const r = await stream.next();
          if (r.done) break;
          const ev = r.value;
          if (ev.type === "delta") {
            streamedAnything = true;
            chars += ev.text.length;
            yield ev;
          } else if (ev.type === "usage") {
            usage.promptTokens = ev.usage.promptTokens;
            usage.completionTokens = ev.usage.completionTokens;
            actualCostUsd = ev.actualUsd ?? null;
          } else if (ev.type === "tool") {
            streamedAnything = true;
            toolYielded = true;
            assistant.toolEvents!.push(ev.event);
            yield ev;
          } else if (ev.type === "error") {
            yield ev;
            return;
          }
        }
        break;
      } catch (e) {
        const message = safeUpstreamError(e instanceof Error ? e.message : String(e));
        // A failed request still gets a usage record — with no tokens and no
        // charge — so the failure is visible in accounting rather than only in a
        // transcript that may be gone by the time anyone looks.
        finishRequest({
          requestId: request.requestId,
          promptTokens: 0,
          completionTokens: 0,
          providerCostUsd: null,
          calculatedCostUsd: 0,
          status: "error",
          error: message,
        });
        if (!streamedAnything && attempt === 0) {
          attemptReasoning = undefined; // the retry answers instead of thinking
          request = beginRequest({
            sessionId: opts.sessionId ?? null,
            modelId: model.id,
            modelLabel: model.label,
            provider: upstream.provider,
            upstreamModel: upstream.model,
          });
          continue;
        }
        yield { type: "error", message };
        return;
      }
    }

    // Cost accounting, from the usage record. The provider's own reported charge
    // is authoritative and is preferred over the catalog price table (OpenRouter
    // states the real upstream cost on the final chunk), because booking an
    // estimate while the provider bills the real figure gives a ledger that
    // never reconciles. Which one was used is recorded on the entry.
    const estimatedUsd = estimateCostUsd(model, usage.promptTokens, usage.completionTokens);
    const record = finishRequest({
      requestId: request.requestId,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      providerCostUsd: actualCostUsd,
      calculatedCostUsd: estimatedUsd,
      status: "ok",
    });
    const cost = record?.costUsd ?? actualCostUsd ?? estimatedUsd;
    if (usage.promptTokens || usage.completionTokens) {
      yield {
        type: "usage",
        usage,
        costUsd: cost,
        costMethod: record?.costMethod ?? "none",
        ...(actualCostUsd !== null ? { actualUsd: actualCostUsd } : {}),
      };
    }

    if (!toolYielded) {
      assistant.model = model.label;
      assistant.usage = usage;
      assistant.costUsd = cost;
      messages.push(assistant);
      // A reply that used no tools used to end the turn with no inline card at
      // all — inline slots only opened at tool-step breaks — so a plain
      // conversational exchange earned nothing beyond the dock's rotation. A
      // substantive text reply is a slot too: served after the answer, still
      // bounded by the per-response cap here and the server-side frequency
      // caps underneath, and tightening when the balance is thin (`adPressure`).
      if (chars >= MIN_CHARS_FOR_TEXT_AD && scheduler.shouldServe(step, chars, adPressure())) {
        const ad = await scheduler.serve(recentContext(messages), opts.sessionId);
        if (ad) {
          scheduler.mark(step, chars);
          yield { type: "ad", ad };
        }
      }
      yield { type: "done" };
      return;
    }

    // Freebuff-style inline ad: at most one per tool batch, only after real work.
    if (scheduler.shouldServe(step, chars, adPressure())) {
      const ad = await scheduler.serve(recentContext(messages), opts.sessionId);
      if (ad) {
        scheduler.mark(step, chars);
        yield { type: "ad", ad };
      }
    }

    // Execute every tool call, append results, loop for the next model turn.
    const results: ChatMessage[] = [];
    for (const t of assistant.toolEvents!) {
      // A skill's tool allowlist — and a readonly turn's blocklist — are
      // enforced here too, not just advertised in the prompt: a model can call
      // a tool it was never offered.
      const denied = effectiveAllowed
        ? !effectiveAllowed.has(t.name)
          ? `Tool \`${t.name}\` is not available under the active skill.`
          : null
        : null;
      const r = denied
        ? { callId: t.callId, ok: false, output: denied }
        : await executeTool(settings.workspaceRoot, t.name, t.args, { sessionId: opts.sessionId });
      t.status = r.ok ? "done" : "error";
      t.output = r.output;
      // Re-emit the finished step. The `running` event was serialized before the
      // tool executed, so without this the transcript's timeline shows every step
      // as still in flight, and its output is never reachable in the UI.
      yield { type: "tool", event: { ...t, args: t.args } };
      results.push({ id: t.callId, role: "tool", content: JSON.stringify({ ok: r.ok, output: r.output }) });
    }
    messages.push(assistant, ...results);
  }

  yield { type: "error", message: "Stopped after many tool steps. Ask me to continue if there is more to do." };
}
