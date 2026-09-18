import { NextRequest } from "next/server";
import type { ChatMessage, ThinkingIntensity } from "@/lib/types";
import { runAgentTurn } from "@/lib/agent";
import { seedHouseAdsIfEmpty } from "@/lib/ads";
import { requireApi } from "@/lib/auth";
import { DEFAULT_MODEL_ID } from "@/lib/models";
import { getModelDyn } from "@/lib/modelstore";
import { modelAccess } from "@/lib/premium";
import { PROVIDER_NOT_CONFIGURED, providerConfigured, providerStatus } from "@/lib/credentials";
import { admitRequest, estimateTurnCostUsd, fundingSnapshot } from "@/lib/funding";
import { toPlan } from "@/lib/router";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Rough input size, used only to price the turn before it starts. */
function approxPromptTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += (m.content ?? "").length;
  return Math.max(1, Math.round(chars / 4));
}

export async function POST(req: NextRequest) {
  // The API password, not the admin one: chatting is not administering. With
  // neither set, this is reachable from this machine only.
  const denied = requireApi(req);
  if (denied) return denied;

  let body: {
    messages?: ChatMessage[];
    model?: string;
    /** Skill ids chosen in the composer; they set the tool set for the turn. */
    skills?: string[];
    /** Deliberation level for this turn. */
    thinking?: ThinkingIntensity;
    /** How much of the machine the turn may touch: full or readonly. */
    access?: "full" | "readonly";
    /** Groups ad serves and usage for the per-session caps. */
    sessionId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return Response.json({ error: "messages required" }, { status: 400 });

  // ---- Fail closed: no credential, no call ---------------------------------
  //
  // Checked before anything else, and before the model is even resolved, so the
  // answer is "the deployment is not configured" rather than a provider error
  // that looks like an outage. The caller is told exactly which environment
  // variables are missing; there is no path in which a caller supplies one.
  if (!providerConfigured()) {
    return Response.json(
      {
        error: PROVIDER_NOT_CONFIGURED,
        code: "provider-not-configured",
        providers: providerStatus("openrouter"),
      },
      { status: 503 },
    );
  }

  seedHouseAdsIfEmpty();

  // ---- Resolve the model server-side ---------------------------------------
  //
  // The client names an Infyield model id and nothing else. An id the catalog
  // does not know is refused rather than quietly swapped for whatever is first
  // in the catalog: serving a different model than the caller chose is exactly
  // the silent downgrade this resolution exists to prevent.
  const requestedId = body.model || DEFAULT_MODEL_ID;
  const requested = getModelDyn(requestedId);
  if (!requested) {
    return Response.json(
      { error: `Unknown model "${requestedId}". GET /api/models lists the ids this server will run.` },
      { status: 400 },
    );
  }
  const plan = toPlan(requested);

  // ---- Provider-spend admission control ------------------------------------
  //
  // "Can Infyield afford this?" — not "does the provider API work?". Runs once,
  // before the turn starts; an in-flight turn is never interrupted. `defer` and
  // `deny` are distinguished so a caller is told honestly whether waiting can
  // help: an empty ledger refills as ads are reconciled, a disabled model never
  // will.
  const estimate = estimateTurnCostUsd(requested, approxPromptTokens(messages));
  const decision = admitRequest({
    model: requested,
    estimatedCostUsd: estimate,
    sessionId: body.sessionId,
  });
  if (!decision.allowed) {
    const status = decision.disposition === "defer" ? 429 : decision.code === "premium-locked" ? 402 : 503;
    return Response.json(
      {
        error: decision.message,
        code: decision.code,
        disposition: decision.disposition,
        estimatedCostUsd: decision.estimatedCostUsd,
        funding: decision.snapshot,
        ...(decision.retryAfterSec ? { retryAfterSec: decision.retryAfterSec } : {}),
        // Kept so the model picker's per-model affordance keeps working.
        ...(decision.code === "premium-locked" ? { premium: modelAccess(requested) } : {}),
      },
      {
        status,
        ...(decision.retryAfterSec ? { headers: { "retry-after": String(decision.retryAfterSec) } } : {}),
      },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      // Tell the client what funded the turn before any work happens, so the
      // economics of a request are visible rather than implied.
      send({ type: "funding", funding: fundingSnapshot(), model: plan.id, estimatedCostUsd: estimate });
      try {
        for await (const ev of runAgentTurn({
          messages,
          modelId: body.model || DEFAULT_MODEL_ID,
          skills: Array.isArray(body.skills) ? body.skills : undefined,
          thinking: body.thinking,
          access: body.access === "readonly" ? "readonly" : "full",
          sessionId: body.sessionId,
          signal: req.signal,
        })) {
          send(ev);
        }
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
