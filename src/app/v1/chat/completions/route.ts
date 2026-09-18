import { NextRequest } from "next/server";
import OpenAI from "openai";
import { listModels, getModelDyn } from "@/lib/modelstore";
import { modelAccess, premiumGateError } from "@/lib/premium";
import { makeClient, toWireMessages } from "@/lib/providers";
import { resolveChain } from "@/lib/routing";
import { estimateCostUsd } from "@/lib/models";
import { beginRequest, finishRequest } from "@/lib/usage";
import { requireApi } from "@/lib/auth";
import { PROVIDER_NOT_CONFIGURED, providerConfigured, scrubSecrets } from "@/lib/credentials";
import { admitRequest, estimateTurnCostUsd } from "@/lib/funding";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type WireMsg = { role: "system" | "user" | "assistant" | "tool"; content: string | null };

/**
 * Our own OpenAI-compatible completions endpoint.
 *
 * No user tokens and no user keys: a caller authenticates with the single
 * operator password (optional), and the server spends Infyield's own provider
 * credential, funded by ad revenue.
 */
export async function POST(req: NextRequest) {
  const denied = requireApi(req);
  if (denied) return denied;

  // Fail closed, exactly as the agent route does: no credential, no call, and
  // the answer names the missing configuration rather than looking like an
  // upstream outage.
  if (!providerConfigured()) {
    return Response.json(
      { error: { message: PROVIDER_NOT_CONFIGURED, type: "setup_error", code: "provider-not-configured" } },
      { status: 503 },
    );
  }

  let body: {
    model?: string;
    messages?: WireMsg[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // An unknown model is refused, not silently swapped for the catalog default.
  // `?? listModels()[0]` meant a request for an id the catalog does not carry (a
  // provider-native one, or a typo) quietly ran something else and billed for it
  // — and on this surface the caller is a program, so it would have had no way to
  // notice. The gate below then also checks the model that will really run.
  const requestedId = (body.model ?? "").trim();
  const catalogModel = requestedId ? getModelDyn(requestedId) : listModels()[0];
  if (!catalogModel) {
    return Response.json(
      {
        error: {
          message: `Unknown model "${requestedId}". GET /v1/models lists the ids this server will run.`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      { status: 404 },
    );
  }

  // Same reserve-tier gate as the agent route, so the OpenAI-compatible surface
  // cannot be used to spend past what the ads have earned.
  if (catalogModel.requiresBalanceUsd) {
    const access = modelAccess(catalogModel);
    if (!access.unlocked) {
      return Response.json(
        { error: { message: premiumGateError(catalogModel, access), type: "insufficient_balance" } },
        { status: 402 },
      );
    }
  }

  const chain = resolveChain(catalogModel);
  if (!chain.length) {
    return Response.json(
      {
        error: {
          message: `${PROVIDER_NOT_CONFIGURED} "${catalogModel.label}" resolves to ${catalogModel.upstream.provider}, which Infyield holds no credential for.`,
          type: "setup_error",
          code: "provider-not-configured",
        },
      },
      { status: 503 },
    );
  }

  // Provider-spend admission, before anything is sent upstream. This surface is
  // reachable by programs, so it is gated by the same policy as the agent route
  // rather than trusting the caller to be well behaved.
  const estimate = estimateTurnCostUsd(catalogModel, (body.messages ?? []).length * 500);
  const decision = admitRequest({ model: catalogModel, estimatedCostUsd: estimate });
  if (!decision.allowed) {
    return Response.json(
      {
        error: {
          message: decision.message,
          type: decision.disposition === "defer" ? "insufficient_balance" : "setup_error",
          code: decision.code,
        },
      },
      { status: decision.disposition === "defer" ? 429 : 503 },
    );
  }

  const { upstream, credential } = chain[0];

  const client = makeClient(upstream, credential.key);
  const messages = body.messages ?? [];

  // One usage record for this request, opened before the call so a request that
  // hangs or dies still leaves evidence it happened. Which branch serves it
  // decides only when the record is closed, never whether one exists.
  const request = beginRequest({
    modelId: catalogModel.id,
    modelLabel: `${catalogModel.label} (API)`,
    provider: upstream.provider,
    upstreamModel: upstream.model,
  });

  try {
    if (body.stream) {
      const upstreamStream = await client.chat.completions.create({
        model: upstream.model,
        messages: messages as never,
        stream: true,
        stream_options: { include_usage: true },
        ...(upstream.provider === "openrouter" ? { usage: { include: true } } : {}),
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
        ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let usagePrompt = 0;
          let usageCompletion = 0;
          let actualCost = 0;
          const id = `chatcmpl-${crypto.randomUUID()}`;
          const created = Math.floor(Date.now() / 1000);
          const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          try {
            for await (const chunk of upstreamStream) {
              if (chunk.usage) {
                const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; cost?: number };
                usagePrompt = u.prompt_tokens ?? 0;
                usageCompletion = u.completion_tokens ?? 0;
                if (typeof u.cost === "number" && u.cost > 0) actualCost = u.cost;
              }
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model: catalogModel.id,
                choices: chunk.choices.map((c) => ({
                  index: c.index,
                  delta: c.delta,
                  finish_reason: c.finish_reason,
                })),
              });
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } finally {
            // One usage record per upstream request, so the OpenAI-compatible
            // surface is accounted for exactly like the agent's own turns. The
            // provider's own charge wins over our price-table estimate.
            finishRequest({
              requestId: request.requestId,
              promptTokens: usagePrompt,
              completionTokens: usageCompletion,
              providerCostUsd: actualCost > 0 ? actualCost : null,
              calculatedCostUsd: estimateCostUsd(catalogModel, usagePrompt, usageCompletion),
              status: "ok",
            });
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
      });
    }

    const res = await client.chat.completions.create({
      model: upstream.model,
      messages: messages as never,
      stream: false,
      ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
      ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
    });

    const u = res.usage as (typeof res.usage & { cost?: number }) | undefined;
    const reportedCost = typeof u?.cost === "number" && u.cost > 0 ? u.cost : null;
    finishRequest({
      requestId: request.requestId,
      promptTokens: u?.prompt_tokens ?? 0,
      completionTokens: u?.completion_tokens ?? 0,
      providerCostUsd: reportedCost,
      calculatedCostUsd: estimateCostUsd(catalogModel, u?.prompt_tokens ?? 0, u?.completion_tokens ?? 0),
      status: "ok",
    });

    return Response.json({
      id: res.id,
      object: "chat.completion",
      created: res.created,
      model: catalogModel.id,
      choices: res.choices,
      usage: res.usage,
    });
  } catch (e) {
    const msg = scrubSecrets(e instanceof Error ? e.message : String(e));
    // A failure still closes its usage record, so the attempt is visible in
    // accounting and not only in a response the caller may have discarded.
    finishRequest({
      requestId: request.requestId,
      promptTokens: 0,
      completionTokens: 0,
      providerCostUsd: null,
      calculatedCostUsd: 0,
      status: "error",
      error: msg,
    });
    return Response.json({ error: { message: msg, type: "upstream_error" } }, { status: 502 });
  }
}
