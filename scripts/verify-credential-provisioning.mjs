#!/usr/bin/env node
/**
 * Credential provisioning — how the deployment gets a provider credential, and
 * what the app does before it has one.
 *
 * This exists because the connect flow was silently broken: "Connect OpenRouter"
 * exchanged an OAuth code for a token and wrote it to the key pool, which the
 * agent no longer consults. Every model then refused with "AI provider is not
 * configured" while the UI said the account was connected. A credential has to
 * land where the router reads it — `provider.env` in the app's data directory —
 * and that is what this suite drives, through the same file the connect flow
 * writes and the same reader the model calls use.
 *
 * It is deliberately not mocked on the credential side: the file is real, the
 * reader is the production one, and the reload is observed without restarting
 * the server.
 *
 *   node scripts/verify-credential-provisioning.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createScratchApp, announceTarget, resolveTarget } from "./lib/scratch-app.mjs";
import { startMockAdEnv, seedConfirmedRevenue } from "./lib/fund-scratch.mjs";
import { createMockLlm } from "./lib/mock-llm.mjs";

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

async function getJson(base, p) {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function postJson(base, p, body) {
  const res = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* SSE or empty */
  }
  return { status: res.status, body: parsed, text };
}

/** Every field name and value that a response could leak a secret through. */
function leaksSecret(payload, secret) {
  const text = JSON.stringify(payload ?? "");
  return text.includes(secret) || /sk-or-v1-[A-Za-z0-9]{6,}/.test(text);
}

const target = await resolveTarget(3903);
const BASE = target.base;
const SECRET = "sk-or-v1-provisioning-suite-not-a-real-key-000000000000";

// A stand-in upstream, so section 4 can observe a real turn once the credential
// exists. The base-URL seam is environment-only, and the credential itself is
// deliberately **not** in the environment — that is the thing under test.
const llm = createMockLlm();
const llmPort = await llm.start();
llm.setCost(0.0123); // distinctive, so a booked spend cannot be a coincidence

// No provider credential here: this instance starts unconfigured, which is the
// state a fresh install is actually in.
const { adnet, env } = await startMockAdEnv({
  INFYIELD_PROVIDER_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
});
const app = createScratchApp({
  base: BASE,
  port: target.port,
  serverPath: target.serverPath,
  prefix: "infyield-credential-",
  env,
});

