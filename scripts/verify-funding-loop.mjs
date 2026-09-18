#!/usr/bin/env node
/**
 * End-to-end proof that ad money and model spend flow through ONE ledger.
 *
 *   ad rendered  -> POST /api/ads/impression  -> confirmed ad revenue (CPM)
 *   ad clicked   -> POST /api/ads/click       -> confirmed ad revenue (CPC)
 *   model call   -> estimateCostUsd(prompt, completion) -> spend debit
 *
 * A real OpenRouter key belongs to the operator's account, so this script stands
 * a local OpenAI-compatible upstream in for it. Everything else is the app's own
 * code path: the agent loop, the tool steps, the inline ad slots, the tracking
 * endpoints and the ledger. The mock's token usage per turn is fixed, so the
 * cost it should produce is arithmetic rather than a guess — the script computes
 * the expected figures and asserts the ledger matches them.
 *
 * ISOLATION: like the other suites, this one writes to the instance it tests —
 * it serves impressions and clicks (booking revenue) and registers a probe key
 * and model, and it deliberately leaves its ledger entries behind as evidence.
 * It therefore brings its own scratch instance by default; see
 * scripts/lib/scratch-app.mjs. Pointing it at an existing server requires
 * INFYIELD_ALLOW_LIVE=1 and is destructive.
 *
 * Usage:
 *   node scripts/verify-funding-loop.mjs                       # own scratch instance
 *   INFYIELD_ALLOW_LIVE=1 INFYIELD_BASE=http://localhost:3899 \
 *     node scripts/verify-funding-loop.mjs
 */
import { createServer } from "node:http";
import { announceTarget, createScratchApp, freePort, resolveTarget } from "./lib/scratch-app.mjs";
import { seedConfirmedRevenue, startMockAdEnv } from "./lib/fund-scratch.mjs";

// See lib/scratch-app.mjs: a fixed scratch port is how this suite once ran
// against whatever else happened to be listening there.
const target = await resolveTarget(3779);
const BASE = target.base;
const MOCK_PORT = Number(process.env.INFYIELD_MOCK_PORT || (await freePort()));
const PRICE_IN = 0.28; // USD per 1M input tokens (catalog price for the probe model)
const PRICE_OUT = 1.1; // USD per 1M output tokens

/**
 * The instance is configured the way the product is meant to be configured: the
 * credential is Infyield's own (`OPENROUTER_API_KEY`), and the caller supplies
 * nothing. The base-URL seam is environment-only, so pointing this at a mock
 * cannot be done through any request on a live install.
 */
const { adnet, env: adEnv } = await startMockAdEnv({
  OPENROUTER_API_KEY: "mock-infyield-provider-credential",
  INFYIELD_PROVIDER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
});

const scratchApp = createScratchApp({
  base: BASE,
  port: target.port,
  serverPath: target.serverPath,
  prefix: "infyield-funding-",
  env: adEnv,
});

// One entry per model turn the agent makes. Usage is fixed per turn so the
// expected spend can be computed exactly. The tool turns matter for the ad
// slots: cadence is budget-adaptive, so a funded balance waits for
// MIN_TOOL_STEPS_BEFORE_AD (2) steps while a thin balance serves after 1 —
// three tool turns cover both regimes.
const TURNS = [
  { tool: { path: "." }, prompt: 1200, completion: 40 },
  { tool: { path: "src" }, prompt: 1400, completion: 45 },
  { tool: { path: "scripts" }, prompt: 1500, completion: 42 },
  {
    text:
      "Read the workspace: it is an Infyield checkout — a Next.js app under src/, an Electron shell under electron/, " +
      "and the ads + economy engine under src/lib. The ledger below accounts for this call.",
    prompt: 1600,
    completion: 300,
  },
];

const money = (n) => `$${Number(n).toFixed(6)}`;

