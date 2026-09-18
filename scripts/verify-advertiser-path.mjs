#!/usr/bin/env node
/**
 * End-to-end verification of the parts that decide whether this app earns real
 * money and how a turn behaves while it does.
 *
 *   A. advertiser path   impression → booked revenue → invoice → collectible
 *                        → reserve-tier model unlocks (and refused before it)
 *   B. skills            a read-only skill really has no write tool
 *   C. thinking          reasoning effort reaches the upstream, and is withheld
 *                        from models that would reject it
 *   D. attachments       uploaded files arrive at the model as image/text parts
 *   E. run_tests         the workspace's own test/typecheck command is detected
 *   F. funding mode      a house key is gated by the ledger, a personal key is not
 *   G. bypasses          an unknown model id is refused, never quietly swapped
 *   H. settlement        receipts make `paid` a fact; overdue is derived too
 *   I. collection        a real payment link, read back from the provider
 *                        (Stripe mock), idempotent, refusing mismatches
 *
 * Everything goes through the app's real HTTP surface. A real OpenRouter key
 * belongs to the operator's account, so the model-facing checks point a locally
 * registered probe model at a mock OpenAI-compatible upstream that records what
 * it was actually sent.
 *
 * ISOLATION — read this before changing how the target is chosen.
 *
 * This suite is destructive by design: it inflates a campaign's CPM to 1000,
 * serves impressions and clicks, mints a real invoice, changes the payout
 * account, registers probe models, and repoints workspaceRoot. It used
 * to default to http://127.0.0.1:3777 — the port the desktop app serves on — so
 * `node scripts/verify-advertiser-path.mjs` silently ran all of that against
 * whatever app happened to be running there. On an operator's real install it
 * booked ~$6.00 of revenue at the inflated rate, left an invoice behind, and
 * (when the process was interrupted before its `finally`) left the campaign
 * rates and deactivated state in place. The restore block covered the happy
 * path only; a kill, a timeout or a hang left the damage.
 *
 * So the default is now its own instance: a packaged server on its own port with
 * its own scratch data dir, torn down afterwards. There is no path from the
 * default invocation to your real ledger. Pointing it at an existing server is
 * still possible, but it must be asked for explicitly — and it says so out loud,
 * because that is the only way this can touch data you care about.
 *
 * Usage:
 *   node scripts/verify-advertiser-path.mjs                      # own scratch instance
 *   INFYIELD_ALLOW_LIVE=1 INFYIELD_BASE=http://localhost:3778 \
 *     node scripts/verify-advertiser-path.mjs                    # explicit, destructive
 */
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { announceTarget, createScratchApp, freePort, resolveTarget } from "./lib/scratch-app.mjs";
import { startMockAdEnv } from "./lib/fund-scratch.mjs";
import { startMockStripe } from "./lib/mock-stripe.mjs";

// Every port is taken from the OS rather than assumed: a fixed scratch port is
// how this suite once ran its destructive section against whatever happened to
// be listening there (see the note in lib/scratch-app.mjs).
const target = await resolveTarget(3778);
const BASE = target.base;
const MOCK_PORT = Number(process.env.INFYIELD_MOCK_PORT || (await freePort()));
const MOCK_STRIPE_PORT = Number(process.env.INFYIELD_MOCK_STRIPE_PORT || (await freePort()));
/**
 * Point the app at the mock provider BEFORE the scratch server starts, because
 * the child inherits the environment at spawn time. The seam is environment-only
 * on purpose: no request can aim a live install at a fake Stripe.
 */
if (!target.live) process.env.INFYIELD_STRIPE_BASE_URL = `http://127.0.0.1:${MOCK_STRIPE_PORT}`;
const SCRATCH = ".freebuff/verify-scratch";
// The credential is the deployment's, from the environment — there is no
// caller-supplied key in this build. Both provider slots are filled so the
// OpenAI-shaped reasoning probe has a credential of its own, and the base-URL
// seam (environment-only) aims every provider at the suite's mock upstream.
const { adnet, env: adEnv } = await startMockAdEnv({
  OPENROUTER_API_KEY: "mock-infyield-provider-credential",
  OPENAI_API_KEY: "mock-infyield-openai-credential",
  INFYIELD_PROVIDER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
});
const scratchApp = createScratchApp({
  base: BASE,
  port: target.port,
  serverPath: target.serverPath,
  prefix: "infyield-advertiser-",
  env: adEnv,
});

const money = (n) => `$${Number(n ?? 0).toFixed(6)}`;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ------------------------------ mock upstream ----------------------------- */

/** Every request the app made, so assertions can be about what it SENT. */
const seen = [];

function startMockUpstream(port) {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "mock: only /v1/chat/completions" } }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {}
      seen.push({
        url: req.url,
        body: parsed,
        tools: (parsed.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean),
        reasoning: parsed.reasoning,
        reasoningEffort: parsed.reasoning_effort,
        messages: parsed.messages ?? [],
      });

      const toolTurns = (parsed.messages ?? []).filter((m) => m.role === "tool").length;
      // The caller tells the mock what to do next via the last user message, so
      // one upstream can exercise several different agent behaviours.
      const hint = [...(parsed.messages ?? [])].reverse().find((m) => m.role === "user");
      const hintText = typeof hint?.content === "string" ? hint.content : JSON.stringify(hint?.content ?? "");
      const wantTool =
        toolTurns === 0 && /MOCK_TOOL:(\w+)/.test(hintText) ? /MOCK_TOOL:(\w+)/.exec(hintText)[1] : null;
      // Greedy: the arguments object itself contains braces, and a lazy match
      // would hand JSON.parse a truncated string.
      const toolArgs = wantTool && /MOCK_ARGS:(\{[\s\S]*\})/.test(hintText) ? JSON.parse(/MOCK_ARGS:(\{[\s\S]*\})/.exec(hintText)[1]) : { path: "." };

      const id = `chatcmpl-mock-${Date.now()}-${toolTurns}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = { prompt_tokens: 900 + toolTurns * 40, completion_tokens: 30, total_tokens: 930 + toolTurns * 40 };
      const base = { id, object: "chat.completion.chunk", created, model: parsed.model ?? "mock" };
      const calls = wantTool
        ? [{ id: `call_${toolTurns}_${wantTool}`, type: "function", function: { name: wantTool, arguments: JSON.stringify(toolArgs) } }]
        : null;
      const text = calls ? null : "MOCK_OK: the app streamed this answer through the real agent loop.";

      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (calls) {
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: calls.map((c, i) => ({ ...c, index: i })) }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        for (let i = 0; i < text.length; i += 40) {
          send({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 40) }, finish_reason: null }] });
        }
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      send({ ...base, choices: [], usage });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/* ---------------------------------- http --------------------------------- */

async function getJson(p) {
  const res = await fetch(`${BASE}${p}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${p} -> ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function sendJson(p, body, method = "POST") {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: parsed };
}

/** POST /api/chat and collect the SSE events. */
async function runAgentChat(payload) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) return { status: res.status, events: [], error: await res.json().catch(() => ({})) };
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
      const payloadText = raw.slice(5).trim();
      if (payloadText === "[DONE]") continue;
      try {
        events.push(JSON.parse(payloadText));
      } catch {}
    }
  }
  return { status: res.status, events };
}

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
}

/**
 * The final state of a tool call: the agent streams each step twice (running the
 * moment the model asks, then again once it has executed), so a caller that wants
 * the outcome has to take the last event for the call, exactly as the UI does.
 */
function finalToolEvent(turn, name) {
  for (let i = turn.events.length - 1; i >= 0; i--) {
    const e = turn.events[i];
    if (e.type === "tool" && e.event?.name === name) return e.event;
  }
  return null;
}

