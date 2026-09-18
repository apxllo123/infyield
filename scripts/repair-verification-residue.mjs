#!/usr/bin/env node
/**
 * Repair for installs polluted by the verification suites before they were
 * isolated (see scripts/lib/scratch-app.mjs for what changed and why).
 *
 * `verify-advertiser-path.mjs` and `verify-funding-loop.mjs` used to default to
 * http://127.0.0.1:3777, which is the port the desktop app serves on. Running the
 * documented one-liner therefore tested whatever app was listening — including a
 * real install — and mutated it:
 *
 *   - it inflated one campaign's CPM to 1000 and CPC to $1 so the test could
 *     reach an invoicing threshold quickly, and booked impressions/clicks at
 *     those rates into the real ledger;
 *   - it deactivated the other campaigns so the served card was deterministic;
 *   - it minted a real invoice against the campaign;
 *   - it registered probe keys and probe models pointing at a mock upstream that
 *     no longer exists;
 *   - it metered its mock model calls into the real ledger as spend.
 *
 * The suites' own `finally` restores the campaign fields on the happy path. An
 * interrupted run (kill, timeout, hang) never reaches it, so the damage stays.
 * This tool finds those artifacts and removes them.
 *
 * A second, subtler route exists and has also fired: the suite reserves a port
 * for its own scratch instance, and if something else is already bound there —
 * in practice the desktop app itself, which picks its own port when 3777 is
 * busy — the boot probe gets a healthy 200 from that stranger and `start()`
 * reports success. Everything section A does then lands on the stranger. So this
 * tool also removes the artifacts that route leaves (payout draws, a stored mock
 * provider credential, invoices marked paid with no payment behind them).
 * lib/scratch-app.mjs no longer uses a fixed port at all.
 *
 * Dry run by default — pass --apply to write. Everything is matched by explicit
 * predicate rather than by "looks wrong", so it cannot quietly delete real
 * revenue, and it prints every entry it intends to remove first.
 *
 *   node scripts/repair-verification-residue.mjs
 *   node scripts/repair-verification-residue.mjs --apply
 *   INFYIELD_REPAIR_DIR=/path/to/data node scripts/repair-verification-residue.mjs --apply
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const DIR =
  process.env.INFYIELD_REPAIR_DIR ||
  path.join(os.homedir(), "Library", "Application Support", "Infyield", "data");

/**
 * The rate the suite inflates to: CPM 1000 and CPC $1 both mean exactly $1.00
 * credited per event. Nothing in the seeded catalog comes close to that (the
 * highest is $0.003 per impression), so an ad entry of exactly $1.00 on one of
 * the seeded campaigns can only be that inflation.
 */
const INFLATED_DELTA = 1;

/** Models the suites register. Their spend entries are the suites' mock calls. */
const PROBE_MODEL_PREFIXES = ["probe-", "ledger-probe-", "verification-"];

/** Keys the suites register. */
const PROBE_KEY_LABELS = ["Verification gate key (unused)", "Verification mock upstream", "Verification mock upstream (openai)"];

/** Payout entries the suites write. */
const PROBE_PAYOUT_NOTES = ["verification draw"];

/**
 * Stripe credentials that exist only inside the verification harness.
 *
 * Matched literally rather than by shape: a key that is not on this list is a
 * real credential and must never be deleted by a repair tool, however fake it
 * looks. If something else is stored, the run says so and leaves it alone.
 */
const MOCK_STRIPE_KEYS = ["rk_test_mockkey_notarealkey", "rk_test_qa_mock", "rk_test_dbg"];

const read = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8"));
  } catch {
    return fallback;
  }
};
const writeIf = (file, value) => {
  if (APPLY) fs.writeFileSync(path.join(DIR, file), JSON.stringify(value, null, 2));
};
const money = (n) => `$${Number(n ?? 0).toFixed(6)}`;