function chunkText(text, size = 44) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** A minimal but faithful OpenAI-compatible streaming upstream. */
function startMockUpstream(port) {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock upstream: only /v1/chat/completions" } }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {}
      const toolTurns = (parsed.messages ?? []).filter((m) => m.role === "tool").length;
      const turn = TURNS[Math.min(toolTurns, TURNS.length - 1)];
      const id = `chatcmpl-mock-${toolTurns}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = {
        prompt_tokens: turn.prompt,
        completion_tokens: turn.completion,
        total_tokens: turn.prompt + turn.completion,
      };
      const base = { id, object: "chat.completion.chunk", created, model: parsed.model ?? "mock-probe-1" };
      const calls = turn.tool
        ? [
            {
              id: `call_mock_${toolTurns}`,
              type: "function",
              function: { name: "list_dir", arguments: JSON.stringify(turn.tool) },
            },
          ]
        : null;

      if (!parsed.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: parsed.model,
            choices: [
              {
                index: 0,
                message: calls
                  ? { role: "assistant", content: null, tool_calls: calls.map((c, i) => ({ ...c, index: i })) }
                  : { role: "assistant", content: turn.text },
                finish_reason: calls ? "tool_calls" : "stop",
              },
            ],
            usage,
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (turn.text) {
        for (const piece of chunkText(turn.text)) {
          send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        }
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      } else {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { tool_calls: calls.map((c, i) => ({ ...c, index: i })) },
              finish_reason: null,
            },
          ],
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      }
      send({ ...base, choices: [], usage }); // stream_options.include_usage
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${JSON.stringify(parsed)}`);
  return parsed;
}

async function deleteJson(path) {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  return res.ok;
}

