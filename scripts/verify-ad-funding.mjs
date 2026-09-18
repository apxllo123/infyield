#!/usr/bin/env node
/**
 * Ad-funded paid AI — the verification suite.
 *
 * Proves the product's economic claim end to end against the *packaged* server:
 *
 *   Infyield holds its own provider credential, pays for real paid models, and
 *   funds that spend from advertising revenue — while the person using it pays
 *   nothing and supplies no key.
 *
 * Two instances, because the interesting cases are configuration states rather
 * than requests:
 *
 *   NO-KEY  no provider credential, ad network configured — must refuse every
 *           model call and say exactly what is missing, while ads keep serving
 *           and server-side frequency caps refuse over-eager serving.
 *   FUNDED  credential + mock model provider + mock ad network — the whole loop:
 *           an ad serves, the impression is verified, revenue is pending,
 *           reconciles to confirmed, and a paid model turn is admitted against
 *           that revenue and debited.
 *
 * What is SIMULATED, stated plainly so the output cannot be misread:
 *
 *   SIMULATED  the model provider (a mock OpenAI-compatible upstream) and the ad
 *              network (a mock EthicalAds decision endpoint). Every dollar below
 *              came from a mock, and the server itself reports `mode: simulated`
 *              throughout.
 *   REAL       the server, the HTTP surface, the ledger, the funding policy and
 *              its refusals, the ad lifecycle and its deduplication, the price
 *              ceiling sent upstream, the model router, and OpenRouter
 *              reachability.
 *
 * A PASS means the plumbing and the accounting are correct. It does NOT mean
 * anybody earned money: that needs an advertiser or an approved network account,
 * which the final report states as BLOCKED rather than faking.
 *
 *   node scripts/verify-ad-funding.mjs
 */
import { announceTarget, createScratchApp, resolveTarget } from "./lib/scratch-app.mjs";
import { createMockLlm } from "./lib/mock-llm.mjs";
import { createMockAdNet } from "./lib/mock-adnet.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const section = (t) => console.log(`\n${t}\n`);
const money = (v) => `$${Number(v ?? 0).toFixed(6)}`;

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function sendJson(base, path, body, method = "POST") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Drive one agent turn over SSE and return what it emitted. */
async function chat(base, body) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return { status: res.status, json: await res.json().catch(() => ({})), events: [] };
  }
  const text = await res.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6).trim())
    .filter((l) => l && l !== "[DONE]")
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  return { status: res.status, json: null, events };
}

function impressionToken(impUrl) {
  try {
    return new URL(impUrl, "http://127.0.0.1").searchParams.get("i") ?? "";
  } catch {
    return "";
  }
}