function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`No data dir at ${DIR}. Set INFYIELD_REPAIR_DIR to point elsewhere.`);
    process.exit(1);
  }
  console.log(`Infyield verification-residue repair`);
  console.log(`  data dir: ${DIR}`);
  console.log(`  mode:     ${APPLY ? "APPLY (writing)" : "dry run (nothing is written)"}\n`);

  if (APPLY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${DIR}-backup-${stamp}`;
    fs.cpSync(DIR, backup, { recursive: true });
    console.log(`▶ backup written to ${backup}\n`);
  }

  const economy = read("economy.json", null);
  const campaigns = read("campaigns.json", []);
  const keys = read("keys.json", []);
  const models = read("custom-models.json", []);

  /* ------------------------------- ledger ---------------------------------- */

  if (economy && Array.isArray(economy.entries)) {
    const inflated = economy.entries.filter(
      (e) => (e.kind === "ad-impression" || e.kind === "ad-click") && e.delta === INFLATED_DELTA,
    );
    const probeSpend = economy.entries.filter(
      (e) => e.kind === "spend" && PROBE_MODEL_PREFIXES.some((p) => String(e.model ?? "").startsWith(p)),
    );
    const probePayouts = economy.entries.filter(
      (e) => e.kind === "payout" && PROBE_PAYOUT_NOTES.includes(String(e.note ?? "").toLowerCase()),
    );

    console.log("ledger");
    console.log(`  inflated-rate ad entries to remove: ${inflated.length}`);
    for (const e of inflated) console.log(`    − ${e.kind} ${money(e.delta)}  ${JSON.stringify(e.note)}`);
    console.log(`  probe-model spend entries to remove: ${probeSpend.length}`);
    for (const e of probeSpend.slice(0, 5)) console.log(`    − ${money(e.delta)}  ${e.model}`);
    if (probeSpend.length > 5) console.log(`    … and ${probeSpend.length - 5} more`);
    console.log(`  probe payout entries to remove: ${probePayouts.length}`);
    for (const e of probePayouts) console.log(`    − payout ${money(e.delta)}  ${JSON.stringify(e.note)}`);

    const revenueDelta = inflated.reduce((n, e) => n + e.delta, 0);
    const spendDelta = probeSpend.reduce((n, e) => n + e.delta, 0);
    // Deltas are negative for a payout, so adding them back cancels the draw.
    const payoutDelta = probePayouts.reduce((n, e) => n + e.delta, 0);
    const impressions = inflated.filter((e) => e.kind === "ad-impression").length;
    const clicks = inflated.filter((e) => e.kind === "ad-click").length;

    console.log(`  effect: adRevenue ${money(economy.adRevenueUsd)} → ${money(economy.adRevenueUsd - revenueDelta)}`);
    console.log(`          spend      ${money(economy.spendUsd)} → ${money(economy.spendUsd + spendDelta)}`);
    console.log(`          payouts    ${money(economy.payoutsUsd)} → ${money(Boolean(economy.payoutsUsd) ? economy.payoutsUsd + payoutDelta : 0)}`);
    console.log(`          impressions ${economy.impressions} → ${economy.impressions - impressions}`);
    console.log(`          clicks      ${economy.clicks} → ${economy.clicks - clicks}\n`);

    if (APPLY) {
      const drop = new Set([...inflated, ...probeSpend, ...probePayouts]);
      economy.entries = economy.entries.filter((e) => !drop.has(e));
      economy.adRevenueUsd -= revenueDelta;
      economy.spendUsd += spendDelta;
      if (typeof economy.payoutsUsd === "number") economy.payoutsUsd += payoutDelta;
      economy.impressions -= impressions;
      economy.clicks -= clicks;
      writeIf("economy.json", economy);
    }
  }

  /* ------------------------------ campaigns -------------------------------- */

  console.log("campaigns");
  // The seeded rates, mirroring seedHouseAdsIfEmpty(). Without these the suite's
  // inflated CPM has no known original to be restored to.
  const seed = {
    "The AI code reviewer": { cpmUsd: 2, cpcUsd: 0.5 },
    "Postgres for agents": { cpmUsd: 3, cpcUsd: 0.75 },
    "Ship faster with previews": { cpmUsd: 2.5, cpcUsd: 0.6 },
  };
  let touched = 0;
  const nextCampaigns = campaigns.map((c) => {
    const next = { ...c };
    const seeded = seed[c.title];
    if (seeded && (c.cpmUsd !== seeded.cpmUsd || c.cpcUsd !== seeded.cpcUsd)) {
      console.log(`  "${c.title}": rates ${c.cpmUsd}/${c.cpcUsd} → ${seeded.cpmUsd}/${seeded.cpcUsd} (seeded values)`);
      next.cpmUsd = seeded.cpmUsd;
      next.cpcUsd = seeded.cpcUsd;
      touched++;
    }
    if (c.advertiserAccount) {
      console.log(
        `  "${c.title}": removing invoice ${c.advertiserAccount.invoiceId} for ${JSON.stringify(c.advertiserAccount.name)} (verification artifact)`,
      );
      delete next.advertiserAccount;
      touched++;
    }
    if (c.active === false) {
      console.log(`  "${c.title}": reactivating (the suite pauses other campaigns; the seeded state is active)`);
      next.active = true;
      touched++;
    }
    return next;
  });
  if (!touched) console.log("  nothing to change");
  console.log("");
  writeIf("campaigns.json", nextCampaigns);

  /* -------------------------------- keys ----------------------------------- */

  const nextKeys = keys.filter((k) => !PROBE_KEY_LABELS.includes(k.label));
  console.log("keys");
  for (const k of keys) {
    if (PROBE_KEY_LABELS.includes(k.label)) console.log(`  removing ${JSON.stringify(k.label)} (${k.provider})`);
  }
  if (keys.length === nextKeys.length) console.log("  no probe keys");
  console.log(`  ${keys.length} → ${nextKeys.length}\n`);
  writeIf("keys.json", nextKeys);

  /* ------------------------------- models ---------------------------------- */

  const nextModels = models.filter((m) => !PROBE_MODEL_PREFIXES.some((p) => String(m.id ?? "").startsWith(p)));
  console.log("custom models");
  for (const m of models) {
    if (!nextModels.includes(m)) console.log(`  removing ${m.id} → ${m.upstream?.baseUrl ?? "(no baseUrl)"}`);
  }
  console.log(`  ${models.length} → ${nextModels.length}\n`);
  writeIf("custom-models.json", nextModels);

  /* --------------------------- payment settings ---------------------------- */

  /*
   * The suite configures a mock provider to exercise the collection path. That
   * config lives in settings, so a run against a real install leaves a fake
   * credential behind — one that would be sent to the real Stripe on the next
   * click. Only harness keys are cleared; anything else is reported and kept.
   */
  const settingsFile = path.join(DIR, "settings.json");
  if (fs.existsSync(settingsFile)) {
    const settings = read("settings.json", null);
    const key = String(settings?.payments?.stripeSecretKey ?? "");
    console.log("payment settings");
    if (!key) {
      console.log("  no stored provider credential\n");
    } else if (MOCK_STRIPE_KEYS.includes(key)) {
      console.log(`  clearing the harness credential ${JSON.stringify(key)} and resetting provider to none`);
      console.log(`  (it pointed at a local mock that is not running — leaving it would aim the next click at the real Stripe)\n`);
      if (APPLY) {
        settings.payments = {
          ...settings.payments,
          provider: "none",
          stripeSecretKey: "",
          linkUrl: "",
          successUrl: "",
          cancelUrl: "",
        };
        delete settings.payments.lastSyncAt;
        delete settings.payments.lastSyncText;
        writeIf("settings.json", settings);
      }
    } else {
      console.log(`  a stored credential is present but is not one of the harness keys — left untouched.`);
      console.log(`  If you did not add it yourself, remove it in Settings → Payments.\n`);
    }
  }

  /* ------------------------------ net state -------------------------------- */

  const netFile = path.join(DIR, "netstate.json");
  if (fs.existsSync(netFile)) {
    const state = read("netstate.json", null);
    console.log("network state");
    console.log(`  clearing the recorded outcome (${state?.reason ?? "unknown"}, publisher ${JSON.stringify(state?.publisherId ?? "")})`);
    console.log("  — it was written by a probe with a throwaway publisher id and no longer describes this install.\n");
    if (APPLY) fs.rmSync(netFile, { force: true });
  }

  console.log(APPLY ? "✓ repair applied" : "dry run complete — rerun with --apply to write");
}

main();
