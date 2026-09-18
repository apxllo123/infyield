#!/usr/bin/env node
/**
 * Bulletproofing the one path that can pay you without you selling an ad: the
 * ad-network slot. Two halves, and both matter.
 *
 *  A. LIVE CONTRACT — the real EthicalAds decision API is probed for the exact
 *     fields this app depends on (`link`, `view_url`, `view_time_url`, `copy`,
 *     `campaign_type: "paid"`) and for its rejection behaviour. If they change
 *     their shape, or if our parsing expectations drift, this fails loudly
 *     instead of the slot silently earning $0 — which is exactly what the first
 *     implementation did.
 *
 *  B. MONEY SAFETY — the app is run against a mock network that can return a
 *     paid fill, an unpaid (house) creative, a rejection, a no-fill, or a
 *     failing impression pixel. For each: does revenue get booked, and *only*
 *     for the case where the network actually accepted the impression?
 *
 * Self-contained: it starts its own server (scratch data dir) and its own mock
 * network, so nothing touches your real install or the live ad network's stats.
 *
 *   node scripts/verify-network-ads.mjs
 *   node scripts/verify-network-ads.mjs --no-live      # skip the live probe
 *   INFYIELD_SERVER=/path/to/server.js node scripts/verify-network-ads.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { freePort } from "./lib/scratch-app.mjs";

// Taken from the OS, not assumed. A fixed port is how this suite would happily
// start against whatever else was listening on it — the boot probe gets a 200
// from the stranger and every destructive step then lands on that instance.
// See the note in lib/scratch-app.mjs.
const APP_PORT = Number(process.env.INFYIELD_PORT || (await freePort()));
const MOCK_PORT = Number(process.env.INFYIELD_MOCK_NETWORK_PORT || (await freePort()));
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const RUN_LIVE = !process.argv.includes("--no-live");
const REPO = process.cwd();

const DEFAULT_SERVER = "release/Infyield-darwin-arm64/Infyield.app/Contents/Resources/app/server/server.js";
/** The real ad network, used by the live transport probe. */
const LIVE_DECISION_URL = "https://server.ethicalads.io/api/v1/decision/";

const money = (n) => `$${Number(n ?? 0).toFixed(6)}`;
const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
}
/** Context that is worth printing but that we do not control, so it must not fail the run. */
function note(label) {
  console.log(`  · ${label}`);
}

/* ------------------------------ mock network ------------------------------ */

/**
 * A faithful stand-in for the decision API. `mode` decides what the next
 * decision request returns; hits are recorded so "did the pixel actually fire"
 * is answerable.
 */
function startMockNetwork(port) {
  const state = { mode: "paid", hits: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", MOCK);
    if (url.pathname === "/__mode") {
      state.mode = url.searchParams.get("m") ?? "paid";
      state.hits.length = 0;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mode: state.mode }));
      return;
    }
    if (url.pathname === "/__hits") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hits: state.hits }));
      return;
    }
    state.hits.push({ path: url.pathname, at: Date.now() });

    if (url.pathname === "/api/v1/decision/") {
      const publisher = url.searchParams.get("publisher") ?? "";
      // Mirror the real API: an unknown publisher is a 400 with that body.
      if (publisher !== "mock-publisher") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ publisher: ["Invalid publisher"] }));
        return;
      }
      if (state.mode === "nofill") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      const campaignType = state.mode === "house" ? "house" : "paid";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `mock-creative-${state.mode}`,
          text: '<a href="' + MOCK + '/proxy/click/1/n1/">Mock advert</a>',
          body: "Mock headline Mock body copy Try it",
          copy: { headline: "Mock headline", cta: "Try it", content: "Mock body copy" },
          link: `${MOCK}/proxy/click/1/n1/`,
          link_domain: "mock-advertiser.example",
          view_url: `${MOCK}/proxy/view/1/n1/`,
          view_time_url: `${MOCK}/proxy/viewtime/1/n1/`,
          nonce: "n1",
          display_type: "text-v1",
          campaign_type: campaignType,
        }),
      );
      return;
    }
    if (url.pathname.startsWith("/proxy/view/")) {
      if (state.mode === "pixel-500") {
        res.writeHead(500);
        res.end("nope");
        return;
      }
      if (state.mode === "slow-pixel") {
        // Deliberately slow, so a duplicate acknowledgement can arrive while the
        // first one is still waiting on the pixel. That window is the whole
        // reason the booking path is locked.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "image/gif" });
          res.end();
        }, 250);
        return;
      }
      res.writeHead(200, { "content-type": "image/gif" });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/proxy/viewtime/") || url.pathname.startsWith("/proxy/click/")) {
      res.writeHead(302, { location: `${MOCK}/landing` });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/* ---------------------------------- http ---------------------------------- */

