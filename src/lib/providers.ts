import OpenAI from "openai";
import type {
  ChatMessage,
  ProviderKind,
  SponsoredAd,
  StreamEvent,
  ToolSpec,
  UpstreamMapping,
} from "./types";

// ---------- Wire types (OpenAI-compatible; used by OpenAI/DeepSeek/GLM/Google/custom) ----------

/**
 * A part of a message's content. Text plus inline images is what every modern
 * endpoint accepts; images ride as data URLs because attachments are local files
 * with no public URL to point at.
 */
export type WireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | WireContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * A transcript message plus the parts it should be sent as. `wireParts` is set
 * by the agent after hydrating attachments; when absent the message content is
 * sent as a plain string, which is the case for every message without files.
 */
export type OutgoingMessage = ChatMessage & { wireParts?: WireContentPart[] };

export interface WireTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export function toWireMessages(messages: OutgoingMessage[], system: string): WireMessage[] {
  const out: WireMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const calls = (m.toolEvents ?? []).map((t) => ({
        id: t.callId,
        type: "function" as const,
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      }));
      out.push({ role: "assistant", content: m.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (m.role === "tool") {
      out.push({ role: "tool", content: m.content, tool_call_id: m.id });
    } else {
      out.push({ role: "user", content: m.wireParts?.length ? m.wireParts : m.content });
    }
  }
  return out;
}

export function toWireTools(tools: ToolSpec[]): WireTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * The completion cap sent with every OpenAI-compatible request.
 *
 * It has to be sent, and the reason is not tidiness. When `max_tokens` is
 * omitted, an aggregator sizes its affordability check against the *model's*
 * maximum output instead of what you asked for. OpenRouter then refuses calls an
 * account could actually serve, with a message that names the trap directly:
 *
 *   402 This request requires more credits, or fewer max_tokens. You requested
 *   up to 131072 tokens, but can only afford 19193.
 *
 * `streamAnthropic` already sent a cap; the OpenAI-compatible path did not, and
 * that path is the one every agent turn goes through. A bounded default also
 * means one step cannot run away with the bill.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// ---------- Client construction ----------

const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta/openai/";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/**
 * A mock provider's base URL, when one is configured.
 *
 * Test seam, environment-only by design: there is no request field, settings
 * key, or UI control that can redirect a live install at a fake inference
 * endpoint, because doing so would let the app book provider spend and generate
 * "successful" turns that no model ever produced. `mode.ts` reads this same
 * variable to mark the whole run SIMULATED, so a mocked request can never be
 * reported as production traffic.
 */
export function providerBaseOverride(): string {
  return (process.env.INFYIELD_PROVIDER_BASE_URL ?? "").trim();
}

export function makeClient(upstream: UpstreamMapping, apiKey: string): OpenAI {
  const baseURL =
    providerBaseOverride() ||
    upstream.baseUrl ||
    (upstream.provider === "google"
      ? GOOGLE_BASE
      : upstream.provider === "openrouter"
        ? OPENROUTER_BASE
        : undefined);
  return new OpenAI({
    apiKey: apiKey || "not-needed",
    ...(upstream.provider === "openrouter" ? { defaultHeaders: { "HTTP-Referer": "https://infyield.local", "X-Title": "Infyield" } } : {}),
    ...(baseURL ? { baseURL } : {}),
  });
}

// ---------- OpenAI-compatible streaming ----------

export async function* streamOpenAICompatible(opts: {
  client: OpenAI;
  model: string;
  messages: WireMessage[];
  tools?: WireTool[];
  signal?: AbortSignal;
  /** Ask an aggregator (OpenRouter) for its usage accounting, which carries the
   * *actual* upstream charge. `stream_options.include_usage` is OpenAI-only and
   * does not make OpenRouter report cost. */
  meterActualCost?: boolean;
  /** Provider-native deliberation knob, merged verbatim into the request body.
   * The caller picks the shape (OpenRouter `reasoning`, OpenAI `reasoning_effort`)
   * because only the caller knows which upstream it is talking to. */
  reasoning?: Record<string, unknown>;
  /**
   * The aggregator's `provider` block: the price ceiling and fallback policy.
   * Sent so routing cannot cost more than the catalog priced — OpenRouter treats
   * `max_price` as a hard filter and refuses to route rather than silently
   * choosing a pricier upstream. Built by `providerParams` in router.ts.
   */
  providerParams?: Record<string, unknown>;
  /** Completion cap for this call. Always sent — see DEFAULT_MAX_OUTPUT_TOKENS. */
  maxTokens?: number;
}): AsyncGenerator<StreamEvent> {
  // Cast through the streaming params type: the extra `usage` field (OpenRouter's
  // usage accounting) is not part of the OpenAI schema, and `as never` would
  // collapse the overload so the result stops being async-iterable.
  const body = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
    ...(opts.meterActualCost ? { usage: { include: true } } : {}),
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.providerParams ? { provider: opts.providerParams } : {}),
    ...(opts.reasoning ? opts.reasoning : {}),
  } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
  const stream = await opts.client.chat.completions.create(body, { signal: opts.signal });

  const pending = new Map<number, { id: string; name: string; args: string }>();
  let usage = { promptTokens: 0, completionTokens: 0 };
  let finishReason: string | null = null;
  let actualCost: number | undefined;
  // Reasoning models (OpenRouter routes carry `delta.reasoning`, some providers
  // `delta.reasoning_content`) can spend the whole call thinking and get cut off
  // before a single content token. As a clean end-of-stream it looks like a
  // successful empty answer; raising here turns it into a retryable failure the
  // agent loop handles, instead of a transcript that stops mid-task in silence.
  let sawContent = false;
  let sawReasoning = false;
  // Set once a tool-call batch has been emitted as events. A reasoning model
  // that answers with tool calls and no prose is not a failure — it is the
  // normal shape of an agentic step — and ending the stream there used to be
  // misread as "reasoning without a final answer", killing the turn after the
  // call was shown but before the tool ever ran.
  let yieldedToolCalls = false;

  for await (const chunk of stream) {
    if (chunk.usage) {
      const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      usage = {
        promptTokens: u.prompt_tokens ?? 0,
        completionTokens: u.completion_tokens ?? 0,
      };
      if (typeof u.cost === "number" && u.cost > 0) actualCost = u.cost;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;
    if (delta.content) {
      sawContent = true;
      yield { type: "delta", text: delta.content };
    }
    const reasoningText = (delta as { reasoning?: unknown; reasoning_content?: unknown }).reasoning ??
      (delta as { reasoning_content?: unknown }).reasoning_content;
    if (typeof reasoningText === "string" && reasoningText) sawReasoning = true;
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = pending.get(idx) ?? { id: tc.id ?? `call_${idx}_${Date.now()}`, name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      pending.set(idx, cur);
    }
    if (finishReason === "tool_calls" && pending.size) {
      for (const [, p] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        try {
          args = p.args ? JSON.parse(p.args) : {};
        } catch {}
        yield { type: "tool", event: { callId: p.id, name: p.name, args, status: "running" } };
      }
      pending.clear();
      yieldedToolCalls = true;
    }
  }
  // End-of-stream triage, in order of specificity:
  //  - a tool-call batch went out: healthy, whatever the reasoning/content mix;
  //  - tool-call arguments were still arriving when the stream cut: truncated,
  //    and retryable — the call can never be parsed into a tool execution;
  //  - reasoning with neither content nor calls: the answerless stream this
  //    check was written for, and the one worth raising as retryable.
  if (pending.size > 0) {
    throw new Error("Provider stream ended mid tool-call.");
  }
  if (!sawContent && !yieldedToolCalls && sawReasoning) {
    throw new Error("Provider returned reasoning without a final answer.");
  }
  if (usage.promptTokens || usage.completionTokens) {
    yield { type: "usage", usage, costUsd: actualCost ?? 0, ...(actualCost !== undefined ? { actualUsd: actualCost } : {}) };
  }
  yield { type: "done" };
}