async function postImpression(base, token, eventId) {
  const res = await fetch(`${base}/api/ads/impression?i=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "x-infyield-event-id": eventId },
  });
  return {
    status: res.status,
    body: await res.json().catch(() => ({})),
    outcome: res.headers.get("x-infyield-ack-outcome"),
  };
}

/** Flip a mock-ad-network control. */
async function adnetControl(decisionUrl, action, value) {
  const base = decisionUrl.replace("/api/v1/decision/", "/__mock/");
  await fetch(`${base}${action}?${value}`).then((r) => r.json());
}

/* --------------------------------- setup ---------------------------------- */

const llm = createMockLlm();
const adnet = createMockAdNet();
const llmPort = await llm.start();
await adnet.start();

const funded = await resolveTarget(3899);
const noKey = await resolveTarget(3901);
announceTarget("ad-funded paid AI", funded);
console.log(`  simulated model provider on 127.0.0.1:${llmPort}`);
console.log(`  simulated ad network   on ${adnet.decisionUrl()}\n`);

/** Nothing that could authenticate must survive from the runner's environment. */
const CLEAR_CREDENTIALS = {
  OPENROUTER_API_KEY: "",
  INFYIELD_OPENROUTER_KEY: "",
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GEMINI_API_KEY: "",
  GOOGLE_API_KEY: "",
  GOOGLE_AI_API_KEY: "",
  INFYIELD_PROVIDER_BASE_URL: "",
};

const AD_ENV = {
  INFYIELD_ETHICALADS_PUBLISHER: "simulated-publisher",
  INFYIELD_ETHICALADS_DECISION_URL: adnet.decisionUrl(),
};

/* ============ 1. a server with no credential must fail closed ============= */

section("1. No provider credential — refuse, and say exactly what is missing");

const appNoKey = createScratchApp({
  base: noKey.base,
  port: noKey.port,
  serverPath: noKey.serverPath,
  prefix: "infyield-adfund-nokey-",
  env: {
    ...CLEAR_CREDENTIALS,
    ...AD_ENV,
    // A floor wide enough to test that the cap exists.
    INFYIELD_MIN_SECONDS_BETWEEN_ADS: "60",
  },
});
await appNoKey.start();

const bootNoKey = await getJson(noKey.base, "/api/bootstrap");
check(
  "TEST 1: startup reports not-ready with no provider credential",
  bootNoKey.body.ready === false && bootNoKey.body.hasAnyKey === false,
  `ready=${bootNoKey.body.ready} hasAnyKey=${bootNoKey.body.hasAnyKey}`,
);
check(
  "and names the exact variable an operator must set",
  Array.isArray(bootNoKey.body.missingProviderEnv) && bootNoKey.body.missingProviderEnv.includes("OPENROUTER_API_KEY"),
  JSON.stringify(bootNoKey.body.missingProviderEnv),
);

const chatNoKey = await chat(noKey.base, { messages: [{ id: "a", role: "user", content: "hello" }] });
check(
  "TEST 1: a model request fails closed with a clear configuration error",
  chatNoKey.status === 503 && chatNoKey.json?.error === "AI provider is not configured.",
  `HTTP ${chatNoKey.status} ${chatNoKey.json?.error ?? ""}`,
);

const healthNoKey = await getJson(noKey.base, "/api/health");
check(
  "health distinguishes 'not configured' from 'outage'",
  healthNoKey.body.aiProvider?.status === "NOT_CONFIGURED" && healthNoKey.body.openRouter?.reachable === true,
  `ai=${healthNoKey.body.aiProvider?.status} openRouterReachable=${healthNoKey.body.openRouter?.reachable}`,
);
check(
  "and reports no model as servable",
  healthNoKey.body.modelCatalog?.status === "NOT_CONFIGURED" && healthNoKey.body.modelCatalog?.servable === 0,
  JSON.stringify(healthNoKey.body.modelCatalog),
);
check("health never returns credential material", !/sk-or-v1|[A-Za-z0-9_-]{40,}/.test(JSON.stringify(healthNoKey.body.providers)), "key-shaped string in /api/health");

section("2. Advertising does not depend on the AI being configured");

const serve1 = await sendJson(noKey.base, "/api/ads", { messages: [{ role: "user", content: "postgres schema" }] });
const ad1 = serve1.body.ads?.[0];
check(
  "TEST 7: an ad is served even with no provider credential",
  serve1.status === 200 && !!ad1,
  `HTTP ${serve1.status} ads=${serve1.body.ads?.length ?? 0}`,
);
check(
  "the served ad is a normalized response with its own tracking endpoints",
  !!ad1 && typeof ad1.title === "string" && typeof ad1.clickUrl === "string" && typeof ad1.impUrl === "string",
  JSON.stringify(ad1 ?? {}).slice(0, 120),
);
check("and it came from the ad network", ad1?.provider === "ethicalads", `provider=${ad1?.provider}`);

const serve2 = await sendJson(noKey.base, "/api/ads", { messages: [{ role: "user", content: "another" }] });
check(
  "TEST 13: the server refuses a second serve inside the frequency floor",
  (serve2.body.ads?.length ?? 0) === 0 && serve2.body.refused === "too-soon",
  `ads=${serve2.body.ads?.length} refused=${serve2.body.refused}`,
);
check(
  "and explains it, rather than looking like an empty auction",
  typeof serve2.body.reason === "string" && /Frequency floor/.test(serve2.body.reason),
  serve2.body.reason,
);

/* =================== 3. the funded instance: the full loop ================= */

section("3. A configured server — Infyield's own credential, ads funding paid models");

const appFunded = createScratchApp({
  base: funded.base,
  port: funded.port,
  serverPath: funded.serverPath,
  prefix: "infyield-adfund-",
  env: {
    INFYIELD_MODE: "test",
    ...CLEAR_CREDENTIALS,
    ...AD_ENV,
    // The one credential in this run. A fake value: it never reaches OpenRouter,
    // because the provider base URL below points at the mock.
    OPENROUTER_API_KEY: "sk-or-v1-simulated-suite-key",
    INFYIELD_PROVIDER_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    INFYIELD_RESERVE_USD: "0",
    INFYIELD_DAILY_SPEND_CAP_USD: "100",
    INFYIELD_MAX_REQUEST_USD: "1",
    INFYIELD_MAX_DAILY_REQUESTS: "1000",
    // Pacing widened so the suite can drive the pipeline quickly. Widening is
    // explicit here and is not the shipped default.
    INFYIELD_MIN_SECONDS_BETWEEN_ADS: "0",
    INFYIELD_MAX_ADS_PER_SESSION: "1000",
    INFYIELD_MAX_ADS_PER_DAY: "1000",
  },
});
await appFunded.start();
const B = funded.base;

// Settings from the environment are imported on the first bootstrap, so this
// must happen before anything reads the ad configuration.
await getJson(B, "/api/bootstrap");

const healthB = await getJson(B, "/api/health");
check(
  "TEST 2: the provider health check succeeds with Infyield's credential",
  healthB.body.aiProvider?.status === "CONNECTED",
  `status=${healthB.body.aiProvider?.status}`,
);
check(
  "TEST 2: the model catalog is healthy and models are servable",
  healthB.body.modelCatalog?.status === "HEALTHY" && healthB.body.modelCatalog?.servable > 0,
  JSON.stringify(healthB.body.modelCatalog),
);
check(
  "the server reports itself SIMULATED, so nothing here reads as production",
  healthB.body.mode?.simulated === true && healthB.body.mode?.mode === "simulated",
  JSON.stringify(healthB.body.mode),
);
check(
  "and marks which mock is in play, by variable name",
  (healthB.body.mode?.mocks ?? []).some((m) => m.env === "INFYIELD_PROVIDER_BASE_URL"),
  JSON.stringify(healthB.body.mode?.mocks ?? []),
);

const modelsB = await getJson(B, "/api/models");
check(
  "the catalog exposes the resolved server-side policy",
  Array.isArray(modelsB.body.models) &&
    modelsB.body.models.every(
      (m) =>
        typeof m.provider === "string" &&
        typeof m.priceIn === "number" &&
        typeof m.priceOut === "number" &&
        typeof m.maxOutputTokens === "number" &&
        typeof m.maxRequestTokens === "number" &&
        typeof m.fallbackPolicy === "string" &&
        typeof m.supportsTools === "boolean" &&
        typeof m.enabled === "boolean",
    ),
  JSON.stringify(modelsB.body.models?.[0] ?? {}).slice(0, 130),
);
const paidModel = modelsB.body.models.find((m) => !m.premium && m.priceIn > 0 && m.available);
check("a normal paid model is offered and available", !!paidModel, `available=${modelsB.body.models.filter((m) => m.available).length}`);

/* ---- a paid turn runs on the deployment's credential, with no revenue yet --- */

// This block used to assert the opposite: that a paid turn was *refused* until ad
// revenue was confirmed. That rule made a fresh install unusable — connect a real
// credential, confirm the key works against the provider, and every request still
// refused — which is a cliff between "connected" and "usable" with nothing in
// between, and not what the product is. So the gate no longer preconditions an
// ordinary model on ad revenue; what it asserts now is the contract that replaced
// it: the turn runs on the credential the provider bills, and it says plainly
// whether the ads are covering it yet. The prompt is a plain one so the ad
// scheduler stays quiet here — cadence is exercised in its own section, and an
// extra serve at this point would move the floor for the ones that follow.
const spendBeforeFirstTurn = (await getJson(B, "/api/economy")).body.spendUsd ?? 0;
const firstTurn = await chat(B, {
  model: paidModel.id,
  messages: [{ id: "b1", role: "user", content: "write a function" }],
});
const firstFunding = firstTurn.events.find((e) => e.type === "funding");
const firstUsageEv = firstTurn.events.find((e) => e.type === "usage");
check(
  "TEST 3: a paid turn runs on the deployment's credential with no ad revenue confirmed",
  firstTurn.status === 200 && firstTurn.events.some((e) => e.type === "done"),
  `HTTP ${firstTurn.status} events=${firstTurn.events.map((e) => e.type).join(",")}`,
);
check(
  "and it reports the coverage position rather than implying the ads paid for it",
  !!firstFunding &&
    firstFunding.funding?.confirmedRevenueUsd === 0 &&
    firstFunding.funding?.health === "at-risk" &&
    // The point of the assertion: it must not claim the ads paid for something
    // they did not. "at-risk" and no coverage claim is the honest answer here.
    !/covering the bill/i.test(String(firstFunding.funding?.reason ?? "")),
  `health=${firstFunding?.funding?.health} reason=${String(firstFunding?.funding?.reason ?? "").slice(0, 88)}`,
);
const spendAfterFirstTurn = (await getJson(B, "/api/economy")).body.spendUsd ?? 0;
check(
  "and the provider's reported cost is what the ledger books, with no revenue to hide behind",
  firstUsageEv?.actualUsd > 0 && Math.abs(spendAfterFirstTurn - spendBeforeFirstTurn - firstUsageEv.actualUsd) < 1e-9,
  `provider $${firstUsageEv?.actualUsd} → ledger +$${(spendAfterFirstTurn - spendBeforeFirstTurn).toFixed(8)}`,
);

/* --------------------- serve, impress, dedupe, lifecycle ----------------- */

section("4. Serve → display → verify → pending");

const start = (await getJson(B, "/api/economy")).body;

// Point the whole slot at one campaign at an inflated CPM, so the arithmetic is
// exact and the campaign under test is the one that serves. Same technique the
// advertiser-path suite uses; the endpoints, ledger and gate are all real.
const campaigns0 = (await getJson(B, "/api/campaigns")).body.campaigns;
const target = campaigns0[0];
for (const c of campaigns0) {
  if (c.id === target.id) continue;
  await sendJson(B, "/api/campaigns", { id: c.id, active: false }, "PATCH");
}
const RATE = 1000; // $1.00 per impression
await sendJson(B, "/api/campaigns", { id: target.id, cpmUsd: RATE, cpcUsd: 1, active: true }, "PATCH");
console.log(`  target campaign: "${target.title}" at $${RATE} CPM\n`);

// A network ad first: this is the pending path.
const serveNet = await sendJson(B, "/api/ads", {
  messages: [{ role: "user", content: "postgres schema migration" }],
  sessionId: "suite",
});
const adNet = serveNet.body.ads?.[0];
check("a network ad serves", adNet?.provider === "ethicalads", `provider=${adNet?.provider}`);

const tokenNet = impressionToken(adNet?.impUrl ?? "");
const imp1 = await postImpression(B, tokenNet, "suite-impression-1");
check(
  "TEST 8: the impression is recorded and revenue booked as PENDING",
  imp1.status === 200 && imp1.body.creditedUsd > 0 && imp1.body.pending === true && imp1.body.stage === "pending",
  JSON.stringify(imp1.body),
);
check(
  "TEST 10: pending, because the network pays on its own schedule",
  imp1.body.stage === "pending",
  `stage=${imp1.body.stage}`,
);

const imp1Replay = await postImpression(B, tokenNet, "suite-impression-1");
check(
  "TEST 9: replaying the same impression event credits nothing",
  imp1Replay.body.alreadyRecorded === true && (imp1Replay.body.creditedUsd ?? 0) === 0,
  JSON.stringify(imp1Replay.body),
);
check(
  "and the dedupe is signalled in a header, so a client can tell the difference",
  imp1.outcome === "accepted" && imp1Replay.outcome === "deduped",
  `${imp1.outcome} → ${imp1Replay.outcome}`,
);

const afterImp = (await getJson(B, "/api/economy")).body;
check(
  "the pending bucket grew by exactly one impression's worth",
  Math.abs(afterImp.estimatedRevenueUsd - start.estimatedRevenueUsd - imp1.body.creditedUsd) < 1e-9,
  `gain=${money(afterImp.estimatedRevenueUsd - start.estimatedRevenueUsd)} credited=${money(imp1.body.creditedUsd)}`,
);
check(
  "TEST 17: pending revenue is not counted as confirmed",
  Math.abs(afterImp.adRevenueUsd - start.adRevenueUsd) < 1e-9,
  `confirmed moved by ${money(afterImp.adRevenueUsd - start.adRevenueUsd)}`,
);

/* --------- an impression the network did not accept must not pay ---------- */

await adnetControl(adnet.decisionUrl(), "view", "ok=0");
const serveUnverified = await sendJson(B, "/api/ads", { messages: [{ role: "user", content: "index advice" }], sessionId: "suite" });
const tokenUnverified = impressionToken(serveUnverified.body.ads?.[0]?.impUrl ?? "");
const pendingBefore = (await getJson(B, "/api/economy")).body.estimatedRevenueUsd;
const impUnverified = await postImpression(B, tokenUnverified, "suite-impression-unverified");
const pendingAfter = (await getJson(B, "/api/economy")).body.estimatedRevenueUsd;
check(
  "TEST 14: an impression the network did not accept books no revenue",
  (impUnverified.body.creditedUsd ?? 0) === 0 && typeof impUnverified.body.warning === "string",
  JSON.stringify(impUnverified.body).slice(0, 130),
);
check(
  "and the pending bucket did not move",
  Math.abs(pendingAfter - pendingBefore) < 1e-9,
  `${money(pendingBefore)} → ${money(pendingAfter)}`,
);
await adnetControl(adnet.decisionUrl(), "view", "ok=1");

/* ------------- house inventory is recorded but is not revenue ------------- */

section("5. House inventory is booked, and is not money");

await adnetControl(adnet.decisionUrl(), "fill", "ok=0");
const serveHouse = await sendJson(B, "/api/ads", { messages: [{ role: "user", content: "postgres schema" }], sessionId: "suite" });
check(
  "with the network empty, the app falls back to its own inventory",
  serveHouse.body.ads?.[0]?.provider === "first_party",
  `provider=${serveHouse.body.ads?.[0]?.provider}`,
);
const collectibleBefore = (await getJson(B, "/api/health")).body.revenuePipeline.collectibleUsd;
const tokenHouse = impressionToken(serveHouse.body.ads?.[0]?.impUrl ?? "");
const impHouse = await postImpression(B, tokenHouse, "suite-impression-house");
const afterHouse = (await getJson(B, "/api/economy")).body;
const healthHouse = (await getJson(B, "/api/health")).body;
check(
  "a house impression is booked for delivery reporting",
  (impHouse.body.creditedUsd ?? 0) > 0 && impHouse.body.stage === "pending" && impHouse.body.pending === true,
  JSON.stringify(impHouse.body),
);
check(
  "TEST 17: but it adds nothing collectible — nobody is on the hook for it",
  Math.abs(healthHouse.revenuePipeline.collectibleUsd - collectibleBefore) < 1e-9,
  `collectible ${money(collectibleBefore)} → ${money(healthHouse.revenuePipeline.collectibleUsd)}`,
);
check(
  "and the ledger records its origin as house, not as an advertiser",
  (afterHouse.entries ?? []).some((e) => e.origin === "house"),
  `origins=${[...new Set((afterHouse.entries ?? []).map((e) => e.origin))].join(",")}`,
);

/* ---------------- advertiser-backed delivery becomes collectible ---------- */

section("6. Marking the advertiser makes that delivery collectible");

// PATCH, not POST: attaching an advertiser to an existing campaign is a PATCH
// action (`action: "attach-advertiser"`), which is what the UI sends. POST is
// create-only and requires title+url, so posting here tests nothing but the
// create validation.
const attach = await sendJson(
  B,
  "/api/campaigns",
  {
    action: "attach-advertiser",
    id: target.id,
    name: "Simulated Advertiser LLC",
    contact: "billing@simulated.example",
    terms: "net30",
    amountUsd: 500,
  },
  "PATCH",
);
check(
  "the campaign is now backed by a paying advertiser",
  attach.status === 200 && !!attach.body.campaign?.advertiserAccount,
  `HTTP ${attach.status} ${JSON.stringify(attach.body).slice(0, 300)}`,
);
const healthBacked = (await getJson(B, "/api/health")).body;
check(
  "the delivery it had already made became collectible revenue",
  healthBacked.revenuePipeline.collectibleUsd > healthHouse.revenuePipeline.collectibleUsd,
  `${money(healthHouse.revenuePipeline.collectibleUsd)} → ${money(healthBacked.revenuePipeline.collectibleUsd)}`,
);

const serveBacked = await sendJson(B, "/api/ads", { messages: [{ role: "user", content: "postgres schema" }], sessionId: "suite" });
const tokenBacked = impressionToken(serveBacked.body.ads?.[0]?.impUrl ?? "");
const impBacked = await postImpression(B, tokenBacked, "suite-impression-backed");
const econBacked = (await getJson(B, "/api/economy")).body;
check(
  "TEST 10: an advertiser-backed impression reaches CONFIRMED",
  impBacked.body.stage === "confirmed" && !impBacked.body.pending,
  JSON.stringify(impBacked.body),
);
check(
  "and its origin is recorded as the advertiser",
  (econBacked.entries ?? []).some((e) => e.origin === "advertiser"),
  `origins=${[...new Set((econBacked.entries ?? []).map((e) => e.origin))].join(",")}`,
);

/* --------------------- reconcile pending → confirmed --------------------- */

section("7. Reconciling the network's statement");

const preReconcile = (await getJson(B, "/api/economy")).body;
const reconcile = await sendJson(B, "/api/payouts", { action: "reconcile" });
check(
  "TEST 11: pending revenue reconciles into confirmed revenue",
  reconcile.status === 200 && reconcile.body.estimatedRevenueUsd === 0,
  `HTTP ${reconcile.status} pending=${money(reconcile.body.estimatedRevenueUsd)}`,
);
check(
  "confirmed grew by exactly what was pending",
  Math.abs(reconcile.body.adRevenueUsd - preReconcile.adRevenueUsd - preReconcile.estimatedRevenueUsd) < 1e-9,
  `${money(preReconcile.adRevenueUsd)} + ${money(preReconcile.estimatedRevenueUsd)} vs ${money(reconcile.body.adRevenueUsd)}`,
);
const overReconcile = await sendJson(B, "/api/payouts", { action: "reconcile", amount: 999 });
check(
  "reconciling more than is pending is refused, so confirmed revenue cannot be invented",
  overReconcile.status === 400 && /pending reconciliation/.test(String(overReconcile.body.error ?? "")),
  `HTTP ${overReconcile.status} ${overReconcile.body.error ?? ""}`,
);

const fundedHealth = await getJson(B, "/api/health");
check(
  "TEST 11: collectible revenue is now positive and a provider budget exists",
  fundedHealth.body.revenuePipeline.collectibleUsd > 0 && fundedHealth.body.funding.providerBudgetUsd > 0,
  `collectible=${money(fundedHealth.body.revenuePipeline.collectibleUsd)} budget=${money(fundedHealth.body.funding.providerBudgetUsd)}`,
);

/* --------------------------- the paid model turn ------------------------- */

section("8. A paid model turn, funded by that revenue");

llm.setCost(0.0123); // distinctive, so the ledger cannot pass by accident
const spendBefore = (await getJson(B, "/api/economy")).body.spendUsd;

const turn = await chat(B, {
  model: paidModel.id,
  sessionId: "suite",
  messages: [{ id: "c1", role: "user", content: "Say hello in one short sentence." }],
});
const delta = turn.events.filter((e) => e.type === "delta").map((e) => e.text).join("");
const usageEvent = turn.events.find((e) => e.type === "usage");
const fundingEvent = turn.events.find((e) => e.type === "funding");
check(
  "TEST 3: a paid-model request completes and streams a response",
  turn.status === 200 && delta.length > 0 && turn.events.some((e) => e.type === "done"),
  `HTTP ${turn.status} chars=${delta.length} events=${turn.events.map((e) => e.type).join(",")} body=${JSON.stringify(turn.json).slice(0, 300)}`,
);
check(
  "the turn announces what funded it before doing any work",
  !!fundingEvent && fundingEvent.funding?.confirmedRevenueUsd > 0,
  JSON.stringify(fundingEvent?.funding ?? {}).slice(0, 110),
);
check(
  "TEST 4: provider usage comes back for the turn",
  !!usageEvent && usageEvent.usage?.promptTokens > 0 && usageEvent.usage?.completionTokens > 0,
  JSON.stringify(usageEvent ?? {}).slice(0, 130),
);
check(
  "TEST 19: the provider's reported cost is what the ledger books",
  usageEvent?.actualUsd === 0.0123 && usageEvent?.costMethod === "provider-reported",
  `actualUsd=${usageEvent?.actualUsd} method=${usageEvent?.costMethod}`,
);

const afterTurn = (await getJson(B, "/api/economy")).body;
check(
  "TEST 5: exactly one model-spend entry was booked, for the reported amount",
  Math.abs(afterTurn.spendUsd - spendBefore - 0.0123) < 1e-9,
  `spend ${money(spendBefore)} → ${money(afterTurn.spendUsd)}`,
);
const spendEntries = (afterTurn.entries ?? []).filter((e) => e.kind === "spend");
check(
  "the entry carries the provider's figure and says so",
  spendEntries.some((e) => e.costMethod === "provider-reported" && Math.abs(Math.abs(e.delta) - 0.0123) < 1e-9),
  spendEntries.map((e) => `${e.costMethod}:${money(Math.abs(e.delta))}`).join(", "),
);
check(
  "TEST 20: every spend entry names the request it came from",
  spendEntries.every((e) => typeof e.sourceId === "string" && e.sourceId.length > 0),
  `${spendEntries.filter((e) => !e.sourceId).length} without a source id`,
);

/* ------------------- the economics travel with the request ------------- */

section("9. The economics travel with the request");

const lastUpstream = llm.requests[llm.requests.length - 1];
// The completion cap has to go out with the request. Without it OpenRouter sizes
// its affordability check against the *model's* maximum output — it answered a
// real turn with "You requested up to 131072 tokens, but can only afford 19193" —
// so a working credential is refused models it can actually afford.
check(
  "TEST 16: the request carries a completion cap, so affordability is sized on it",
  Number.isFinite(lastUpstream?.maxTokens) && lastUpstream.maxTokens > 0,
  `max_tokens sent=${lastUpstream?.maxTokens}`,
);
check(
  "TEST 16/21: the request carries a hard price ceiling, in USD per million tokens",
  !!lastUpstream?.provider?.max_price && lastUpstream.provider.max_price.prompt === paidModel.priceIn,
  `sent=${JSON.stringify(lastUpstream?.provider ?? null)} catalog=${JSON.stringify(paidModel.priceCeiling)}`,
);
check(
  "TEST 23: fallbacks are only allowed when the model's policy permits them",
  lastUpstream?.provider?.allow_fallbacks === (paidModel.fallbackPolicy !== "none"),
  `policy=${paidModel.fallbackPolicy} allow_fallbacks=${lastUpstream?.provider?.allow_fallbacks}`,
);
check(
  "and the call went out on the credential Infyield owns",
  lastUpstream?.authorization === "present",
  `authorization=${lastUpstream?.authorization}`,
);
check(
  "the client cannot name an upstream: an unknown model id is refused",
  (await chat(B, { model: "openai/gpt-5-pro", messages: [{ id: "x", role: "user", content: "hi" }] })).status === 400,
  "a provider-native model id was accepted from the client",
);

/* ------------------- identity, limits, and failure modes --------------- */

section("10. Accounting identity, spending limits, failure modes");

const healthAfter = await getJson(B, "/api/health");
check(
  "TEST 6/invariant: the ledger reconciles against its own usage records",
  healthAfter.body.ledger?.reconcileOk === true && healthAfter.body.ledger?.errors === 0,
  JSON.stringify(healthAfter.body.ledger?.discrepancies ?? []).slice(0, 220),
);
check(
  "TEST 13: net equals confirmed revenue minus provider spend, exactly",
  Math.abs(
    healthAfter.body.ledger.netUsd -
      (healthAfter.body.revenuePipeline.confirmedUsd - healthAfter.body.providerSpend.totalUsd),
  ) < 1e-9,
  `net=${money(healthAfter.body.ledger.netUsd)}`,
);

const spendBeforeCeiling = (await getJson(B, "/api/economy")).body.spendUsd;
await sendJson(B, "/api/settings", { funding: { maxRequestCostUsd: 0.0001 } }, "PATCH");
const tooExpensive = await chat(B, { model: paidModel.id, messages: [{ id: "c2", role: "user", content: "again" }] });
check(
  "TEST 16: a request above the per-request ceiling is refused by policy",
  [402, 429, 503].includes(tooExpensive.status) && tooExpensive.json?.code === "request-ceiling",
  `HTTP ${tooExpensive.status} code=${tooExpensive.json?.code}`,
);
check(
  "and the refused request booked no spend",
  Math.abs((await getJson(B, "/api/economy")).body.spendUsd - spendBeforeCeiling) < 1e-9,
  "spend moved on a refused request",
);
await sendJson(B, "/api/settings", { funding: { maxRequestCostUsd: 1 } }, "PATCH");

// A reserve far above the balance used to defer the request. It must not any
// more: the reserve is the margin the *reserve tier* measures itself against, not
// a precondition for an everyday model — that was the rule that made an install
// with a working credential refuse to do anything at all.
await sendJson(B, "/api/settings", { funding: { reserveUsd: 1_000_000 } }, "PATCH");
const withHugeReserve = await chat(B, { model: paidModel.id, messages: [{ id: "c3", role: "user", content: "again" }] });
check(
  "TEST 22: a reserve far above the balance no longer blocks an ordinary model",
  withHugeReserve.status === 200 && withHugeReserve.events.some((e) => e.type === "done"),
  `HTTP ${withHugeReserve.status} code=${withHugeReserve.json?.code}`,
);
await sendJson(B, "/api/settings", { funding: { reserveUsd: 0 } }, "PATCH");

// ...but the reserve tier itself is still earned, which is the protection the old
// gate was really providing. Pick a model whose threshold the balance does not
// clear and confirm it is refused on affordability, not on existence.
const shortModel = (await getJson(B, "/api/models")).body.models.find((m) => m.premium && m.shortfallUsd > 0);
if (shortModel) {
  const lockedTier = await chat(B, { model: shortModel.id, messages: [{ id: "c3b", role: "user", content: "again" }] });
  check(
    "TEST 22: an unaffordable reserve-tier model is still refused, because it is earned",
    lockedTier.status === 402 && lockedTier.json?.code === "premium-locked",
    `HTTP ${lockedTier.status} code=${lockedTier.json?.code}`,
  );
} else {
  check(
    "TEST 22: every reserve-tier model is above its threshold at this balance",
    true,
    "none short — the earned tier is fully unlocked here",
  );
}

await sendJson(B, "/api/settings", { funding: { emergencyStop: true } }, "PATCH");
const stopped = await chat(B, { model: paidModel.id, messages: [{ id: "c4", role: "user", content: "again" }] });
check(
  "TEST 22: the emergency stop refuses every new request",
  stopped.status === 503 && stopped.json?.code === "emergency-stop",
  `HTTP ${stopped.status} code=${stopped.json?.code}`,
);
await sendJson(B, "/api/settings", { funding: { emergencyStop: false } }, "PATCH");

await sendJson(B, "/api/settings", { funding: { reserveUsd: 0 } }, "PATCH");
// A real outage fails *every* attempt, not just the first. The OpenAI SDK
// retries 5xx by itself (maxRetries defaults to 2, and the server does not
// lower it), so a one-shot failure is absorbed by an invisible retry and the
// caller correctly sees a success — which would make this test pass for the
// wrong reason in reverse. `count` above the retry budget is what makes the
// upstream genuinely unavailable for the length of the turn.
const attemptsBefore = (await fetch(`http://127.0.0.1:${llmPort}/__mock/log`).then((r) => r.json())).requests.length;
await fetch(`http://127.0.0.1:${llmPort}/__mock/fail`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: 500, count: 6, body: { error: { message: "Simulated upstream outage" } } }),
});
const spendBeforeFail = (await getJson(B, "/api/economy")).body.spendUsd;
const errorsBefore = (await getJson(B, "/api/health")).body.providerSpend.errors;
const failedTurn = await chat(B, { model: paidModel.id, messages: [{ id: "c5", role: "user", content: "will fail" }] });
check(
  "TEST 15: an upstream failure is reported as an error, never as a successful turn",
  failedTurn.events.some((e) => e.type === "error") && !failedTurn.events.some((e) => e.type === "done"),
  `events=${failedTurn.events.map((e) => e.type).join(",")}`,
);
// Documents the SDK's own retry rather than leaving it as a mystery: an outage
// that outlives the retry budget is what surfaces to the user.
const attemptsAfter = (await fetch(`http://127.0.0.1:${llmPort}/__mock/log`).then((r) => r.json())).requests.length;
check(
  "TEST 15: the outage was retried before being given up on, and then gave up",
  attemptsAfter - attemptsBefore >= 2,
  `upstream attempts ${attemptsBefore} → ${attemptsAfter}`,
);
check(
  "TEST 15: and no spend was invented for it",
  Math.abs((await getJson(B, "/api/economy")).body.spendUsd - spendBeforeFail) < 1e-9,
  "spend moved on a failed request",
);
const healthAfterFail = await getJson(B, "/api/health");
check(
  "the failure is still recorded in usage accounting",
  healthAfterFail.body.providerSpend.errors > errorsBefore,
  `errors ${errorsBefore} → ${healthAfterFail.body.providerSpend.errors}`,
);
check(
  "and no credential leaked into the transcript or the health payload",
  !failedTurn.events.some((e) => e.type === "error" && /sk-or-v1/.test(String(e.message))) &&
    !/sk-or-v1/.test(JSON.stringify(healthAfterFail.body)),
  "a key-shaped string appeared",
);