async function getJson(p) {
  const res = await fetch(`${BASE}${p}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function sendJson(p, payload, method = "POST") {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function serveOneAd(context = "postgres database migration") {
  const res = await fetch(`${BASE}/api/ads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: context }] }),
  });
  return res.json();
}

/* --------------------------------- server --------------------------------- */

function resolveServerPath() {
  const explicit = process.env.INFYIELD_SERVER;
  if (explicit) return explicit;
  const p = path.join(REPO, DEFAULT_SERVER);
  if (fs.existsSync(p)) return p;
  throw new Error(`No server found. Build the app (./scripts/build-app.sh) or set INFYIELD_SERVER=…/server.js`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Remove a scratch dir. The server may still be flushing as it dies, so a
 * recursive remove races and throws ENOTEMPTY — retries are the answer. */
function removeScratch(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  } catch (err) {
    note(`scratch dir left behind at ${dir} (${err?.code ?? err})`);
  }
}

async function startAppAndWait(serverPath, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "infyield-net-"));
  const log = fs.createWriteStream(path.join(dataDir, "server.log"));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      INFYIELD_DATA_DIR: dataDir,
      INFYIELD_ETHICALADS_DECISION_URL: `${MOCK}/api/v1/decision/`,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  for (let i = 0; i < 60; i++) {
    // A probe cannot tell "our server answered" from "somebody else did". If the
    // child has already exited, a 200 here is a stranger's.
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/bootstrap`);
      if (res.ok) {
        if (child.exitCode !== null) break;
        return { child, dataDir };
      }
    } catch {
      /* not up yet */
    }
  }
  throw new Error(
    `server did not come up on ${BASE}; see ${dataDir}/server.log` +
      (child.exitCode !== null ? ` (it exited with code ${child.exitCode} — was ${BASE} already taken?)` : ""),
  );
}

/* ------------------------------- live probe -------------------------------- */

/**
 * The live half proves the thing that was actually broken: that the app's own
 * request reaches the ad network's API *at all*.
 *
 * It runs the real bundled server — not a re-implementation of its transport —
 * against the real decision endpoint with a publisher id that cannot be valid,
 * and asserts the app records an *application-level* rejection. That distinction
 * is the whole bug: Cloudflare refused Node's HTTP/1.1 client with `403 Request
 * Blocked`, so no publisher id could ever have worked and the network slot
 * silently earned exactly nothing no matter how correct the parsing was. An
 * API-level 400 only comes back if the request got past the edge, so this check
 * fails the moment the transport regresses to fetch().
 *
 * The first version of this probe called the endpoint with `fetch` directly,
 * which re-implemented the bug instead of testing the app, and so passed while
 * the app itself could never work. Driving the app is the point.
 *
 * No impression pixel is fired here: with no valid publisher there is no
 * advertiser, and there is nothing to misattribute a view to.
 */
async function liveTransportProbe(serverPath) {
  console.log("A. live transport — does the app's own request reach the ad network?\n");

  // What a plain HTTP/1.1 client sees. Informational: it is the symptom that
  // motivated the HTTP/2 transport, and not something we control — Cloudflare is
  // free to change its edge rules.
  const edge = await fetch(`${LIVE_DECISION_URL}?publisher=infyield-probe&ad_types=text-v1&format=json`)
    .then((r) => `HTTP ${r.status}${r.status === 403 ? " (blocked at the edge)" : ""}`)
    .catch(() => null);
  if (!edge) {
    note("the live ad network is unreachable — skipping the live probe (offline is not a code fault)");
    console.log("");
    return;
  }
  note(`the same URL from a plain HTTP/1.1 fetch: ${edge}`);

  const app = await startAppAndWait(serverPath, { INFYIELD_ETHICALADS_DECISION_URL: LIVE_DECISION_URL });
  try {
    await sendJson(
      "/api/settings",
      { ads: { network: "ethicalads", ethicalAdsPublisherId: "infyield-probe-not-a-real-publisher" } },
      "PATCH",
    );
    await serveOneAd();
    const econ = await getJson("/api/economy");
    const st = econ.body?.delivery?.networkStatus ?? {};
    const detail = String(st.detail ?? "").trim();
    check(
      "the app's request is answered by the ad network's API, not rejected at the edge",
      st.reason === "invalid-publisher",
      `reason=${st.reason}${detail ? ` — ${detail.slice(0, 60)}` : ""}`,
    );
    check(
      "the API's own rejection body comes back (so the request reached the application layer)",
      /invalid publisher/i.test(detail),
      detail.slice(0, 80) || "(no detail recorded)",
    );
    console.log("");
    note("a real publisher id is invite-only, so the paid-fill field contract is proven in part B against the mock");
  } finally {
    app.child.kill("SIGTERM");
    await waitForExit(app.child);
    removeScratch(app.dataDir);
  }
}

/* ---------------------------------- main ----------------------------------- */

async function main() {
  console.log(`Infyield ad-network verification\n`);

  const serverPath = resolveServerPath();

  if (RUN_LIVE) {
    await liveTransportProbe(serverPath);
  } else {
    console.log("A. live transport — skipped (--no-live)\n");
  }

  const mock = await startMockNetwork(MOCK_PORT);
  console.log(`▶ mock ad network on ${MOCK}, app on ${BASE} (scratch data dir)\n`);
  // The server enforces a floor between serves (20s by default) so a client
  // cannot spam ad requests. This suite is about *what gets booked when a serve
  // happens*, not about cadence — and it drives many serves in a row — so the
  // floor is turned off here through its documented operator seam. That the
  // floor exists and refuses a too-eager client is verified separately, in
  // `verify-ad-funding.mjs` section 2, so switching it off here loses no
  // coverage rather than hiding some.
  const { child, dataDir } = await startAppAndWait(serverPath, {
    INFYIELD_MIN_SECONDS_BETWEEN_ADS: "0",
  });

  try {
    console.log("B. money safety — what gets booked, and only when it should\n");

    // Point the app at the network. Publisher id is arbitrary: the mock decides.
    await sendJson("/api/settings", { ads: { network: "ethicalads", ethicalAdsPublisherId: "mock-publisher", cpmUsd: 2 } }, "PATCH");
    await sendJson("/api/campaigns", { id: "none", active: false }, "PATCH").catch(() => {});

    // Named readMoney, not `money`: shadowing the formatter above made every
    // reported figure print as `[object Promise]`, so the suite looked like it
    // was checking amounts while printing nothing usable.
    const readMoney = async () => {
      const e = await getJson("/api/economy");
      return { confirmed: e.body.confirmedRevenueUsd ?? e.body.adRevenueUsd, pending: e.body.estimatedRevenueUsd, spend: e.body.spendUsd };
    };
    const setMode = (m) => fetch(`${MOCK}/__mode?m=${m}`).then((r) => r.json());
    const hits = () => fetch(`${MOCK}/__hits`).then((r) => r.json());

    /* --- paid fill: serve, render, pixel, book as pending ------------------- */
    await setMode("paid");
    const before = await readMoney();
    const served = await serveOneAd();
    const ad = served.ads?.[0];
    check("a paid creative is served as network inventory", ad?.provider === "ethicalads", `provider=${ad?.provider}`);
    check(
      "copy is taken from the structured fields, not scraped out of HTML",
      ad?.title === "Mock headline" && ad?.adText === "Mock body copy" && ad?.cta === "Try it",
      `${ad?.title} / ${ad?.adText} / ${ad?.cta}`,
    );
    check("the advertiser domain is shown, not the tracking host", ad?.domain === "mock-advertiser.example", ad?.domain);

    const impRes = await fetch(`${BASE}${ad.impUrl}`, { method: "POST", headers: { "x-event-id": "net-1" } }).then((r) => r.json());
    const afterImpr = await readMoney();
    check("the impression is booked as PENDING revenue, not confirmed", afterImpr.pending > before.pending && afterImpr.confirmed === before.confirmed,
      `pending ${money(before.pending)} → ${money(afterImpr.pending)}, confirmed unchanged at ${money(afterImpr.confirmed)}`);
    check("the credited amount is CPM/1000", Math.abs((impRes.creditedUsd ?? 0) - 0.002) < 1e-12, money(impRes.creditedUsd));

    const h = (await hits()).hits.filter((x) => x.path.startsWith("/proxy/view"));
    check("the network's impression pixel was actually delivered", h.length >= 1, `${h.length} pixel request(s): ${h.map((x) => x.path).join(", ")}`);
    await new Promise((r) => setTimeout(r, 1600));
    const h2 = (await hits()).hits.filter((x) => x.path.startsWith("/proxy/viewtime"));
    check("the view-time pixel follows (how the network validates a view)", h2.length >= 1, `${h2.length} request(s)`);

    // Idempotency: a re-render must not be billed twice.
    const dup = await fetch(`${BASE}${ad.impUrl}`, { method: "POST", headers: { "x-event-id": "net-1" } }).then((r) => r.json());
    const afterDup = await readMoney();
    check("a duplicate impression is not billed twice", dup.alreadyRecorded === true && Math.abs(afterDup.pending - afterImpr.pending) < 1e-12, money(afterDup.pending));

    /* --- the same creative, served again ------------------------------------- */
    // The mock returns a constant creative id per mode, exactly like a small
    // rotating pool. A booking token derived from that id made the second serve
    // look like a replay of the first: `alreadyRecorded`, no view pixel, no money,
    // forever. Each serve now carries its own token.
    const repeat = await serveOneAd();
    const repeatAd = repeat.ads?.[0];
    check(
      "the same creative served again gets its own impression token",
      repeatAd?.provider === "ethicalads" && !!repeatAd.impUrl && repeatAd.impUrl !== ad.impUrl,
      `${String(ad.impUrl).split("i=")[1]?.slice(0, 14)}… vs ${String(repeatAd?.impUrl).split("i=")[1]?.slice(0, 14)}…`,
    );
    const beforeRepeat = await readMoney();
    const repeatAck = await fetch(`${BASE}${repeatAd.impUrl}`, { method: "POST", headers: { "x-event-id": "net-2" } }).then((r) => r.json());
    const afterRepeat = await readMoney();
    check(
      "and it books its own revenue rather than being deduped away",
      repeatAck.alreadyRecorded !== true && Math.abs((repeatAck.creditedUsd ?? 0) - 0.002) < 1e-12 && afterRepeat.pending - beforeRepeat.pending > 0,
      `credited ${money(repeatAck.creditedUsd)}, pending ${money(beforeRepeat.pending)} → ${money(afterRepeat.pending)}`,
    );
    const viewHits = (await hits()).hits.filter((x) => x.path.startsWith("/proxy/view"));
    check("and the repeat serve reached the network's own pixel", viewHits.length >= 2, `${viewHits.length} pixel request(s)`);

    /* --- five acks at once, one impression ----------------------------------- */
    // Check, await the pixel, then write. Without a lock across all three, every
    // concurrent ack reads "not booked yet" and each one books — the same money
    // counted five times. The pixel is slowed down so the window is real.
    await setMode("slow-pixel");
    const concAd = (await serveOneAd()).ads?.[0];
    const beforeConc = await readMoney();
    const concAcks = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        fetch(`${BASE}${concAd.impUrl}`, { method: "POST", headers: { "x-event-id": `net-conc-${n}` } }).then((r) => r.json()),
      ),
    );
    const afterConc = await readMoney();
    const booked = concAcks.filter((a) => (a.creditedUsd ?? 0) > 0).length;
    const deduped = concAcks.filter((a) => a.alreadyRecorded === true).length;
    check(
      "five concurrent acks of one impression book exactly once",
      booked === 1 && deduped === 4 && Math.abs(afterConc.pending - beforeConc.pending - 0.002) < 1e-12,
      `${booked} booked, ${deduped} deduped, pending +${money(afterConc.pending - beforeConc.pending)}`,
    );
    await setMode("paid");

    // The click must route the reader through the network so it records (and pays) it.
    const click = await fetch(`${BASE}${ad.clickUrl}`, { method: "POST", headers: { "x-event-id": "net-click-1" } }).then((r) => r.json());
    check("a click is handed the network's own redirect", typeof click.url === "string" && click.url.startsWith(MOCK), click.url?.slice(0, 48) + "…");

    /* --- unpaid creative ----------------------------------------------------- */
    await setMode("house");
    const beforeHouse = await readMoney();
    const house = await serveOneAd();
    const econHouse = await getJson("/api/economy");
    check(
      "an unpaid (house) creative is refused so it cannot book revenue",
      house.ads?.[0]?.provider !== "ethicalads",
      `served provider=${house.ads?.[0]?.provider}, reason=${econHouse.body.delivery.networkStatus.reason}`,
    );
    check("no revenue is booked for it", Math.abs((await readMoney()).pending - beforeHouse.pending) < 1e-12, money(beforeHouse.pending));

    /* --- rejected publisher -------------------------------------------------- */
    await sendJson("/api/settings", { ads: { network: "ethicalads", ethicalAdsPublisherId: "wrong-id", cpmUsd: 2 } }, "PATCH");
    await setMode("paid");
    const beforeBad = await readMoney();
    const badServe = await serveOneAd();
    const econBad = await getJson("/api/economy");
    check(
      "a rejected publisher id is recorded as the reason, not hidden",
      econBad.body.delivery.networkStatus.reason === "invalid-publisher" && badServe.ads?.[0]?.provider !== "ethicalads",
      econBad.body.delivery.networkStatus.reason,
    );
    check("no revenue is booked for a rejection", Math.abs((await readMoney()).pending - beforeBad.pending) < 1e-12, money(beforeBad.pending));
    await sendJson("/api/settings", { ads: { network: "ethicalads", ethicalAdsPublisherId: "mock-publisher", cpmUsd: 2 } }, "PATCH");

    /* --- no fill ------------------------------------------------------------- */
    await setMode("nofill");
    const beforeNoFill = await readMoney();
    const noFill = await serveOneAd();
    const econNoFill = await getJson("/api/economy");
    check(
      "a no-fill response is distinguished from a rejection and still serves your own inventory",
      econNoFill.body.delivery.networkStatus.reason === "no-fill" && noFill.ads?.length === 1,
      `reason=${econNoFill.body.delivery.networkStatus.reason}, served=${noFill.ads?.[0]?.provider}`,
    );
    check("no revenue is booked for a no-fill", Math.abs((await readMoney()).pending - beforeNoFill.pending) < 1e-12, money(beforeNoFill.pending));

    /* --- failing pixel: the money safety case -------------------------------- */
    await setMode("pixel-500");
    const beforePixel = await readMoney();
    const pixelAd = await serveOneAd();
    const pixelAck = await fetch(`${BASE}${pixelAd.ads[0].impUrl}`, { method: "POST", headers: { "x-event-id": "net-pixelfail" } }).then((r) => r.json());
    const afterPixel = await readMoney();
    check(
      "an impression the network refused to record books NO revenue",
      (pixelAck.creditedUsd ?? -1) === 0 && Math.abs(afterPixel.pending - beforePixel.pending) < 1e-12,
      `credited ${money(pixelAck.creditedUsd)}; pending ${money(beforePixel.pending)} → ${money(afterPixel.pending)}${pixelAck.warning ? `; warning: ${pixelAck.warning}` : ""}`,
    );
    // ...and it must not have been consumed by that failure. Booking the dedupe
    // key before the pixel did exactly that: the network's outage permanently
    // spent the impression, and the retry that should have booked it was answered
    // `alreadyRecorded`.
    await setMode("paid");
    const retryAck = await fetch(`${BASE}${pixelAd.ads[0].impUrl}`, { method: "POST", headers: { "x-event-id": "net-pixelretry" } }).then((r) => r.json());
    check(
      "a failed pixel leaves the impression retryable, and the retry books it",
      retryAck.alreadyRecorded !== true && Math.abs((retryAck.creditedUsd ?? 0) - 0.002) < 1e-12,
      `credited ${money(retryAck.creditedUsd)} on retry`,
    );

    /* --- reconcile: pending becomes money you can actually take out ---------- */
    console.log("");
    const pre = await readMoney();
    await sendJson("/api/payouts", { action: "reconcile" });
    const post = await readMoney();
    check(
      "reconciling moves pending network revenue into the confirmed (payout-able) bucket",
      post.confirmed > pre.confirmed && post.pending < pre.pending && Math.abs(post.confirmed - pre.confirmed - (pre.pending - post.pending)) < 1e-9,
      `confirmed ${money(pre.confirmed)} → ${money(post.confirmed)}, pending ${money(pre.pending)} → ${money(post.pending)}`,
    );
    const payout = await sendJson("/api/payouts", { action: "payout", amount: Math.min(0.001, post.confirmed), note: "verification draw" });
    check(
      "confirmed network revenue can then be paid out to your account",
      payout.status === 200,
      `payout of ${money(Math.min(0.001, post.confirmed))} accepted`,
    );
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    mock.close();
    removeScratch(dataDir);
    console.log("\n▶ mock network, app process and scratch data removed");
  }

  console.log(`\n${failures.length ? `✗ ${failures.length} check(s) failed: ${failures.join("; ")}` : "✓ every check passed"}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
