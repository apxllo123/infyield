/**
 * Fund a scratch instance from advertising, so its spending gate will admit a
 * paid model turn.
 *
 * The product refuses to start a priced model call until collectible ad revenue
 * actually exists (`src/lib/funding.ts`). That is the whole point of the design —
 * a build that would happily spend money it never earned is the failure mode this
 * rule exists to prevent — but it means any suite that wants to observe a *paid*
 * turn first has to get revenue onto the books the same way production does.
 *
 * So this does not write a ledger entry. It drives the real path: point the app
 * at a mock ad network, serve an ad, let the server acknowledge the network's
 * impression pixel, then reconcile the network's statement so pending revenue
 * becomes confirmed. Every figure is simulated and the server reports itself as
 * `mode: simulated`; the *mechanism* is the production one.
 *
 * The amount is set through the ad CPM, exactly as an operator would set it, and
 * the loop stops as soon as the confirmed balance clears the target.
 */
import { createMockAdNet } from "./mock-adnet.mjs";

async function getJson(base, path) {
  const res = await fetch(`${base}${path}`);
  return res.json().catch(() => ({}));
}

async function sendJson(base, path, body, method = "POST") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Start a mock ad network and return the env a scratch app needs to use it. */
export async function startMockAdEnv(extraEnv = {}) {
  const adnet = createMockAdNet();
  const port = await adnet.start();
  return {
    adnet,
    port,
    env: {
      // Environment-only seam: no request or setting can aim a live install at a
      // fake network, so a funded balance can never be manufactured in production.
      INFYIELD_ETHICALADS_DECISION_URL: adnet.decisionUrl(),
      // This helper drives several serves in a row; the cadence floor is verified
      // on its own in verify-ad-funding.mjs, so it is switched off here rather
      // than slept through.
      INFYIELD_MIN_SECONDS_BETWEEN_ADS: "0",
      ...extraEnv,
    },
  };
}

/**
 * Drive serves + impressions + reconciliation until the instance holds at least
 * `targetUsd` of confirmed (collectible) revenue.
 *
 * Returns what it actually achieved, so a caller can assert on real numbers
 * rather than assuming the target was met.
 */
export async function seedConfirmedRevenue(
  base,
  { publisherId = "mock-publisher", cpmUsd = 2000, targetUsd = 2, maxServes = 12 } = {},
) {
  await sendJson(base, "/api/settings", { ads: { network: "ethicalads", ethicalAdsPublisherId: publisherId, cpmUsd } }, "PATCH");

  let served = 0;
  let lastReason = "";
  for (let i = 0; i < maxServes; i++) {
    const before = await getJson(base, "/api/health");
    if (Number(before.revenuePipeline?.collectibleUsd ?? 0) >= targetUsd) break;

    const res = await sendJson(base, "/api/ads", { sessionId: "funding-seed", messages: [] });
    const ad = res.body?.ads?.[0];
    if (!ad?.impUrl) {
      lastReason = res.body?.reason ?? res.body?.refused ?? JSON.stringify(res.body).slice(0, 120);
      break;
    }
    served += 1;

    // Acknowledging the impression is what books the network revenue as pending.
    await fetch(`${base}${ad.impUrl}`, {
      method: "POST",
      headers: { "x-infyield-event-id": `seed-${i}` },
    });

    // The network's statement arrives late in reality and immediately here; either
    // way the transition into "confirmed" is the same call.
    await sendJson(base, "/api/payouts", { action: "reconcile" });
  }

  const after = await getJson(base, "/api/health");
  return {
    served,
    confirmedUsd: Number(after.revenuePipeline?.collectibleUsd ?? 0),
    pendingUsd: Number(after.revenuePipeline?.pendingUsd ?? 0),
    budgetUsd: Number(after.funding?.providerBudgetUsd ?? 0),
    lastReason,
  };
}