try {
  await app.start();
  announceTarget("credential provisioning", target);

  /* ---------------------- 1. unconfigured, and honest ---------------------- */

  section("1. Before any credential exists");

  const cold = await getJson(BASE, "/api/bootstrap");
  check("the server reports itself not ready", cold.body.ready === false, `ready=${cold.body.ready}`);
  check(
    "and names the exact variable an operator must set",
    Array.isArray(cold.body.missingProviderEnv) && cold.body.missingProviderEnv.length > 0,
    (cold.body.missingProviderEnv ?? []).join(", ") || "(none named)",
  );
  check(
    "no provider is reported configured",
    (cold.body.providers ?? []).every((p) => p.configured === false),
    "some provider claimed to be configured",
  );

  const refused = await postJson(BASE, "/api/chat", {
    model: "glm-5.3-flash",
    messages: [{ id: "r1", role: "user", content: "hello" }],
  });
  check(
    "a model request fails closed with a configuration error, not an outage",
    refused.status === 503 && refused.body?.code === "provider-not-configured",
    `HTTP ${refused.status} code=${refused.body?.code}`,
  );

  /* ------------------------- 2. ads work regardless ----------------------- */

  section("2. Advertising does not depend on the AI being configured");

  const adRes = await postJson(BASE, "/api/ads", { sessionId: "cred-suite", messages: [] });
  check(
    "an ad is served anyway, so revenue can accumulate before the AI is set up",
    (adRes.body?.ads ?? []).length === 1,
    `served ${(adRes.body?.ads ?? []).length}`,
  );

  /* ---------------------- 3. provisioning the credential ------------------ */

  section("3. Writing the credential where the router reads it");

  const envFile = path.join(app.dataDir, "provider.env");
  fs.writeFileSync(envFile, `OPENROUTER_API_KEY=${SECRET}\n`, { mode: 0o600 });
  const mode = fs.statSync(envFile).mode & 0o777;
  check("the credential file is written 0600, not world-readable", mode === 0o600, `mode=${mode.toString(8)}`);

  // The reader caches file values briefly, so give it one TTL to notice. This is
  // the property that matters: a credential can be added without a restart.
  let warm = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 600));
    warm = await getJson(BASE, "/api/bootstrap");
    if (warm.body.ready) break;
  }
  check("the running server picks it up with no restart", warm.body.ready === true, `ready=${warm.body.ready}`);
  const orStatus = (warm.body.providers ?? []).find((p) => p.provider === "openrouter");
  check(
    "and reports where the credential came from, without reporting the credential",
    orStatus?.configured === true && orStatus?.source === "env-file",
    `configured=${orStatus?.configured} source=${orStatus?.source}`,
  );
  check(
    "the credential value is nowhere in the bootstrap payload",
    !leaksSecret(warm.body, SECRET),
    "the response carried credential material",
  );

  /* --------------------------- 4. it can now pay --------------------------- */

  section("4. A funded turn on the provisioned credential");

  // The mock upstream is reached through the base-URL seam, so the port has to be
  // in place before this point; `startMockAdEnv` returns the env it will use, and
  // the inference base is filled in here to keep one source of truth.
  const funded = await seedConfirmedRevenue(BASE, { targetUsd: 2 });
  check(
    "revenue is confirmed, so the funding gate has something to draw on",
    funded.confirmedUsd >= 2,
    `confirmed ${money(funded.confirmedUsd)} budget ${money(funded.budgetUsd)}`,
  );

  const health = await getJson(BASE, "/api/health");
  check(
    "the app reports itself as configured and reachable",
    health.body.aiProvider?.status === "CONNECTED" || health.body.aiProvider?.status === "READY",
    `status=${health.body.aiProvider?.status}`,
  );
  check("no credential leaked through the health surface", !leaksSecret(health.body, SECRET));
  const settings = await getJson(BASE, "/api/settings");
  check("nor through the settings endpoint", !leaksSecret(settings.body, SECRET));

  // The turn itself: the credential that was just written is the one that pays for
  // this call, and the provider's own reported cost is what lands in the ledger.
  const spendBefore = (await getJson(BASE, "/api/economy")).body.spendUsd ?? 0;
  const turnRes = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.3-flash",
      sessionId: "cred-suite",
      messages: [{ id: "t1", role: "user", content: "Say hello in one short sentence." }],
    }),
  });
  const raw = await turnRes.text();
  const events = raw
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
  const answer = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  const usage = events.find((e) => e.type === "usage");
  check(
    "a turn runs on the provisioned credential and streams a real answer",
    turnRes.status === 200 && answer.length > 0 && events.some((e) => e.type === "done"),
    `HTTP ${turnRes.status} chars=${answer.length} events=${events.map((e) => e.type).join(",")}`,
  );
  const spendAfter = (await getJson(BASE, "/api/economy")).body.spendUsd ?? 0;
  check(
    "and the provider's reported cost is what the ledger books",
    Math.abs(spendAfter - spendBefore - 0.0123) < 1e-9 && usage?.actualUsd === 0.0123,
    `spend ${money(spendBefore)} → ${money(spendAfter)} (provider reported ${money(usage?.actualUsd)})`,
  );
  check("the credential did not appear in the streamed transcript", !raw.includes(SECRET));

  /* --------------------------- 5. revocation ------------------------------ */

  section("5. Disconnecting actually disconnects");

  fs.rmSync(envFile, { force: true });
  let cold2 = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 600));
    cold2 = await getJson(BASE, "/api/bootstrap");
    if (!cold2.body.ready) break;
  }
  check("removing the file returns the server to unconfigured", cold2.body.ready === false, `ready=${cold2.body.ready}`);
  const refusedAgain = await postJson(BASE, "/api/chat", {
    model: "glm-5.3-flash",
    messages: [{ id: "r2", role: "user", content: "hello" }],
  });
  check(
    "and it refuses again, rather than serving from a stale credential",
    refusedAgain.status === 503,
    `HTTP ${refusedAgain.status}`,
  );

  console.log(`\n${"─".repeat(74)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  · ${f}`);
  }
} finally {
  await adnet.stop();
  await llm.stop();
  await app.stop();
}

process.exit(fail ? 1 : 0);