// ---------- Native Anthropic streaming ----------

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** Present on `image` blocks; base64 attachment payload. */
  source?: unknown;
}

/**
 * Build Anthropic messages from our history. Tool results must be
 * user-message content blocks of type `tool_result` referencing tool_use ids.
 */
/**
 * Turn wire parts into Anthropic content blocks. Attached images arrive as data
 * URLs (that is how the attachment store hands them over), and Anthropic wants
 * base64 + media type split apart.
 */
function anthropicUserBlocks(m: OutgoingMessage): AnthropicContentBlock[] {
  if (!m.wireParts?.length) return [{ type: "text", text: m.content }];
  const blocks: AnthropicContentBlock[] = [];
  for (const part of m.wireParts) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    const match = /^data:([^;]+);base64,([\s\S]*)$/.exec(part.image_url.url);
    if (!match) continue;
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] } as unknown as undefined,
    });
  }
  return blocks.length ? blocks : [{ type: "text", text: m.content }];
}

export function toAnthropicMessages(messages: OutgoingMessage[]): { role: "user" | "assistant"; content: unknown }[] {
  const out: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const t of m.toolEvents ?? []) {
        blocks.push({ type: "tool_use", id: t.callId, name: t.name, input: t.args });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      // m.id is the tool_use callId it answers; m.content is the JSON result
      const last = out[out.length - 1];
      const block = { type: "tool_result", tool_use_id: m.id, content: m.content };
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as AnthropicContentBlock[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    } else if (m.role === "user") {
      out.push({ role: "user", content: anthropicUserBlocks(m) });
    }
  }
  return out;
}

