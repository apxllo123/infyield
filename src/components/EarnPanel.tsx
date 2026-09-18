"use client";

import { useEffect, useState } from "react";
import { IconBolt, IconCheck, IconLock, IconSparkle } from "@/components/icons";
import { ErrorState, Notice, SectionHeading, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { EarnPlanResponse } from "@/lib/client/api";
import { notifyDataChanged, useResource } from "@/lib/client/store";
import { usd } from "@/lib/client/format";

const INTENSITIES: EarnPlanResponse["intensity"][] = ["relaxed", "steady", "aggressive", "maximum"];

const INTENSITY_BLURB: Record<EarnPlanResponse["intensity"], string> = {
  relaxed: "One card, and rarely. Quietest to read.",
  steady: "The default: present but unobtrusive.",
  aggressive: "More cards, more often. Earns noticeably faster.",
  maximum: "A card at every tool step. Earns fastest, busiest to read.",
};

/** Compact money: cents matter here, so keep four decimals below $10. */
function money(v: number): string {
  if (v === 0) return "$0.00";
  if (v < 1) return `$${v.toFixed(4)}`;
  return usd(v);
}

function impressions(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v <= 0) return "0";
  return v >= 10_000 ? `${Math.round(v / 1000)}k` : String(v);
}

/**
 * The one place ad revenue is deliberately built up.
 *
 * Two controls only — how much you are saving towards, and how hard the ads
 * work — because those are the two things that actually change the number. The
 * rest is arithmetic: what an impression is worth at the configured CPM, how
 * many it takes to reach the target, and what each reserve-tier model costs per
 * turn and requires in the bank before it will run.
 *
 * No figure here is invented. All of it is derived from the live ledger, and
 * the panel says plainly when the inventory behind it is placeholder.
 */