/** Drive the agent's SSE endpoint and collect every event it emits. */
async function runAgentChat(modelId, text) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: modelId, messages: [{ id: "m1", role: "user", content: text }] }),
  });
  if (!res.ok || !res.body) throw new Error(`POST /api/chat -> ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (!raw.startsWith("data:")) continue;
      const payload = raw.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        events.push(JSON.parse(payload));
      } catch {}
    }
  }
  return events;
}

function check(label, ok, detail) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  announceTarget("Infyield funding-loop verification", target);

  if (!target.live) await scratchApp.start();

  const boot = await getJson("/api/bootstrap").catch(() => null);
  if (!boot) {
    console.error(`Cannot reach ${BASE}. ${target.live ? "Start the instance you pointed at." : "The scratch instance failed to boot."}`);
    await scratchApp.stop();
    process.exit(1);
  }

  const mock = await startMockUpstream(MOCK_PORT);
  console.log(`▶ mock upstream listening on http://127.0.0.1:${MOCK_PORT}/v1 (stand-in for OpenRouter)\n`);

  let modelId = "";
  const failures = [];

  try {
    // A priced model cannot start until collectible ad revenue exists (see
    // src/lib/funding.ts), so the instance is funded first — through the real
    // serve → impression → reconcile path, not by writing a ledger entry.
    const funded = await seedConfirmedRevenue(BASE, { targetUsd: 2 });
    console.log(
      `▶ funded from ${funded.served} simulated network impression(s): confirmed ${money(funded.confirmedUsd)}, ` +
        `provider budget ${money(funded.budgetUsd)}${funded.lastReason ? ` (${funded.lastReason})` : ""}\n`,
    );

    const before = await getJson("/api/economy");
    console.log(
      `before      ads ${money(before.adRevenueUsd)} confirmed · ${money(before.estimatedRevenueUsd)} pending · ` +
        `api spend ${money(before.spendUsd)} · balance ${money(before.balanceUsd)}`,
    );

    // 1. Register the probe model. There is no key to register: the credential is
    //    Infyield's own, from the environment, and `provider: "openrouter"` is
    //    the provider that credential belongs to. Nothing here is supplied by a
    //    caller, which is the property under test. Same path an operator uses to
    //    add any real model in Admin → Models.
    const modelRes = await postJson("/api/admin/models", {
      label: "Ledger Probe (mock)",
      provider: "openrouter",
      upstreamModel: "mock-probe-1",
      priceIn: PRICE_IN,
      priceOut: PRICE_OUT,
      contextWindow: 128000,
    });
    modelId = modelRes.model.id;
    console.log(`▶ registered model "${modelId}" on Infyield's own credential\n`);

    // 3. One real agent turn through the app: tool steps happen, so inline ad
    //    slots open, and each model call debits the ledger.
    const events = await runAgentChat(modelId, "List the workspace and tell me what this project is.");
    // Each step streams twice (running, then its result), so count unique calls
    // rather than events — otherwise one step looks like two.
    const tools = [
      ...new Map(
        events.filter((e) => e.type === "tool").map((e) => [e.event.callId, e]),
      ).values(),
    ];
    const ads = events.filter((e) => e.type === "ad").map((e) => e.ad);
    const usages = events.filter((e) => e.type === "usage");
    const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    const errors = events.filter((e) => e.type === "error");

    console.log("agent turn");
    console.log(`  steps      ${tools.map((t) => t.event.name).join(" → ") || "(none)"}`);
    console.log(`  model      ${usages.length} upstream calls`);
    console.log(`  ads        ${ads.length} inline card(s)${ads[0] ? ` — "${ads[0].title}" (${ads[0].domain})` : ""}`);
    console.log(`  answer     ${answer.slice(0, 72)}${answer.length > 72 ? "…" : ""}`);
    if (errors.length) console.log(`  errors     ${errors.map((e) => e.message).join("; ")}`);

    // 4. The client-side events that turn a rendered card into revenue.
    let adCredited = 0;
    const impressions = [];
    for (const ad of ads) {
      const ack = (path, eventId, method = "POST") =>
        fetch(`${BASE}${path}`, { method, headers: { "x-event-id": eventId } }).then((r) => r.json());
      const imp = await ack(ad.impUrl, `imp-${ad.impUrl}`);
      const dup = await ack(ad.impUrl, `imp-${ad.impUrl}`);
      const click = await ack(ad.clickUrl, `clk-${ad.impUrl}`);
      const clickDup = await ack(ad.clickUrl, `clk-${ad.impUrl}`);
      adCredited += (imp.creditedUsd ?? 0) + (click.creditedUsd ?? 0);
      impressions.push({ imp, dup, click, clickDup });
      console.log(
        `\n  impression  +${money(imp.creditedUsd ?? 0)}   duplicate retry: ${dup.alreadyRecorded ? "ignored (idempotent)" : "CREDITED AGAIN"}`,
      );
      console.log(
        `  click       +${money(click.creditedUsd ?? 0)}   duplicate retry: ${clickDup.alreadyRecorded ? "ignored (idempotent)" : "CREDITED AGAIN"}`,
      );
    }

    // 5. Settle the books.
    const after = await getJson("/api/economy");

    const expectedSpend = TURNS.reduce(
      (n, t) => n + (t.prompt / 1e6) * PRICE_IN + (t.completion / 1e6) * PRICE_OUT,
      0,
    );
    const spendDelta = after.spendUsd - before.spendUsd;
    const revenueDelta = after.adRevenueUsd - before.adRevenueUsd;
    const pendingDelta = after.estimatedRevenueUsd - before.estimatedRevenueUsd;

    console.log("\nledger");
    console.log(`  ad revenue  ${money(before.adRevenueUsd)} → ${money(after.adRevenueUsd)}  (+${money(revenueDelta)})`);
    console.log(`  pending     ${money(before.estimatedRevenueUsd)} → ${money(after.estimatedRevenueUsd)}  (+${money(pendingDelta)})`);
    console.log(`  api spend   ${money(before.spendUsd)} → ${money(after.spendUsd)}  (+${money(spendDelta)})`);
    console.log(`  balance     ${money(before.balanceUsd)} → ${money(after.balanceUsd)}`);
    // There is no key pool to inspect any more (the `/api/keys` surface is
    // deleted), so "no caller-supplied key was involved" is asserted from the one
    // place a credential can now come from: the deployment's own environment.
    // `keys` is still reported and must stay zero, and the credential in force
    // must be the environment's rather than a file written by a request.
    const boot = await getJson("/api/bootstrap");
    const orProvider = (boot.providers ?? []).find((p) => p.provider === "openrouter");
    console.log(`  credentials ${boot.keys} caller-supplied key(s); serving on the ${orProvider?.source ?? "absent"} credential`);

    console.log("\nassertions");
    if (!check("agent loop ran real tool steps", tools.length >= 2, `${tools.length} steps`)) failures.push("tool steps");
    if (!check("inline ad served during the work", ads.length >= 1, `${ads.length} cards`)) failures.push("ad served");
    // A network impression books as PENDING, not confirmed: the network pays on
    // its own schedule, so until its statement is reconciled nobody has been
    // billed. Asserting on the confirmed total here would be asserting the bug
    // this design exists to prevent — so the check is on the pending bucket, and
    // `reconcile` is what moves it across (see verify-ad-funding.mjs section 7).
    if (
      !check(
        "impression credited revenue",
        pendingDelta > 0 && adCredited > 0,
        `+${money(adCredited)} credited, booked pending (+${money(pendingDelta)}); confirmed unchanged at ${money(after.adRevenueUsd)}`,
      )
    )
      failures.push("impression credit");
    if (
      !check(
        "click credited revenue",
        impressions.length > 0 && impressions.every((i) => (i.click.creditedUsd ?? 0) > 0),
        `+${money(adCredited)} across impression+click`,
      )
    )
      failures.push("click credit");
    if (!check("duplicate impression/click ignored", impressions.every((i) => i.dup.alreadyRecorded && i.clickDup.alreadyRecorded)))
      failures.push("idempotency");
    if (
      !check(
        "model spend debited to the ledger",
        Math.abs(spendDelta - expectedSpend) < 1e-9,
        `expected ${money(expectedSpend)}, ledger ${money(spendDelta)}`,
      )
    )
      failures.push("spend debit");
    if (
      !check(
        "the turn ran with no caller-supplied key",
        boot.keys === 0 && orProvider?.configured === true && orProvider?.source === "environment",
        `${boot.keys} key(s) registered by the client; credential source ${orProvider?.source ?? "none"}`,
      )
    )
      failures.push("no byok");
    if (
      !check(
        "balance reconciles (ads − api spend − payouts)",
        Math.abs(after.balanceUsd - (after.adRevenueUsd - after.spendUsd - after.payoutsUsd)) < 1e-9,
        money(after.balanceUsd),
      )
    )
      failures.push("balance identity");

    console.log(
      `\n${failures.length ? `✗ ${failures.length} check(s) failed: ${failures.join(", ")}` : "✓ the ad-funded loop is wired end to end"}`,
    );
    console.log(
      "\nnote: both sides are simulated — the ad network and the model upstream — so no dollar here is money,\n" +
        "and the server reports itself as `mode: simulated` throughout. What is real is the wiring: one\n" +
        "credential Infyield owns, an impression that has to be acknowledged before it is credited, revenue\n" +
        "that has to be confirmed before it can fund anything, and a ledger that debits the provider's own\n" +
        "reported cost.",
    );
  } finally {
    if (modelId) await deleteJson(`/api/admin/models?id=${modelId}`);
    mock.close();
    await adnet.stop();
    await scratchApp.stop();
    console.log(
      `\n▶ cleaned up the probe model and the mock network (ledger entries are left as evidence${target.live ? " — on the live instance you pointed at" : ", inside the scratch data dir that was just deleted"}).`,
    );
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