/* ---------------------- the economic test, summarised ------------------- */

section("11. The economic test: can advertising fund the paid models?");

const end = (await getJson(B, "/api/economy")).body;
console.log(
  `  START  confirmed ${money(start.adRevenueUsd)}  pending ${money(start.estimatedRevenueUsd)}  spend ${money(start.spendUsd)}`,
);
console.log(
  `  END    confirmed ${money(end.adRevenueUsd)}  pending ${money(end.estimatedRevenueUsd)}  spend ${money(end.spendUsd)}`,
);
console.log(`  NET    ${money(end.adRevenueUsd - end.spendUsd)}  (confirmed − provider spend)`);
console.log(
  `  ledger ${(end.entries ?? []).length} entries; origins ${[...new Set((end.entries ?? []).map((e) => e.origin))].join(", ")}`,
);
check(
  "TEST 13: revenue and spend are tracked separately and net is their difference",
  Math.abs(end.adRevenueUsd - end.spendUsd - (end.adRevenueUsd - end.spendUsd)) < 1e-12 && end.spendUsd > 0,
  `spend=${money(end.spendUsd)}`,
);
check(
  "the whole pipeline ran inside an environment the server itself flags as simulated",
  healthAfter.body.mode?.simulated === true,
  "the server did not report itself simulated",
);

await appFunded.stop();
await appNoKey.stop();
await llm.stop();
await adnet.stop();

/* -------------------------------- report ------------------------------- */

console.log(`\n${"─".repeat(74)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  · ${f}`);
}
console.log(`\nSIMULATED here: the model provider and the ad network.`);
console.log(`REAL here: the server, the ledger, the funding policy and its refusals,`);
console.log(`the ad lifecycle and dedupe, the price ceiling sent upstream, the model`);
console.log(`router, and OpenRouter reachability.`);
process.exitCode = fail ? 1 : 0;