export default function EarnPanel() {
  const plan = useResource(() => api.earn(), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const p = plan.data;
  useEffect(() => {
    if (p && draft === "") setDraft(p.targetUsd ? String(p.targetUsd) : "");
  }, [p, draft]);

  async function apply(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      plan.refresh();
      notifyDataChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-5">
      <SectionHeading
        eyebrow="Earn"
        title="Build up ad revenue"
        hint="Ad revenue accumulates here and pays for the models. Set the balance you are saving towards and how hard the cards work; the reserve-tier models unlock as the number climbs."
      />

      {plan.error && <ErrorState title="Can’t read the earn plan" body={plan.error} onRetry={plan.refresh} retrying={plan.loading} />}
      {error && (
        <Notice tone="danger" title="Couldn’t save that">
          {error}
        </Notice>
      )}

      {!p && plan.loading ? (
        <div className="glass panel">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-5 h-12 w-64" />
          <Skeleton className="mt-6 h-24" />
        </div>
      ) : p ? (
        <div className="grid gap-6 xl:grid-cols-[1fr_1.15fr]">
          {/* ------------------------- the controls ------------------------ */}
          <div className="glass-strong panel sheen relative overflow-hidden">
            <div
              className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full"
              style={{ background: "radial-gradient(circle at 50% 50%, rgba(53,224,161,0.18), transparent 70%)", filter: "blur(30px)" }}
            />
            <div className="relative">
              <div className="eyebrow">Saving towards</div>
              <div className="mt-3 flex flex-wrap items-end gap-4">
                <div className="num text-[42px] font-semibold leading-none tracking-[-0.03em] text-[var(--text-1)]">
                  {p.targetUsd > 0 ? usd(p.targetUsd) : "—"}
                </div>
                <div className="mb-1 text-[13.5px] text-[var(--text-3)]">
                  of which <span className="num text-[var(--mint)]">{money(p.spendableUsd)}</span> can actually be spent
                </div>
              </div>

              {p.placeholderRevenueUsd > 0.0001 && (
                <p className="t-micro mt-3 max-w-[52ch] leading-relaxed text-[var(--amber)]">
                  {money(p.placeholderRevenueUsd)} of booked revenue is unbilled — {p.placeholderCampaigns} campaign
                  {p.placeholderCampaigns === 1 ? "" : "s"} with no advertiser on the record, so nobody will ever pay it and it cannot fund a real
                  model call. Put an advertiser and an invoice behind one on Economy → Campaigns and that money becomes spendable.
                </p>
              )}

              {p.collectibleRevenueUsd > 0.0001 && (
                <p className="t-micro mt-3 max-w-[52ch] leading-relaxed">
                  {p.backedCampaigns} invoiced campaign{p.backedCampaigns === 1 ? "" : "s"} account for
                  <span className="num text-[var(--mint)]"> {money(p.collectibleRevenueUsd)}</span>, minus spend and payouts — that is the figure
                  the reserve tier below gates on.
                </p>
              )}

              {p.targetUsd > 0 && (
                <div className="mt-4">
                  <div className="h-2 overflow-hidden rounded-full bg-[rgba(0,0,0,0.4)]">
                    <div
                      className="h-full rounded-full bg-[linear-gradient(90deg,#46c8e8,#35e0a1)] transition-[width] duration-700"
                      style={{ width: `${Math.min(100, Math.max(0, (p.spendableUsd / p.targetUsd) * 100))}%` }}
                    />
                  </div>
                  <div className="t-micro mt-2">
                    {p.targetReached
                      ? "Target reached — the ads can ease off, or keep saving for a bigger model."
                      : `${money(p.toTargetUsd)} to go · about ${impressions(p.impressionsToTarget)} impressions or ${impressions(p.clicksToTarget)} clicks at your CPM.`}
                  </div>
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-2">
                {[4, 12, 40].map((t) => (
                  <button
                    key={t}
                    className={`btn btn-sm ${p.targetUsd === t ? "btn-glass" : "btn-quiet"}`}
                    disabled={busy}
                    onClick={() => apply(() => api.setEarnTarget(t))}
                  >
                    {usd(t)}
                  </button>
                ))}
                <div className="flex items-center gap-2">
                  <input
                    className="input w-[104px]"
                    inputMode="decimal"
                    placeholder="Custom"
                    value={draft}
                    onChange={(ev) => setDraft(ev.target.value)}
                    onBlur={() => {
                      const v = Number(draft);
                      if (!Number.isFinite(v) || v < 0) {
                        setError("Enter a target of 0 or more.");
                        return;
                      }
                      if (v !== p.targetUsd) apply(() => api.setEarnTarget(v));
                    }}
                  />
                  <span className="t-micro">USD · 0 clears it</span>
                </div>
              </div>

              <div className="mt-8">
                <div className="eyebrow">Card intensity</div>
                <div className="seg mt-3 flex-wrap">
                  {INTENSITIES.map((k) => (
                    <button
                      key={k}
                      className="seg-item"
                      data-active={p.intensity === k}
                      disabled={busy}
                      onClick={() => apply(() => api.setAdIntensity(k))}
                    >
                      {k === "maximum" && <IconBolt size={13} />}
                      <span className="capitalize">{k}</span>
                    </button>
                  ))}
                </div>
                <p className="t-meta mt-3">{INTENSITY_BLURB[p.intensity]}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="chip">
                    {p.maxAdsPerResponse} card{p.maxAdsPerResponse === 1 ? "" : "s"} max per reply
                  </span>
                  <span className="chip">one card every {p.cadenceSteps} tool step{p.cadenceSteps === 1 ? "" : "s"}</span>
                  {p.adPressure > 0 && (
                    <span className="chip chip-amber">
                      <IconBolt size={12} />
                      tightened automatically — the balance is thin
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                <div className="rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.24)] px-4 py-3">
                  <div className="eyebrow">Per impression</div>
                  <div className="num mt-1.5 text-[19px] text-[var(--mint)]">{money(p.perImpressionUsd)}</div>
                  <div className="t-micro mt-1">at your configured CPM</div>
                </div>
                <div className="rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.24)] px-4 py-3">
                  <div className="eyebrow">Per click</div>
                  <div className="num mt-1.5 text-[19px] text-[var(--mint)]">{money(p.perClickUsd)}</div>
                  <div className="t-micro mt-1">a clicked card is worth far more</div>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <div className="rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.24)] px-4 py-3">
                  <div className="eyebrow">Collectible</div>
                  <div className="num mt-1.5 text-[19px] text-[var(--mint)]">{money(p.collectibleRevenueUsd)}</div>
                  <div className="t-micro mt-1">real revenue, can settle a bill</div>
                </div>
                <div className="rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.24)] px-4 py-3">
                  <div className="eyebrow">Placeholder</div>
                  <div className="num mt-1.5 text-[19px] text-[var(--text-3)]">{money(p.placeholderRevenueUsd)}</div>
                  <div className="t-micro mt-1">seeded demo inventory, never paid</div>
                </div>
                <div className="rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.24)] px-4 py-3">
                  <div className="eyebrow">Spendable</div>
                  <div className="num mt-1.5 text-[19px] text-[var(--text-1)]">{money(p.spendableUsd)}</div>
                  <div className="t-micro mt-1">collectible minus spend and payouts</div>
                </div>
              </div>

              {/*
                There is no "your own key is paying" state to report: the
                deployment always holds the credential, so the ad ledger is always
                the constraint. The branch that used to render here described a
                second billing mode that no longer exists.
              */}
              {p.adFunded && p.usingPlaceholderInventory && (
                <Notice tone="info" title="This inventory is a placeholder">
                  Cards currently come from first-party campaigns with no advertiser behind them, so the ledger moves but no real money arrives.
                  Real earnings need a live network publisher id or an actual advertiser — see the Advertising section below, and Connections for the
                  network.
                </Notice>
              )}
            </div>
          </div>

          {/* --------------------- the reserve tier ladder -------------------- */}
          <div className="glass panel">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <div className="eyebrow">Reserve tier</div>
                <h3 className="mt-1.5 text-[17px] font-medium tracking-[-0.01em] text-[var(--text-1)]">What the heavy models cost</h3>
              </div>
              <span className="chip">
                <IconSparkle size={12} />
                {p.premium.filter((m) => m.unlocked).length}/{p.premium.length} unlocked
              </span>
            </div>
            <p className="t-meta mt-2">
              Cost shown is one representative multi-step agent turn (120k input, 12k output tokens) at the model&apos;s real list price.
            </p>

            <div className="mt-5 space-y-2.5">
              {p.premium.map((m) => (
                <div
                  key={m.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.22)] px-4 py-3"
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-[var(--r-xs)] border ${m.unlocked ? "border-[rgba(53,224,161,0.3)] bg-[rgba(53,224,161,0.1)] text-[var(--mint)]" : "border-[var(--border-1)] bg-[var(--surface-1)] text-[var(--text-4)]"}`}>
                    {m.unlocked ? <IconCheck size={14} /> : <IconLock size={13} />}
                  </span>
                  <span className="min-w-[132px] flex-1">
                    <span className="block text-[14px] font-medium tracking-[-0.01em] text-[var(--text-1)]">{m.label}</span>
                    <span className="t-micro">${m.priceIn.toFixed(2)} in · ${m.priceOut.toFixed(2)} out per 1M</span>
                  </span>
                  <span className="text-right">
                    <span className="num block text-[14px] text-[var(--text-1)]">{money(m.typicalTurnUsd)}</span>
                    <span className="t-micro">per turn</span>
                  </span>
                  <span className="text-right">
                    {m.unlocked ? (
                      <>
                        <span className="block text-[12.5px] text-[var(--mint)]">Unlocked</span>
                        <span className="t-micro">needs {usd(m.requiredUsd)} banked</span>
                      </>
                    ) : (
                      <>
                        <span className="num block text-[12.5px] text-[var(--amber)]">{impressions(m.impressionsToUnlock)} impr.</span>
                        <span className="t-micro">to bank {usd(m.requiredUsd)}</span>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>

            <p className="t-micro mt-5 leading-relaxed">
              Serving one of these costs a multiple of a regular turn, so the gate is the ledger: revenue has to be earned before it is spent.
              Every figure is an estimate from list prices and the configured CPM — actual spend is always booked at the provider&apos;s own reported
              usage.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