/** One line summarising what a turn actually produced, for when a check fails. */
function describeTurn(turn) {
  const parts = turn.events.map((e) =>
    e.type === "tool" ? `tool:${e.event?.name}:${e.event?.status}` : e.type === "error" ? `error(${e.message})` : e.type,
  );
  return `${turn.status} · ${parts.join(" → ") || "(no events)"}`;
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  announceTarget("Infyield advertiser-path + agent-behaviour verification", target);

  // Started before the scratch server so the app picks up the base URL at boot.
  const stripe = target.live ? null : await startMockStripe(MOCK_STRIPE_PORT);
  if (stripe) console.log(`  · mock Stripe on 127.0.0.1:${MOCK_STRIPE_PORT} (no real charge can be made)\n`);

  if (!target.live) await scratchApp.start();

  const boot = await getJson("/api/bootstrap").catch(() => null);
  if (!boot) {
    console.error(`Cannot reach ${BASE}. ${target.live ? "Start the instance you pointed at." : "The scratch instance failed to boot."}`);
    await scratchApp.stop();
    process.exit(1);
  }

  const mock = await startMockUpstream(MOCK_PORT);
  const modelIds = [];
  const restore = [];
  // Hoisted so the cleanup `finally` can always see it, whatever block the
  // sections below happen to be scoped in.
  let fixtureDir = null;

  try {
    /* ================= A. the advertiser path ============================ */
    console.log("A. advertiser → invoice → collectible → unlock\n");

    // No key is registered for this: the credential is the deployment's, from
    // the environment, and the reserve gate applies to every priced model because
    // that credential is always the one paying. Section G holds that property.
    //
    // The locked turn is refused before any upstream call is made, so nothing
    // here reaches a provider.
    const modelsBefore = await getJson("/api/models");
    const reserve = modelsBefore.models
      .filter((m) => m.premium && m.requiresBalanceUsd > 0)
      .sort((a, b) => a.requiresBalanceUsd - b.requiresBalanceUsd)[0];
    if (!reserve) throw new Error("no reserve-tier model in the catalog");
    console.log(`  reserve probe: ${reserve.label} needs ${money(reserve.requiresBalanceUsd)} collectible\n`);

    // Refused while nothing is collectible — before any deposit exists.
    const lockedChat = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: reserve.id, messages: [{ id: "a", role: "user", content: "hello" }] }),
    });
    const lockedBody = await lockedChat.json().catch(() => ({}));
    check(
      "locked reserve model refuses with 402 instead of quietly downgrading",
      lockedChat.status === 402,
      `HTTP ${lockedChat.status}`,
    );
    // The refusal has to name the *constraint*, not a page to visit: what is
    // missing is collectible revenue, and the shortfall is the actionable part of
    // the message. (It used to point at the Campaigns screen; the money surface
    // is no longer part of the free-tier experience, so naming it would send
    // somebody to a page they are not meant to need.)
    check(
      "the refusal names what is actually missing, with the shortfall",
      typeof lockedBody.error === "string" &&
        /collectible revenue/i.test(lockedBody.error) &&
        /\$\d/.test(lockedBody.error),
      (lockedBody.error ?? "").slice(0, 110) + "…",
    );

    const campaignsBefore = await getJson("/api/campaigns");
    const target = campaignsBefore.billing.find((b) => !b.backed);
    if (!target) throw new Error("no unbilled campaign to invoice");
    const rawTarget = campaignsBefore.campaigns.find((c) => c.id === target.id);
    console.log(`  target campaign: "${target.title}" — ${money(target.deliveredUsd)} delivered so far`);

    // Serve real impressions at a temporarily high rate so the test can reach a
    // meaningful accrual quickly. The endpoints, ledger, invoicing and gate are
    // all the real ones; only the CPM is inflated for the duration.
    const RATE = 1000; // $1.00 per impression (CPM 1000); clicks stay at $1.00
    restore.push(() => sendJson(`/api/campaigns`, { id: target.id, cpmUsd: rawTarget.cpmUsd, cpcUsd: rawTarget.cpcUsd }, "PATCH"));
    await sendJson("/api/campaigns", { id: target.id, cpmUsd: RATE, cpcUsd: 1, active: true }, "PATCH");

    // Also pause the other campaigns so the served card is always the target.
    const others = campaignsBefore.billing.filter((b) => b.id !== target.id);
    for (const o of others) {
      const raw = campaignsBefore.campaigns.find((c) => c.id === o.id);
      restore.push(() => sendJson("/api/campaigns", { id: o.id, active: raw.active }, "PATCH"));
      await sendJson("/api/campaigns", { id: o.id, active: false }, "PATCH");
    }

    let served = 0;
    let targetNow = null;
    for (let i = 0; i < 12; i++) {
      const serve = await fetch(`${BASE}/api/ads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "postgres database schema migration" }] }),
      }).then((r) => r.json());
      const ad = serve.ads?.[0];
      if (!ad) break;
      served += 1;
      const ack = (url, id) => fetch(`${BASE}${url}`, { method: "POST", headers: { "x-event-id": id } }).then((r) => r.json());
      await ack(ad.impUrl, `imp-${i}`);
      await ack(ad.clickUrl, `clk-${i}`);
      targetNow = (await getJson("/api/campaigns")).billing.find((b) => b.id === target.id);
      if (targetNow.deliveredUsd >= reserve.requiresBalanceUsd * 1.25) break;
    }
    console.log(`  drove ${served} real impression(s) + click(s) through /api/ads → /api/ads/impression|click`);
    console.log(`  accrual now ${money(targetNow?.deliveredUsd)}\n`);

    const earnBefore = await getJson("/api/earn");
    check(
      "booked revenue is NOT collectible while nobody is invoiced",
      earnBefore.collectibleRevenueUsd === 0 && earnBefore.placeholderRevenueUsd > 0,
      `collectible ${money(earnBefore.collectibleRevenueUsd)}, unbilled ${money(earnBefore.placeholderRevenueUsd)}`,
    );
    check(
      "spendable is zero or negative: the ledger cannot pay for anything yet",
      earnBefore.spendableUsd <= 0,
      money(earnBefore.spendableUsd),
    );
    const spendBeforeRefusals = await getJson("/api/economy");
    const reserveBefore = (await getJson("/api/models")).models.find((m) => m.id === reserve.id);
    check("reserve tier reported locked", reserveBefore.unlocked === false, `shortfall ${money(reserveBefore.shortfallUsd)}`);

    // An id the catalog does not carry must be refused, not quietly swapped.
    // The gate used to resolve the request with a static catalog lookup, so an
    // id it did not know — a provider-native `openai/o3-pro` when the catalog id
    // is `o3-pro`, say — made the affordability check falsy and the turn ran on
    // the agent's own MODELS[0] fallback. Either way the caller got a model it
    // did not ask for, and on the OpenAI-compatible surface it would never find
    // out. Both surfaces now refuse. These two calls are cheap: neither reaches
    // an upstream, because the refusal happens before any model is called.
    const unknownAgent = await sendJson("/api/chat", {
      model: "openai/o3-pro",
      messages: [{ id: "u-unknown", role: "user", content: "hello" }],
    });
    check(
      "the agent route refuses a model id the catalog does not carry",
      unknownAgent.status === 400 && /unknown model/i.test(unknownAgent.body?.error ?? ""),
      `${unknownAgent.status} — ${String(unknownAgent.body?.error ?? "").slice(0, 72)}`,
    );

    const unknownCompat = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/o3-pro", messages: [{ role: "user", content: "hello" }] }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    check(
      "the OpenAI-compatible surface refuses it too, in OpenAI's error shape",
      unknownCompat.status === 404 && unknownCompat.body?.error?.code === "model_not_found",
      `${unknownCompat.status} — ${String(unknownCompat.body?.error?.message ?? "").slice(0, 72)}`,
    );

    const spendAfterRefusals = await getJson("/api/economy");
    check(
      "and neither refusal reached a model (no spend was metered)",
      near(spendAfterRefusals.spendUsd, spendBeforeRefusals.spendUsd, 1e-12),
      `api spend ${money(spendAfterRefusals.spendUsd)}`,
    );

    // Invoice it.
    const invoiced = await sendJson(
      "/api/campaigns",
      {
        id: target.id,
        action: "attach-advertiser",
        name: "Verification Advertiser LLC",
        contact: "billing@verification.example",
        terms: "net30",
        status: "issued",
      },
      "PATCH",
    );
    if (!invoiced.ok) throw new Error(`invoicing failed: ${JSON.stringify(invoiced.body)}`);
    const account = invoiced.body.campaign.advertiserAccount;
    console.log(`\n  invoice ${account.invoiceId} issued to ${account.name} for ${money(account.amountUsd)} (${account.terms}, ${account.status})`);
    check(
      "invoice reference is sequential and dated",
      /^INV-\d{4}-\d{4}$/.test(account.invoiceId),
      account.invoiceId,
    );
    check(
      "invoice amount equals what the campaign actually delivered",
      near(account.amountUsd, Math.round(targetNow.deliveredUsd * 100) / 100, 0.005),
      `${money(account.amountUsd)} vs delivered ${money(targetNow.deliveredUsd)}`,
    );

    const earnAfter = await getJson("/api/earn");
    const campaignsAfter = await getJson("/api/campaigns");
    const attribution = campaignsAfter.billing.find((b) => b.id === target.id);

    console.log("");
    check(
      "the campaign's revenue flips from booked to collectible",
      near(earnAfter.collectibleRevenueUsd, attribution.deliveredUsd, 1e-9) && attribution.deliveredUsd > 0,
      `collectible ${money(earnAfter.collectibleRevenueUsd)} == delivered ${money(attribution.deliveredUsd)}`,
    );
    check(
      "the unbilled bucket shrinks by exactly the same amount",
      near(earnAfter.placeholderRevenueUsd, earnBefore.placeholderRevenueUsd - attribution.deliveredUsd, 1e-9),
      `${money(earnBefore.placeholderRevenueUsd)} → ${money(earnAfter.placeholderRevenueUsd)}`,
    );
    check(
      "confirmed (booked) revenue is unchanged — invoicing does not invent money",
      near(earnAfter.confirmedRevenueUsd, earnBefore.confirmedRevenueUsd, 1e-9),
      money(earnAfter.confirmedRevenueUsd),
    );
    check(
      "only the invoiced campaign is treated as collectible",
      campaignsAfter.revenue.backedCampaignIds.length === 1 && campaignsAfter.revenue.backedCampaignIds[0] === target.id,
      `${campaignsAfter.revenue.backedCampaignIds.length} of ${campaignsAfter.billing.length} campaigns`,
    );
    check(
      "collectible revenue survives ledger truncation (all entries summed, not the top 50)",
      earnAfter.collectibleRevenueUsd >= attribution.deliveredUsd - 1e-9,
      `${campaignsAfter.campaigns.reduce((n, c) => n + c.impressions, 0)} impressions booked`,
    );

    const reserveAfter = (await getJson("/api/models")).models.find((m) => m.id === reserve.id);
    check(
      "reserve tier unlocks once collectible revenue clears its threshold",
      reserveAfter.unlocked === true && reserveAfter.shortfallUsd === 0,
      `${reserve.label}: requires ${money(reserve.requiresBalanceUsd)}, collectible ${money(earnAfter.collectibleRevenueUsd)}`,
    );
    check(
      "the unlock is ad-funded revenue, not the caller's own key",
      reserveAfter.gateEnforced === true,
      "gate enforced in ad-funded mode",
    );

    // Moving the invoice to paid must not double-count anything.
    await sendJson("/api/campaigns", { id: target.id, action: "invoice-status", status: "paid" }, "PATCH");
    const earnPaid = await getJson("/api/earn");
    check(
      "marking the invoice paid changes the state, not the arithmetic",
      near(earnPaid.collectibleRevenueUsd, earnAfter.collectibleRevenueUsd, 1e-9),
      money(earnPaid.collectibleRevenueUsd),
    );

    /* ================= B/C/D/E. agent behaviour ========================== */

    // Nothing is registered as a credential: the probes below resolve against the
    // deployment's own, which is what the base-URL seam points at the mock.

    // The workspace checks need a real project — a package.json with a test
    // command, a file to write — but pointing them at THIS checkout made
    // section E detect and run `npm test`, which is the suite chain itself: the
    // suite re-entered itself through the very agent it was verifying, one
    // nested `npm test` per run until the tree was killed by hand. The fixture
    // below is a real project in the temp dir instead — same detection, same
    // execution, no recursion. Restored (and removed) at the end.
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "infyield-fixture-"));
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      `${JSON.stringify({ name: "infyield-verification-fixture", version: "1.0.0", private: true, scripts: { test: "node ./selftest.js" } }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(fixtureDir, "selftest.js"), "console.log('fixture self-test passed');\n");

    const settingsBefore = await getJson("/api/settings");
    restore.push(() => sendJson("/api/settings", { workspaceRoot: settingsBefore.workspaceRoot }, "PATCH"));
    const wsRes = await sendJson("/api/settings", { workspaceRoot: fixtureDir }, "PATCH");
    check(
      "the agent's workspace root can be pointed at a real project",
      wsRes.ok && wsRes.body.workspaceRoot === fixtureDir,
      wsRes.body.workspaceRoot ?? JSON.stringify(wsRes.body).slice(0, 80),
    );

    const addModel = async (label, provider, tags) => {
      const r = await sendJson("/api/admin/models", {
        label,
        provider,
        upstreamModel: "mock-1",
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        priceIn: 1,
        priceOut: 1,
        contextWindow: 128000,
        tags,
      });
      modelIds.push(r.body.model.id);
      return r.body.model.id;
    };

    const plainModel = await addModel("Probe Plain (mock)", "openrouter", []);
    const reasoningModel = await addModel("Probe Reasoning (mock)", "openai", ["reasoning"]);
    console.log(`\n  probe models: ${plainModel} (no reasoning), ${reasoningModel} (reasoning)\n`);

    console.log("B. skills\n");
    const reviewTurn = await runAgentChat({
      model: plainModel,
      skills: ["review"],
      messages: [
        {
          id: "u1",
          role: "user",
          content: `Try to modify a file. MOCK_TOOL:write_file MOCK_ARGS:{"path":"${SCRATCH}/must-not-exist.txt","content":"should never be written"}`,
        },
      ],
    });
    const reviewRequest = seen[seen.length - 1];
    const reviewTools = reviewRequest?.tools ?? [];
    const writeEvent = finalToolEvent(reviewTurn, "write_file");
    if (!writeEvent) console.log(`    turn: ${describeTurn(reviewTurn)}`);
    check(
      "a read-only skill is served only read-only tools",
      reviewTools.length > 0 && !reviewTools.includes("write_file") && !reviewTools.includes("run_command"),
      reviewTools.join(", ") || "(none)",
    );
    check(
      "a write call from the model is refused server-side, not just discouraged",
      !!writeEvent && writeEvent.status === "error" && /not available under the active skill/.test(writeEvent.output ?? ""),
      writeEvent?.output ?? "(no tool event)",
    );
    check("the file was genuinely not created", !fs.existsSync(path.resolve(fixtureDir, SCRATCH, "must-not-exist.txt")));

    const openTurn = await runAgentChat({
      model: plainModel,
      messages: [
        {
          id: "u2",
          role: "user",
          content: `Write the scratch file. MOCK_TOOL:write_file MOCK_ARGS:{"path":"${SCRATCH}/ok.txt","content":"written by the verification run"}`,
        },
      ],
    });
    const openTools = seen[seen.length - 1].tools;
    const openWrite = finalToolEvent(openTurn, "write_file");
    if (!openWrite) console.log(`    turn: ${describeTurn(openTurn)}`);
    check(
      "with no skill selected the full tool set is offered",
      openTools.includes("write_file") && openTools.includes("run_command") && openTools.includes("run_tests"),
      `${openTools.length} tools: ${openTools.join(", ")}`,
    );
    check(
      "and the write actually lands on disk",
      !!openWrite && openWrite.status === "done" && fs.existsSync(path.resolve(fixtureDir, SCRATCH, "ok.txt")),
      openWrite?.output ?? "(no tool event)",
    );

    console.log("\nC. thinking intensity\n");
    await runAgentChat({
      model: reasoningModel,
      thinking: "high",
      messages: [{ id: "u3", role: "user", content: "Say hi." }],
    });
    const highReq = seen[seen.length - 1];
    check(
      "a reasoning model is sent the chosen effort",
      highReq.reasoningEffort === "high",
      `reasoning_effort=${JSON.stringify(highReq.reasoningEffort ?? highReq.reasoning ?? null)} (openai-compatible branch)`,
    );

    await runAgentChat({
      model: reasoningModel,
      thinking: "off",
      messages: [{ id: "u4", role: "user", content: "Say hi." }],
    });
    check(
      "'off' sends no deliberation parameter at all",
      seen[seen.length - 1].reasoningEffort === undefined && seen[seen.length - 1].reasoning === undefined,
      "no reasoning field in the request body",
    );

    await runAgentChat({
      model: plainModel,
      thinking: "high",
      messages: [{ id: "u5", role: "user", content: "Say hi." }],
    });
    const plainReq = seen[seen.length - 1];
    check(
      "a model without reasoning support is never sent one (would be a 400)",
      plainReq.reasoningEffort === undefined && plainReq.reasoning === undefined,
      `${plainModel} has no reasoning tag`,
    );

    console.log("\nD. attachments\n");
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    const form = new FormData();
    form.append("file", new Blob([pngBytes], { type: "image/png" }), "screenshot.png");
    form.append("file", new Blob([Buffer.from("ATTACHED_NOTES: the deploy script lives in scripts/.")], { type: "text/plain" }), "notes.txt");
    const upRes = await fetch(`${BASE}/api/uploads`, { method: "POST", body: form });
    const up = await upRes.json();
    check(
      "upload stores both files and classifies them",
      upRes.ok && up.attachments?.length === 2 && up.attachments.some((a) => a.kind === "image") && up.attachments.some((a) => a.kind === "text"),
      (up.attachments ?? []).map((a) => `${a.name} (${a.kind}, ${a.sizeBytes}B)`).join(", "),
    );

    await runAgentChat({
      model: plainModel,
      messages: [
        {
          id: "u6",
          role: "user",
          content: "Here is the screenshot and my notes.",
          attachments: up.attachments,
        },
      ],
    });
    const attachReq = seen[seen.length - 1];
    const userMsg = [...attachReq.messages].reverse().find((m) => m.role === "user");
    const parts = Array.isArray(userMsg?.content) ? userMsg.content : [];
    const imagePart = parts.find((p) => p.type === "image_url");
    const textPart = parts.find((p) => p.type === "text");
    check(
      "the image arrives as a data-URL image part",
      !!imagePart && /^data:image\/png;base64,/.test(imagePart.image_url?.url ?? ""),
      imagePart ? `${imagePart.image_url.url.slice(0, 32)}… (${imagePart.image_url.url.length} chars)` : "(no image part)",
    );
    check(
      "the text file is inlined into the prompt",
      !!textPart && textPart.text.includes("ATTACHED_NOTES") && textPart.text.includes("notes.txt"),
      textPart ? textPart.text.slice(0, 72).replace(/\n/g, " ") + "…" : "(no text part)",
    );

    const afterAttach = await getJson("/api/economy");
    check(
      "the attached turn was still metered to the ledger",
      afterAttach.spendUsd > 0,
      `api spend ${money(afterAttach.spendUsd)}`,
    );

    console.log("\nE. run_tests\n");
    const testsTurn = await runAgentChat({
      model: plainModel,
      messages: [{ id: "u7", role: "user", content: "Run the tests. MOCK_TOOL:run_tests MOCK_ARGS:{}" }],
    });
    const testsEvent = finalToolEvent(testsTurn, "run_tests");
    const testsOutput = testsEvent?.output ?? "";
    if (!testsEvent) console.log(`    turn: ${describeTurn(testsTurn)}`);
    check(
      "the workspace's own command is detected rather than guessed",
      /detected: .*(typecheck|test)/.test(testsOutput),
      (/detected: [^\n]+/.exec(testsOutput) ?? ["(no detection line)"])[0],
    );
    check(
      "and the tool really ran it, capturing the exit status",
      /exit code|error TS|Found \d+ error|\$ /.test(testsOutput) || testsOutput.includes("tsc"),
      testsOutput.split("\n")[0].slice(0, 80),
    );

    console.log("\nF. payout honesty\n");

    // Only revenue somebody is actually on the hook to pay may leave the account.
    // The ledger primitive caps a payout at BOOKED revenue, and it has to — it
    // cannot import funds.ts without a cycle — so the ceiling that matters is
    // enforced at the route: collectible minus spend minus payouts. Before that
    // existed the payout form defaulted to the booked total, which on a fresh
    // install is seeded placeholder inventory, so it would cheerfully record
    // paying out money no advertiser had ever been billed for.
    // Snapshot the money fields HERE, not from the section-A read: sections B–E
    // each run real agent turns, and those meter real spend. Comparing against
    // the earlier figure is comparing against a number that has legitimately
    // moved on. This suite asserted exactly that once and reported the app as
    // broken when the harness was.
    const payoutsBefore = await getJson("/api/payouts");
    const earnNow = await getJson("/api/earn");
    const payable = payoutsBefore.payableUsd;
    const booked = payoutsBefore.adRevenueUsd;
    const paidBefore = payoutsBefore.payoutsUsd ?? 0;
    const spendableNow = earnNow.spendableUsd;
    const placeholderNow = payoutsBefore.placeholderUsd;

    check(
      "the payable ceiling is the same figure the reserve tier spends against",
      payable >= 0 && near(payable, Math.max(0, spendableNow), 1e-9),
      `payable ${money(payable)} vs spendable ${money(spendableNow)}`,
    );
    check(
      "the ledger's booked total is reported separately from what is collectible",
      near(payoutsBefore.collectibleUsd + placeholderNow, booked, 1e-9) && payoutsBefore.collectibleUsd > 0,
      `booked ${money(booked)} = collectible ${money(payoutsBefore.collectibleUsd)} + placeholder ${money(placeholderNow)}`,
    );
    check(
      "spend reduces what may be paid out, so payable trails booked revenue",
      payable < booked && near(booked - payable, earnNow.spendUsd + paidBefore, 1e-6),
      `booked ${money(booked)} − payable ${money(payable)} == spend ${money(earnNow.spendUsd)} + payouts ${money(paidBefore)}`,
    );

    const overdraw = await sendJson("/api/payouts", { action: "payout", amount: booked, note: "verification overdraw" });
    check(
      "paying out the whole booked total is refused",
      overdraw.status === 400 && /payable/i.test(overdraw.body?.error ?? ""),
      `${overdraw.status} — ${(overdraw.body?.error ?? "").slice(0, 96)}…`,
    );
    check(
      "and the refusal explains the placeholder split when there is one",
      // Every campaign is invoiced at this point, so there may be nothing
      // placeholder left to name — the sentence is required only when it applies.
      placeholderNow <= 0.0001 || /placeholder/i.test(overdraw.body?.error ?? ""),
      placeholderNow > 0.0001 ? "placeholder revenue present and named" : "nothing placeholder left to name (all invoiced)",
    );
    const afterRefusal = await getJson("/api/payouts");
    check(
      "a refused payout leaves the ledger untouched",
      near(afterRefusal.payoutsUsd ?? 0, paidBefore, 1e-9),
      `payouts ${money(afterRefusal.payoutsUsd ?? 0)}`,
    );

    if (payable > 1e-6) {
      const draw = Math.min(0.0005, payable);
      const drawn = await sendJson("/api/payouts", { action: "payout", amount: draw, note: "verification draw" });
      const afterDraw = await getJson("/api/payouts");
      const earnAfterDraw = await getJson("/api/earn");
      check(
        "a payout within the collectible ceiling is recorded",
        drawn.status === 200 && near((afterDraw.payoutsUsd ?? 0) - paidBefore, draw, 1e-9),
        `payouts ${money(paidBefore)} → ${money(afterDraw.payoutsUsd ?? 0)}`,
      );
      check(
        "and it reduces what the reserve tier may spend, by exactly that amount",
        near(earnAfterDraw.spendableUsd, spendableNow - draw, 1e-9),
        `spendable ${money(spendableNow)} → ${money(earnAfterDraw.spendableUsd)}`,
      );
    } else {
      check(
        "a payout within the collectible ceiling is recorded",
        false,
        "nothing collectible to draw — the invoicing checks above should have made revenue collectible",
      );
    }

    /* ============ G. whose bill is it — house key vs your own ============ */
    //
    // This section used to test a `house` vs `personal` key distinction: whether
    // the bill belonged to the operator (so the ad ledger should gate it) or to
    // the user who connected their own key (so it should not). That distinction
    // belonged to the BYOK model, and it is gone — there is no caller-supplied
    // credential any more, so there is no second billing mode for the gate to
    // step aside for. What replaces it is the property that matters, and it is
    // stronger: the credential is always the deployment's, the gate always
    // applies, and nothing a caller can send changes who pays.
    console.log("\nG. who pays — the deployment's credential, and only it\n");

    const boot = await getJson("/api/bootstrap");
    const orProvider = (boot.providers ?? []).find((p) => p.provider === "openrouter");
    check(
      "the credential in force came from the environment, not from a request",
      orProvider?.configured === true && orProvider?.source === "environment",
      `configured=${orProvider?.configured} source=${orProvider?.source ?? "none"}`,
    );
    check(
      "and the bootstrap reports no caller-supplied keys at all",
      boot.keys === 0,
      `keys=${boot.keys}`,
    );

    const earnG = await getJson("/api/earn");
    check(
      "the account is reported as ad-funded, because the deployment holds the credential",
      earnG.adFunded === true,
      `adFunded=${earnG.adFunded}`,
    );

    // This section used to prove the legacy key surface was *inert*: a key added
    // there must not become the payer, must not flip the account to "yours", and
    // must not release the reserve gate — all of which it used to do. That surface
    // is deleted (`src/lib/keypool.ts`, `/api/keys`), because nothing had read a
    // pooled key since the credential layer took over, and a route that stores
    // provider secrets for no functional gain is a liability rather than a
    // feature. So the claim is now the stronger, simpler one: there is no
    // request-carried credential path left at all. Both halves are asserted — the
    // route is gone, and the credential in force is unchanged.
    const strayProbe = await fetch(`${BASE}/api/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        label: "Verification stray key (must not be accepted)",
        key: "sk-or-v1-verification-stray-not-real",
      }),
    });
    check(
      "the legacy key surface is gone — no request can add a credential",
      strayProbe.status === 404 || strayProbe.status === 405,
      `POST /api/keys → ${strayProbe.status}`,
    );

    const afterStray = await getJson("/api/earn");
    check(
      "the account is still funded by the deployment's own credential",
      afterStray.adFunded === true,
      `adFunded=${afterStray.adFunded}`,
    );
    const reserveRows = (afterStray.premium ?? []).filter((m) => m.requiredUsd > 0);
    check(
      "and the reserve gate still holds on earned revenue alone",
      reserveRows.length > 0 && reserveRows.some((m) => m.unlocked === false),
      `${reserveRows.filter((m) => m.unlocked).length}/${reserveRows.length} unlocked`,
    );

    const afterRemoval = await getJson("/api/bootstrap");
    const orAfter = (afterRemoval.providers ?? []).find((p) => p.provider === "openrouter");
    check(
      "and that credential is untouched: still the environment's, still configured",
      orAfter?.configured === true && orAfter?.source === "environment",
      `configured=${orAfter?.configured} source=${orAfter?.source ?? "none"}`,
    );

    /* ==================== H. settling an invoice ======================= */
    //
    // "Paid" has to mean money arrived. These checks hold the invoice to its
    // receipts: settlement is derived from the payments, an overpayment is
    // refused, removing a receipt walks the balance back up, and a term that has
    // run out is reported as overdue.
    console.log("\nH. settlement — payments, receipts, overdue\n");

    // Re-issue the invoice first: section A marked it paid, and marking paid now
    // settles it with a placeholder receipt. This gets a clean account with the
    // full balance outstanding, so the assertions below start from zero.
    const reissued = await sendJson(
      "/api/campaigns",
      { id: target.id, action: "attach-advertiser", name: "Verification Advertiser LLC", terms: "net30", status: "issued" },
      "PATCH",
    );
    const fresh = reissued.body.campaign?.advertiserAccount;
    if (!fresh) throw new Error(`re-invoicing failed: ${JSON.stringify(reissued.body)}`);
    console.log(`  invoice ${fresh.invoiceId} re-issued for ${money(fresh.amountUsd)}, nothing received yet\n`);

    const total = fresh.amountUsd;
    const firstHalf = Math.round((total / 2) * 1e6) / 1e6;
    const revBefore = await getJson("/api/campaigns");
    const bookedBefore = revBefore.revenue.confirmedUsd;

    const partial = await sendJson(
      "/api/campaigns",
      { id: target.id, action: "record-payment", amountUsd: firstHalf, method: "ACH", reference: "TEST-0001" },
      "PATCH",
    );
    const partialRow = partial.body.billing?.find((b) => b.id === target.id);
    check(
      "a partial payment leaves the invoice partly settled, not paid",
      partialRow?.settlement?.state === "partial" && near(partialRow.settlement.balanceUsd, total - firstHalf, 1e-6),
      `state=${partialRow?.settlement?.state} balance ${money(partialRow?.settlement?.balanceUsd ?? 0)} of ${money(total)}`,
    );
    check(
      "the payment is recorded as a receipt with its method and reference",
      (partial.body.campaign?.advertiserAccount?.payments ?? []).some((p) => p.method === "ACH" && p.reference === "TEST-0001"),
      `${(partial.body.campaign?.advertiserAccount?.payments ?? []).length} receipt(s)`,
    );
    check(
      "recording a payment does not move the ledger — the revenue was booked when the ads ran",
      near((await getJson("/api/campaigns")).revenue.confirmedUsd, bookedBefore, 1e-9),
      `booked ${money(bookedBefore)} → ${money((await getJson("/api/campaigns")).revenue.confirmedUsd)}`,
    );

    const overpay = await sendJson(
      "/api/campaigns",
      { id: target.id, action: "record-payment", amountUsd: total * 2 },
      "PATCH",
    );
    check(
      "a payment larger than the outstanding balance is refused",
      overpay.status === 400 && /outstanding/i.test(overpay.body?.error ?? ""),
      `${overpay.status} — ${(overpay.body?.error ?? "").slice(0, 88)}…`,
    );

    const settled = await sendJson(
      "/api/campaigns",
      { id: target.id, action: "record-payment", amountUsd: total - firstHalf, method: "wire" },
      "PATCH",
    );
    const settledRow = settled.body.billing?.find((b) => b.id === target.id);
    const settledAccount = settled.body.campaign?.advertiserAccount;
    check(
      "paying the remainder settles the invoice in full",
      settledRow?.settlement?.state === "paid" && near(settledRow.settlement.balanceUsd, 0, 1e-9),
      `state=${settledRow?.settlement?.state} balance ${money(settledRow?.settlement?.balanceUsd ?? 0)}`,
    );
    check(
      "and `paid` follows the payments rather than being asserted",
      settledAccount?.status === "paid" && !settledRow?.settlement?.unbacked && (settledAccount?.payments ?? []).length === 2,
      `status=${settledAccount?.status} unbacked=${settledRow?.settlement?.unbacked} receipts=${(settledAccount?.payments ?? []).length}`,
    );
    check(
      "a receipt with real detail counts as verified, not as an assertion",
      settledRow?.settlement?.verifiedPayments === 2,
      `verified=${settledRow?.settlement?.verifiedPayments}`,
    );

    const firstReceipt = settledAccount.payments[0];
    const unrecorded = await sendJson(
      "/api/campaigns",
      { id: target.id, action: "remove-payment", paymentId: firstReceipt.id },
      "PATCH",
    );
    const unrecRow = unrecorded.body.billing?.find((b) => b.id === target.id);
    check(
      "removing a receipt walks the balance back up and drops the paid state",
      unrecRow?.settlement?.state === "partial" && unrecRow.settlement.balanceUsd > 0 && unrecorded.body.campaign?.advertiserAccount?.status !== "paid",
      `state=${unrecRow?.settlement?.state} balance ${money(unrecRow?.settlement?.balanceUsd ?? 0)} status=${unrecorded.body.campaign?.advertiserAccount?.status}`,
    );

    // Overdue: issue it 45 days ago on net30, so the term ran out 15 days back.
    // Re-invoicing replaces the account, which also clears the receipts above.
    const issuedAgo = Date.now() - 45 * 86_400_000;
    const late = await sendJson(
      "/api/campaigns",
      { id: target.id, action: "attach-advertiser", name: "Verification Advertiser LLC", terms: "net30", status: "issued", issuedAt: issuedAgo },
      "PATCH",
    );
    const lateRow = late.body.billing?.find((b) => b.id === target.id);
    check(
      "an invoice past its terms is reported as overdue, by how many days",
      lateRow?.settlement?.state === "overdue" && lateRow.settlement.daysOverdue === 15,
      `issued ${new Date(lateRow?.settlement?.dueAt ?? 0).toISOString().slice(0, 10)} was due — ${lateRow?.settlement?.daysOverdue} day(s) late, ${money(lateRow?.settlement?.balanceUsd ?? 0)} outstanding`,
    );
    const freshRow = (
      await sendJson(
        "/api/campaigns",
        { id: target.id, action: "attach-advertiser", name: "Verification Advertiser LLC", terms: "net30", status: "issued" },
        "PATCH",
      )
    ).body.billing?.find((b) => b.id === target.id);
    check(
      "an invoice still inside its terms is not called late",
      freshRow?.settlement?.state === "unpaid",
      `freshly issued net30 → ${freshRow?.settlement?.state}`,
    );

    const postdated = await sendJson(
      "/api/campaigns",
      { id: target.id, action: "attach-advertiser", name: "Verification Advertiser LLC", terms: "net30", status: "issued", issuedAt: Date.now() + 30 * 86_400_000 },
      "PATCH",
    );
    const postdatedAt = postdated.body.campaign?.advertiserAccount?.issuedAt ?? 0;
    check(
      "a due date cannot be pushed into the future",
      postdatedAt <= Date.now() && postdated.body.billing?.find((b) => b.id === target.id)?.settlement?.state === "unpaid",
      `asked for +30d, recorded ${new Date(postdatedAt).toISOString().slice(0, 10)}`,
    );

    // Put the late invoice back so the receivables checks below see it.
    await sendJson(
      "/api/campaigns",
      { id: target.id, action: "attach-advertiser", name: "Verification Advertiser LLC", terms: "net30", status: "issued", issuedAt: issuedAgo },
      "PATCH",
    );

    const receivables = (await getJson("/api/campaigns")).receivables;
    check(
      "invoiced = collected + outstanding, so the summary cannot drift",
      near(receivables.invoicedUsd, receivables.collectedUsd + receivables.outstandingUsd, 1e-6),
      `${money(receivables.invoicedUsd)} = ${money(receivables.collectedUsd)} + ${money(receivables.outstandingUsd)}`,
    );
    check(
      "and the overdue figure is the late part of what is outstanding",
      receivables.overdueUsd > 0 && receivables.overdueCount >= 1 && receivables.overdueUsd <= receivables.outstandingUsd + 1e-9,
      `overdue ${money(receivables.overdueUsd)} of ${money(receivables.outstandingUsd)} across ${receivables.overdueCount} invoice(s)`,
    );

    // Marking paid without detail must not read as a verified receipt. Runs last
    // because it settles the invoice and would zero the overdue figures above.
    await sendJson(
      "/api/campaigns",
      { id: target.id, action: "attach-advertiser", name: "Verification Advertiser LLC", terms: "net30", status: "issued" },
      "PATCH",
    );
    const asserted = await sendJson("/api/campaigns", { id: target.id, action: "invoice-status", status: "paid" }, "PATCH");
    const assertedRow = asserted.body.billing?.find((b) => b.id === target.id);
    check(
      "marking paid with no detail settles the balance but stays flagged as unverified",
      assertedRow?.settlement?.state === "paid" && assertedRow.settlement.unbacked === true && assertedRow.settlement.verifiedPayments === 0,
      `state=${assertedRow?.settlement?.state} unbacked=${assertedRow?.settlement?.unbacked} verified=${assertedRow?.settlement?.verifiedPayments}`,
    );
    check(
      "and that settlement is still visible as a receipt, labelled as an assertion",
      (asserted.body.campaign?.advertiserAccount?.payments ?? []).some((p) => p.method === "marked paid"),
      `${(asserted.body.campaign?.advertiserAccount?.payments ?? []).length} receipt(s)`,
    );
    /* ==================== I. getting paid ============================== */
    //
    // Everything before this is bookkeeping. This is the only path in the app
    // that can actually move money: it raises a provider-hosted payment page and
    // reads the transaction back, so the receipt is not typed in by hand. It runs
    // against an in-process Stripe mock — a real account cannot be part of a
    // suite, and must not be — but through the real code, real HTTP and the real
    // settings, including the environment seam that points the client at a mock.
    console.log("\nI. collection — payment links and read-back reconciliation\n");
    // Only a scratch instance is wired to the mock (INFYIELD_STRIPE_BASE_URL is
    // set for it at boot), and a live run must never be pointed at a fake
    // provider — so this section has nothing safe to talk to there.
    if (!target.live) {


    // A campaign of its own: section H left its invoice settled, so this one
    // needs to start from zero rather than inherit a balance.
    const collectCampaign = (
      await sendJson("/api/campaigns", {
        title: "Verification collection campaign",
        adText: "An invoice collected end to end.",
        url: "https://example.com/collect",
        keywords: "collection verification billing",
        cpmUsd: 1000,
        cpcUsd: 0,
        active: true,
      })
    ).body.campaign;
    if (!collectCampaign) throw new Error("could not create the collection campaign");
    restore.push(async () => {
      await fetch(`${BASE}/api/campaigns?id=${collectCampaign.id}`, { method: "DELETE" });
    });

    // Serving is round-robin: pause anything else so the impressions are its.
    const pauseOthers = async (keepId) => {
      for (const c of (await getJson("/api/campaigns")).campaigns) {
        if (c.id === keepId || !c.active) continue;
        restore.push(() => sendJson("/api/campaigns", { id: c.id, active: true }, "PATCH"));
        await sendJson("/api/campaigns", { id: c.id, active: false }, "PATCH");
      }
    };
    const driveImpressions = async (campaignId, target, tag) => {
      let delivered = 0;
      for (let i = 0; i < 16 && delivered < target; i++) {
        const serve = await fetch(`${BASE}/api/ads`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: `${tag} billing invoice` }] }),
        }).then((r) => r.json());
        const ad = serve.ads?.[0];
        if (!ad) break;
        await fetch(`${BASE}${ad.impUrl}`, { method: "POST", headers: { "x-event-id": `imp-${tag}-${i}` } });
        delivered = (await getJson("/api/campaigns")).billing.find((b) => b.id === campaignId)?.deliveredUsd ?? 0;
      }
      return delivered;
    };

    await pauseOthers(collectCampaign.id);
    const collectDelivered = await driveImpressions(collectCampaign.id, 8, "collect");
    check("a fresh campaign accrued something worth invoicing", collectDelivered > 0, money(collectDelivered));

    const collectAccount = (
      await sendJson(
        "/api/campaigns",
        {
          id: collectCampaign.id,
          action: "attach-advertiser",
          name: "Collection Advertiser LLC",
          contact: "ap@collection.example",
          terms: "net30",
          status: "issued",
        },
        "PATCH",
      )
    ).body.campaign?.advertiserAccount;
    const COLLECT_INVOICE = collectAccount?.invoiceId ?? "";
    console.log(`  ${COLLECT_INVOICE} for ${money(collectAccount?.amountUsd ?? 0)} — Collection Advertiser LLC\n`);

    // ---- nothing wired up: refuse, and name what is missing ----
    const noProvider = await sendJson("/api/payments", { action: "pay-link", campaignId: collectCampaign.id });
    check(
      "with no provider configured, raising a link is refused and names the gap",
      noProvider.status === 400 && /no payment provider/i.test(noProvider.body.error ?? ""),
      noProvider.body.error ?? `HTTP ${noProvider.status}`,
    );
    const noSync = await sendJson("/api/payments", { action: "sync" });
    check(
      "and a sync refuses rather than reporting an empty success",
      noSync.status === 400 && /no payment provider/i.test(noSync.body.error ?? ""),
      noSync.body.error ?? `HTTP ${noSync.status}`,
    );

    // ---- a static payment link: works, but cannot be read back ----
    check(
      "a payment link that is not https is refused",
      (await sendJson("/api/payments", { provider: "link", linkUrl: "http://pay.example.com/me" }, "PATCH")).status === 400,
      "http:// rejected before it can be sent to an advertiser",
    );
    await sendJson("/api/payments", { provider: "link", linkUrl: "https://pay.example.com/infyield" }, "PATCH");
    const staticLink = await sendJson("/api/payments", { action: "pay-link", campaignId: collectCampaign.id });
    check(
      "a static link is handed over for the outstanding balance",
      staticLink.status === 200 && staticLink.body.link?.provider === "link" && staticLink.body.link.url === "https://pay.example.com/infyield",
      `${staticLink.body.link?.url ?? staticLink.body.error} for ${money(staticLink.body.link?.amountUsd ?? 0)}`,
    );
    const staticSync = await sendJson("/api/payments", { action: "sync" });
    check(
      "and it is honest that a static link cannot be checked, instead of pretending",
      staticSync.status === 200 && /cannot be checked/i.test(staticSync.body.message ?? ""),
      staticSync.body.message ?? "",
    );

    // ---- wire up Stripe ----
    const configured = await sendJson(
      "/api/payments",
      {
        provider: "stripe",
        linkUrl: "",
        stripeSecretKey: "rk_test_mockkey_notarealkey",
        successUrl: "https://example.com/paid",
        cancelUrl: "https://example.com/cancelled",
      },
      "PATCH",
    );
    check(
      "a restricted test key is accepted and reported as restricted",
      configured.status === 200 && configured.body.payments?.keyMode === "restricted" && configured.body.payments?.hasStripeKey === true,
      `provider=${configured.body.payments?.provider} keyMode=${configured.body.payments?.keyMode}`,
    );
    check(
      "scratch servers keep the key in the file store, never the user's Keychain",
      configured.body.payments?.storage === "file",
      `storage=${configured.body.payments?.storage} (INFYIELD_IN_VERIFICATION gates the Keychain off)`,
    );
    check(
      "the stored secret never leaves the server on the payments endpoint",
      !JSON.stringify(configured.body).includes("mockkey_notarealkey"),
      "PATCH /api/payments response carries no key material",
    );
    const settingsLeak = await getJson("/api/settings");
    check(
      "nor through the generic settings endpoint",
      !JSON.stringify(settingsLeak).includes("mockkey_notarealkey") && settingsLeak.payments?.hasStripeKey === true,
      "GET /api/settings reports hasStripeKey, never the key",
    );
    check(
      "a publishable key is rejected by name rather than stored",
      (await sendJson("/api/payments", { stripeSecretKey: "pk_test_oops" }, "PATCH")).status === 400,
      "pk_… refused with an explanation instead of a confusing 401 later",
    );
    // The rejected patches above must not have disturbed the working setup.
    const tested = await sendJson("/api/payments", { action: "test" });
    check(
      "the credential test reads the account and reports test mode",
      tested.status === 200 && tested.body.ok === true && /test mode/i.test(tested.body.message ?? ""),
      tested.body.message ?? tested.body.error ?? "",
    );
    //
    // And prove the request landed on the MOCK, right after the first call that
    // could reach a provider. Without this, an app that never received
    // INFYIELD_STRIPE_BASE_URL talks to the real api.stripe.com with a fake key
    // and reports a 401 — which reads like a credentials bug in the app when it
    // is a wiring bug in the harness. (It was, once: the suite ran against a
    // desktop instance that happened to hold the scratch port, and every
    // provider call in that run went to Stripe for real.)
    check(
      "the app is talking to the mock provider, not to Stripe for real",
      stripe.log.length > 0,
      stripe.log.length > 0
        ? `${stripe.log.length} request(s) reached the mock on 127.0.0.1:${MOCK_STRIPE_PORT}`
        : `nothing reached 127.0.0.1:${MOCK_STRIPE_PORT} — the app never got INFYIELD_STRIPE_BASE_URL, so that 401 came from the real Stripe`,
    );

    // ---- raise the link ----
    const linkRes = await sendJson("/api/payments", { action: "pay-link", campaignId: collectCampaign.id });
    const payLink = linkRes.body.link;
    check(
      "a Stripe link is raised for exactly the outstanding balance",
      linkRes.status === 200 &&
        payLink?.provider === "stripe" &&
        payLink.url.startsWith("https://") &&
        near(payLink.amountUsd, collectAccount.amountUsd, 1e-9),
      `${payLink?.url ?? "no url"} for ${money(payLink?.amountUsd ?? 0)}`,
    );
    const sessionCreate = stripe.log.filter((e) => e.path === "/v1/checkout/sessions" && e.method === "POST").pop();
    check(
      "the session carries the invoice reference reconciliation matches on",
      sessionCreate?.params["metadata[infyield_invoice]"] === COLLECT_INVOICE &&
        sessionCreate.params["metadata[infyield_campaign]"] === collectCampaign.id &&
        sessionCreate.params.client_reference_id === COLLECT_INVOICE,
      `metadata[infyield_invoice]=${sessionCreate?.params["metadata[infyield_invoice]"] ?? "missing"}`,
    );
    check(
      "and it is raised for the balance in cents, in the invoice's currency",
      Number(sessionCreate?.params["line_items[0][price_data][unit_amount]"]) === Math.round(collectAccount.amountUsd * 100) &&
        sessionCreate?.params["line_items[0][price_data][currency]"] === "usd",
      `${sessionCreate?.params["line_items[0][price_data][unit_amount]"]} cents ${sessionCreate?.params["line_items[0][price_data][currency]"]}`,
    );
    const emailRes = await sendJson("/api/payments", { action: "invoice-message", campaignId: collectCampaign.id });
    check(
      "the message an advertiser receives carries the invoice id and the link",
      emailRes.body.text?.includes(payLink.url) && emailRes.body.text?.includes(COLLECT_INVOICE),
      "pasteable, so the ask for money is one step from the ledger that earned it",
    );
    const sessionId = payLink.externalId;
    check(
      "the link keeps the provider session id, which is what makes syncing safe",
      Boolean(sessionId),
      sessionId ?? "missing — nothing to reconcile against",
    );

    // ---- not paid yet ----
    const beforePay = await sendJson("/api/payments", { action: "sync" });
    check(
      "an unpaid session reconciles to nothing",
      beforePay.body.recorded?.length === 0 && beforePay.body.checked === 0,
      beforePay.body.message ?? "",
    );
    const ledgerBefore = await getJson("/api/economy");

    // ---- the advertiser pays ----
    const paySession = (id, extra = {}) =>
      fetch(`http://127.0.0.1:${MOCK_STRIPE_PORT}/_mock/pay`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id, ...extra }).toString(),
      });

    await paySession(sessionId);
    const synced = await sendJson("/api/payments", { action: "sync" });
    const syncedRow = (await getJson("/api/campaigns")).billing.find((b) => b.id === collectCampaign.id);
    check(
      "a paid session is read back and recorded against the right invoice",
      synced.body.recorded?.length === 1 &&
        synced.body.recorded[0].invoiceId === COLLECT_INVOICE &&
        near(synced.body.recorded[0].amountUsd, collectAccount.amountUsd, 1e-9),
      synced.body.recorded?.[0]
        ? `${money(synced.body.recorded[0].amountUsd)} against ${synced.body.recorded[0].invoiceId}`
        : (synced.body.message ?? synced.body.error ?? ""),
    );
    check(
      "and the invoice settles itself — `paid` follows the money, not an assertion",
      syncedRow?.settlement?.state === "paid" && syncedRow.settlement.unbacked === false && syncedRow.settlement.verifiedPayments === 1,
      `state=${syncedRow?.settlement?.state} unbacked=${syncedRow?.settlement?.unbacked} verified=${syncedRow?.settlement?.verifiedPayments}`,
    );
    const collectReceipt = (await getJson("/api/campaigns")).campaigns.find((c) => c.id === collectCampaign.id)?.advertiserAccount?.payments?.[0];
    check(
      "the receipt is marked as read back from the provider, not typed in",
      collectReceipt?.source === "stripe" && collectReceipt.externalId === sessionId,
      `source=${collectReceipt?.source} externalId=${collectReceipt?.externalId ?? "missing"}`,
    );
    const ledgerAfter = await getJson("/api/economy");
    check(
      "collecting an invoice does not move the ledger — the revenue was booked when the ads ran",
      near(ledgerAfter.availableUsd, ledgerBefore.availableUsd, 1e-9) &&
        (ledgerAfter.entries ?? []).length === (ledgerBefore.entries ?? []).length,
      `available ${money(ledgerBefore.availableUsd)} → ${money(ledgerAfter.availableUsd)}, ${ledgerAfter.entries?.length ?? 0} entries`,
    );

    // ---- polling sees the same transaction every time ----
    const resync = await sendJson("/api/payments", { action: "sync" });
    check(
      "syncing again records nothing: the same transaction cannot be booked twice",
      resync.body.recorded?.length === 0 && resync.body.skipped?.length === 1 && /already recorded/.test(resync.body.skipped[0].reason ?? ""),
      resync.body.skipped?.[0]?.reason ?? resync.body.message ?? "",
    );
    const afterResync = (await getJson("/api/campaigns")).billing.find((b) => b.id === collectCampaign.id);
    check(
      "and the balance stays settled at exactly one receipt",
      near(afterResync?.settlement?.balanceUsd ?? -1, 0, 1e-9) && afterResync?.settlement?.verifiedPayments === 1,
      `balance ${money(afterResync?.settlement?.balanceUsd ?? 0)}, ${afterResync?.settlement?.verifiedPayments} receipt(s)`,
    );

    // ---- a second invoice, to attack the reconciliation rules with ----
    const secondCampaign = (
      await sendJson("/api/campaigns", {
        title: "Verification mismatch campaign",
        adText: "A second invoice, to be mismatched on purpose.",
        url: "https://example.com/mismatch",
        keywords: "mismatch verification",
        cpmUsd: 1000,
        cpcUsd: 0,
        active: true,
      })
    ).body.campaign;
    restore.push(async () => {
      await fetch(`${BASE}/api/campaigns?id=${secondCampaign.id}`, { method: "DELETE" });
    });
    await pauseOthers(secondCampaign.id);
    await driveImpressions(secondCampaign.id, 2, "mismatch");
    const secondAccount = (
      await sendJson("/api/campaigns", { id: secondCampaign.id, action: "attach-advertiser", name: "Mismatch Advertiser LLC", terms: "net30", status: "issued" }, "PATCH")
    ).body.campaign?.advertiserAccount;
    const SECOND_INVOICE = secondAccount?.invoiceId ?? "";
    const secondLink = (await sendJson("/api/payments", { action: "pay-link", campaignId: secondCampaign.id })).body.link;
    const exactCents = String(Math.round(secondAccount.amountUsd * 100));

    // Overpaid: more arrived than is owed. Refusing to record it is the whole
    // point — recording it would make the receipt trail claim money that does
    // not correspond to anything billed.
    await paySession(secondLink.externalId, { amountCents: "10000" });
    const overpaid = await sendJson("/api/payments", { action: "sync" });
    const overRow = (await getJson("/api/campaigns")).billing.find((b) => b.id === secondCampaign.id);
    check(
      "an amount larger than the balance is surfaced as needing attention, not recorded",
      overpaid.body.recorded?.length === 0 &&
        overpaid.body.needsAttention?.length === 1 &&
        /overpaid|duplicated|wrong invoice/i.test(overpaid.body.needsAttention[0].reason ?? ""),
      overpaid.body.needsAttention?.[0]?.reason ?? overpaid.body.message ?? "",
    );
    check(
      "so the invoice is left exactly as it was",
      overRow?.settlement?.state === "unpaid" && near(overRow.settlement.balanceUsd, secondAccount.amountUsd, 1e-9),
      `state=${overRow?.settlement?.state} balance ${money(overRow?.settlement?.balanceUsd ?? 0)}`,
    );

    // Wrong currency for the right amount: the app will not invent a rate.
    await paySession(secondLink.externalId, { amountCents: exactCents, currency: "eur" });
    const wrongCcy = await sendJson("/api/payments", { action: "sync" });
    check(
      "a payment in another currency is flagged, not converted at a invented rate",
      wrongCcy.body.recorded?.length === 0 && /EUR/i.test(wrongCcy.body.needsAttention?.[0]?.reason ?? ""),
      wrongCcy.body.needsAttention?.[0]?.reason ?? wrongCcy.body.message ?? "",
    );

    // Right amount, right currency, but no invoice reference at all.
    await paySession(secondLink.externalId, { amountCents: exactCents, currency: "usd", clearInvoice: "1" });
    const orphan = await sendJson("/api/payments", { action: "sync" });
    check(
      "a payment carrying no invoice reference is reported rather than guessed at",
      orphan.body.recorded?.length === 0 && /no invoice reference/i.test(orphan.body.needsAttention?.[0]?.reason ?? ""),
      orphan.body.needsAttention?.[0]?.reason ?? orphan.body.message ?? "",
    );

    // Put the reference back: the same transaction must now go through, which
    // proves the flags above were the reason it was held, not a broken path.
    await paySession(secondLink.externalId, { amountCents: exactCents, currency: "usd", invoice: SECOND_INVOICE });
    const fixed = await sendJson("/api/payments", { action: "sync" });
    check(
      "correcting the reference lets the same transaction through",
      fixed.body.recorded?.length === 1 && near(fixed.body.recorded[0].amountUsd, secondAccount.amountUsd, 1e-9),
      fixed.body.recorded?.[0] ? `${money(fixed.body.recorded[0].amountUsd)} recorded` : (fixed.body.message ?? ""),
    );

    // ---- removing a provider receipt ----
    const secondReceipt = (await getJson("/api/campaigns")).campaigns
      .find((c) => c.id === secondCampaign.id)
      ?.advertiserAccount?.payments?.find((p) => p.externalId === secondLink.externalId);
    const removed = await sendJson("/api/campaigns", { id: secondCampaign.id, action: "remove-payment", paymentId: secondReceipt?.id }, "PATCH");
    const removedRow = removed.body.billing?.find((b) => b.id === secondCampaign.id);
    check(
      "removing a provider receipt walks the balance back up",
      removedRow?.settlement?.state !== "paid" && near(removedRow?.settlement?.balanceUsd ?? -1, secondAccount.amountUsd, 1e-9),
      `state=${removedRow?.settlement?.state} balance ${money(removedRow?.settlement?.balanceUsd ?? 0)}`,
    );
    const readded = await sendJson("/api/payments", { action: "sync" });
    check(
      "and the next sync re-records it, because the receipt is the idempotency key",
      readded.body.recorded?.length === 1,
      readded.body.recorded?.length ? "the deleted receipt freed the transaction, as it should" : (readded.body.message ?? ""),
    );
    } else {
      console.log("  · skipped: a live run is not pointed at the mock provider\n");
    }
  } finally {
    for (const undo of restore.reverse()) await undo().catch(() => {});
    if (stripe) await stripe.close().catch(() => {});
    await adnet.stop();
    for (const id of modelIds) await fetch(`${BASE}/api/admin/models?id=${id}`, { method: "DELETE" }).catch(() => {});
    fs.rmSync(path.resolve(process.cwd(), SCRATCH), { recursive: true, force: true });
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
    mock.close();
    await scratchApp.stop();
    console.log(
      target.live
        ? "\n▶ probe models and scratch files cleaned up; campaign rates restored — but this run was destructive, so check the target instance by hand."
        : "\n▶ probe models, mock network, scratch files and the scratch instance removed.",
    );
  }

  console.log(`\n${failures.length ? `✗ ${failures.length} check(s) failed: ${failures.join("; ")}` : "✓ every check passed"}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