export async function* streamAnthropic(opts: {
  apiKey: string;
  model: string;
  system: string;
  messages: OutgoingMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const body = {
    model: opts.model,
    max_tokens: 8192,
    system: opts.system,
    stream: true,
    ...(opts.tools?.length
      ? { tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
      : {}),
    messages: toAnthropicMessages(opts.messages),
  };

  const res = await fetch(`${providerBaseOverride() || "https://api.anthropic.com"}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    let msg = `Anthropic API error ${res.status}`;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j.error?.message) msg = `Anthropic API error: ${j.error.message}`;
    } catch {}
    yield { type: "error", message: msg };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pending = new Map<string, { name: string; args: string }>();
  let lastToolId = "";
  const usage = { promptTokens: 0, completionTokens: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: { type: string; [k: string]: unknown };
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      switch (ev.type) {
        case "message_start": {
          const u = (ev.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
          usage.promptTokens = u?.input_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const cb = ev.content_block as AnthropicContentBlock;
          if (cb?.type === "tool_use" && cb.id) {
            lastToolId = cb.id;
            pending.set(cb.id, { name: cb.name ?? "", args: "" });
          }
          break;
        }
        case "content_block_delta": {
          const d = ev.delta as { type: string; text?: string; partial_json?: string };
          if (d?.type === "text_delta" && d.text) yield { type: "delta", text: d.text };
          if (d?.type === "input_json_delta" && d.partial_json && lastToolId) {
            const p = pending.get(lastToolId);
            if (p) pending.set(lastToolId, { ...p, args: p.args + d.partial_json });
          }
          break;
        }
        case "content_block_stop": {
          const p = lastToolId ? pending.get(lastToolId) : undefined;
          if (p) {
            pending.delete(lastToolId);
            let args: Record<string, unknown> = {};
            try {
              args = p.args ? JSON.parse(p.args) : {};
            } catch {}
            yield { type: "tool", event: { callId: lastToolId, name: p.name, args, status: "running" } };
          }
          lastToolId = "";
          break;
        }
        case "message_delta": {
          const u = ev.usage as { output_tokens?: number } | undefined;
          if (u?.output_tokens) usage.completionTokens = u.output_tokens;
          break;
        }
        case "error": {
          const e = ev.error as { message?: string } | undefined;
          yield { type: "error", message: e?.message ?? "Anthropic stream error" };
          return;
        }
      }
    }
  }
  if (usage.promptTokens || usage.completionTokens) yield { type: "usage", usage, costUsd: 0 };
  yield { type: "done" };
}

// Sponsored ad in stream events is declared in types.ts; agents attach ads via
// the ad hooks in agent.ts. (Kept here as a type reference to avoid cycles.)
export type { SponsoredAd };
export type { ProviderKind };
