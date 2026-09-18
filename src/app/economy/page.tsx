"use client";

import { useMemo, useState } from "react";
import EarnPanel from "@/components/EarnPanel";
import { ActivityRow } from "@/components/cards";
import { EmptyState, ErrorState, Notice, SectionHeading, Skeleton, Stat } from "@/components/ui";
import { IconBolt, IconCheck, IconExternal, IconInvoice, IconPlus, IconSparkle, IconWallet } from "@/components/icons";
import { api, errorMessage } from "@/lib/client/api";
import type { PaymentTerms } from "@/lib/types";
import type { LedgerEntry } from "@/lib/types";
import { notifyDataChanged, useDataSignal, useResource } from "@/lib/client/store";
import { clockTime, usd } from "@/lib/client/format";

/** Cumulative balance walked backwards from the live figure, drawn as a calm
 * area chart. Real entries only — no smoothing, no invented points. */
function BalanceChart({ entries, balance }: { entries: LedgerEntry[]; balance: number }) {
  const points = useMemo(() => {
    const chron = [...entries].sort((a, b) => a.ts - b.ts);
    const series: number[] = new Array(chron.length).fill(0);
    let running = balance;
    for (let i = chron.length - 1; i >= 0; i--) {
      series[i] = running;
      running -= chron[i].delta;
    }
    return series;
  }, [entries, balance]);

  if (points.length < 2) {
    return (
      <div className="flex h-[168px] items-center justify-center rounded-[var(--r-md)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.22)]">
        <p className="t-meta">Not enough ledger history to chart yet.</p>
      </div>
    );
  }

  const w = 640;
  const h = 168;
  const pad = 14;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0.0001);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${h - pad} L${x(0).toFixed(1)} ${h - pad} Z`;
  const positive = points[points.length - 1] >= 0;

  return (
    <div className="rounded-[var(--r-md)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.22)] p-3">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[168px] w-full" preserveAspectRatio="none" role="img" aria-label="Balance over the last ledger entries">
        <defs>
          <linearGradient id="econ-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={positive ? "#35e0a1" : "#ff9b9b"} stopOpacity="0.28" />
            <stop offset="100%" stopColor={positive ? "#35e0a1" : "#ff9b9b"} stopOpacity="0" />
          </linearGradient>
          <linearGradient id="econ-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#46c8e8" />
            <stop offset="100%" stopColor={positive ? "#35e0a1" : "#ff9b9b"} />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} x1={pad} x2={w - pad} y1={pad + t * (h - pad * 2)} y2={pad + t * (h - pad * 2)} stroke="rgba(255,255,255,0.055)" strokeWidth="1" />
        ))}
        <path d={area} fill="url(#econ-area)" />
        <path d={line} fill="none" stroke="url(#econ-line)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={x(points.length - 1)} cy={y(points[points.length - 1])} r="3.6" fill={positive ? "#35e0a1" : "#ff9b9b"} />
      </svg>
      <div className="t-micro mt-2 flex items-center justify-between px-1">
        <span>{entries.length} most recent entries</span>
        <span className="num">{usd(min)} → {usd(max)}</span>
      </div>
    </div>
  );
}

export default function EconomyPage() {
  const economy = useResource(() => api.economy(), []);
  // Also used by the invoiceable-revenue stat below, so the split between
  // collectible and placeholder revenue is visible at the top of the page and
  // not only inside the Earn panel.
  const earnRes = useResource(() => api.earn(), []);
  const campaigns = useResource(() => api.campaigns(), []);
  const settings = useResource(() => api.settings(), []);
  useDataSignal(earnRes.refresh);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [payoutAmount, setPayoutAmount] = useState("");
  const [payoutNote, setPayoutNote] = useState("");
  const [account, setAccount] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const [cTitle, setCTitle] = useState("");
  const [cText, setCText] = useState("");
  const [cUrl, setCUrl] = useState("");
  const [cKw, setCKw] = useState("");
  const [cCpm, setCCpm] = useState("2");
  const [cCpc, setCCpc] = useState("0.5");
  const [showCampaignForm, setShowCampaignForm] = useState(false);

  // Invoicing: which campaign's advertiser form is open, and its fields.
  const [invoiceFor, setInvoiceFor] = useState<string | null>(null);
  const [invName, setInvName] = useState("");
  const [invContact, setInvContact] = useState("");
  const [invTerms, setInvTerms] = useState<PaymentTerms>("net30");
  const [invIssued, setInvIssued] = useState("");

  // Settlement: which invoice's payment panel is open, and the receipt fields.
  const [payFor, setPayFor] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [payRef, setPayRef] = useState("");
  const [payDate, setPayDate] = useState("");

  // Collection: which provider is wired up, and a short-lived line about the
  // last thing the provider actually said (a link raised, a sync's outcome).
  const payments = useResource(() => api.payments(), []);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkNote, setLinkNote] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);

  const refreshAll = () => {
    economy.refresh();
    campaigns.refresh();
    payments.refresh();
    notifyDataChanged();
  };

  const collector = payments.data?.payments;
  const collectorLabel =
    collector?.provider === "stripe"
      ? "Stripe checkout"
      : collector?.provider === "link"
        ? "Static payment link"
        : "Not configured";

  /**
   * Ask the provider what has been paid. Only meaningful for Stripe, which the
   * app can read back; a static link returns an explanation rather than a
   * pretend success, and both are shown verbatim so a silent failure cannot be
   * mistaken for "nothing new".
   */
  const syncPayments = async () => {
    setLinkBusy(true);
    setLinkNote(null);
    try {
      const res = await api.syncPayments();
      const bits = [res.message];
      if (res.recorded.length) bits.push(`${res.recorded.length} new payment${res.recorded.length === 1 ? "" : "s"} recorded.`);
      if (res.needsAttention.length) bits.push(`${res.needsAttention.length} need${res.needsAttention.length === 1 ? "s" : ""} your attention.`);
      setLinkNote({ tone: res.ok ? (res.needsAttention.length ? "info" : "success") : "danger", text: bits.filter(Boolean).join(" ") });
      campaigns.refresh();
      payments.refresh();
      notifyDataChanged();
    } catch (err) {
      setLinkNote({ tone: "danger", text: errorMessage(err) });
    } finally {
      setLinkBusy(false);
    }
  };

  /** Raise a real payment page for the outstanding balance and keep it. */
  const raiseLink = async (campaignId: string, invoiceId: string) => {
    setLinkBusy(true);
    setLinkNote(null);
    try {
      const { link } = await api.createPayLink(campaignId);
      setLinkNote({
        tone: "success",
        text: `${link.provider === "stripe" ? "Stripe checkout" : "Payment link"} raised for ${invoiceId} — ${usd(link.amountUsd, 2)}.`,
      });
      campaigns.refresh();
    } catch (err) {
      setLinkNote({ tone: "danger", text: errorMessage(err) });
    } finally {
      setLinkBusy(false);
    }
  };

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setLinkNote({ tone: "success", text: `${what} copied.` });
    } catch {
      // Clipboard access can be refused outright; showing the text is the
      // fallback rather than a dead button.
      setLinkNote({ tone: "info", text: text });
    }
  };

  const e = economy.data;
  const earn = earnRes.data;
  const entries = e?.entries ?? [];
  const chartEntries = entries.slice(0, 40).reverse();

  const run = async (fn: () => Promise<unknown>, okMessage?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (okMessage) setMessage({ tone: "success", text: okMessage });
      refreshAll();
    } catch (err) {
      setMessage({ tone: "danger", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const gbp = false; // keep a single currency: everything is USD
  void gbp;

  // The headline figure is what is genuinely available to spend: revenue somebody
  // is actually on the hook to pay, minus what the models have cost and anything
  // already paid out. The ledger's running balance counts placeholder inventory —
  // seeded house campaigns with no advertiser behind them — which credits the
  // numbers exactly like real revenue and will never be paid by anybody. Calling
  // that "available" is how a fresh install reads as self-funded while it has
  // earned nothing, so both figures are shown and only one is called available.
  const availableUsd = earn?.spendableUsd ?? 0;
  const collectibleUsd = earn?.collectibleRevenueUsd ?? 0;
  const bookedUsd = earn?.confirmedRevenueUsd ?? e?.adRevenueUsd ?? 0;
  const placeholderUsd = earn?.placeholderRevenueUsd ?? 0;
  const funded = availableUsd >= 0 && collectibleUsd > 0;
  // The payout ceiling: collectible revenue minus spend and earlier payouts.
  const payable = Math.max(0, availableUsd);

  return (
    <div className="space-y-10">
      <SectionHeading
        eyebrow="Economy"
        title="What the ads earn and the models cost"
        hint="One ledger holds both sides. Revenue an advertiser will actually pay can be paid out; spend is what the agent really consumed."
      />

      {message && <Notice tone={message.tone} title={message.tone === "danger" ? "That didn’t work" : undefined}>{message.text}</Notice>}

      {economy.error ? (
        <ErrorState title="Can’t read the ledger" body={economy.error} onRetry={economy.refresh} retrying={economy.loading} />
      ) : (
        <>
          {/* ------------------------ balance hero ------------------------ */}
          <section className="glass-strong panel sheen relative overflow-hidden">
            <div
              className="pointer-events-none absolute -left-20 -top-28 h-72 w-72 rounded-full"
              style={{ background: "radial-gradient(circle at 50% 50%, rgba(53,224,161,0.16), transparent 70%)", filter: "blur(34px)" }}
            />
            <div className="relative grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
              <div>
                <div className="eyebrow">Available balance</div>
                {(economy.loading && !e) || (!earn && earnRes.loading) ? (
                  <Skeleton className="mt-4 h-14 w-56" />
                ) : (
                  <div className={`num mt-3 text-[54px] font-semibold leading-none tracking-[-0.03em] ${availableUsd < 0 ? "text-[#ff9b9b]" : "text-[var(--mint)]"}`}>
                    {usd(availableUsd)}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className={`chip ${funded ? "chip-mint" : "chip-amber"}`}>
                    <span className={funded ? "dot-live" : "dot-idle"} />
                    {funded ? "Self-funded" : "Not collection-funded yet"}
                  </span>
                  {e?.funding && <span className="chip">ads serving at {["relaxed", "steady", "tightened"][e.funding.adPressure] ?? "relaxed"} cadence</span>}
                  <span className="chip" title={e?.delivery.networkStatus.text}>
                    {e?.delivery.network === "ethicalads" ? `Network · ${e.delivery.networkStatus.reason.replace(/-/g, " ")}` : "First-party campaigns"}
                  </span>
                  {placeholderUsd > 0.0001 && (
                    <span
                      className="chip"
                      title="Booked from seeded house campaigns with no advertiser behind them. It shows in the ledger but nobody will ever pay it, and it cannot fund model calls."
                    >
                      {usd(bookedUsd)} booked, not collectible
                    </span>
                  )}
                </div>
                <p className="t-meta mt-5 max-w-[46ch]">
                  Available is ad revenue somebody is actually on the hook to pay, minus everything the models have cost and anything already
                  paid out. It rises when sponsored cards are served and clicked, and falls as the agent works. Booked revenue from placeholder
                  inventory is counted in the ledger but shown separately here, because it will never settle a bill.
                </p>
              </div>

              <div>
                <div className="eyebrow mb-3">Balance trend</div>
                <BalanceChart entries={chartEntries} balance={e?.balanceUsd ?? 0} />
              </div>
            </div>

            <div className="relative mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label="Invoiceable revenue"
                value={usd(earn?.collectibleRevenueUsd ?? 0)}
                tone="mint"
                hint={
                  (earn?.placeholderRevenueUsd ?? 0) > 0.0001
                    ? `${usd(earn?.placeholderRevenueUsd ?? 0)} more is booked from placeholder inventory, which nobody will pay`
                    : "Backed by advertisers and networks that will actually pay"
                }
                loading={(economy.loading && !e) || (!earn && earnRes.loading)}
              />
              <Stat label="Pending revenue" value={usd(e?.estimatedRevenueUsd ?? 0)} tone="amber" hint="Network impressions awaiting their statement" loading={economy.loading && !e} />
              <Stat label="AI spend" value={usd(e?.spendUsd ?? 0)} hint="Metered per call, at the provider's own reported cost" loading={economy.loading && !e} />
              <Stat
                label="Booked revenue"
                value={usd((e?.adRevenueUsd ?? 0) - (e?.payoutsUsd ?? 0))}
                hint={
                  placeholderUsd > 0.0001
                    ? `Includes ${usd(placeholderUsd)} from placeholder inventory that will never be paid`
                    : `${usd(e?.payoutsUsd ?? 0)} already paid out`
                }
                loading={(economy.loading && !e) || (!earn && earnRes.loading)}
              />
            </div>
          </section>

          {/* The one place revenue is deliberately built up, plus what the
              reserve-tier models need. */}
          <EarnPanel />

          {/* -------------------------- activity -------------------------- */}
          <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div>
              <SectionHeading eyebrow="Activity" title="Ledger entries" hint="Newest first. Impressions, clicks, reconciliation and every metered call." />
              {economy.loading && !e ? (
                <div className="space-y-3">
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                  <Skeleton className="h-12" />
                </div>
              ) : entries.length ? (
                <div className="glass panel px-5 py-2">
                  {entries.slice(0, 14).map((entry) => (
                    <ActivityRow key={entry.id} entry={entry} />
                  ))}
                </div>
              ) : (
                <EmptyState icon={<IconWallet size={18} />} title="No ledger entries yet" body="Serve a sponsored card or run the agent and entries appear here." compact />
              )}
            </div>

            <div>
              <SectionHeading eyebrow="Payouts" title="Move revenue out" hint="Only revenue somebody will actually pay can be paid out — pending network money must be reconciled first, and placeholder inventory never qualifies." />
              <div className="glass panel space-y-5">
                <div>
                  <div className="t-meta">Available to pay out</div>
                  {/* Collectible revenue minus spend and earlier payouts. The
                      ledger's own figure includes placeholder inventory, which
                      no advertiser will ever pay into this account. */}
                  <div className={`num mt-1.5 text-[26px] font-semibold ${payable > 0 ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}`}>{usd(payable)}</div>
                  {payable <= 0 && (
                    <p className="t-micro mt-1.5 max-w-[34ch]">
                      {collectibleUsd > 0
                        ? "Everything collectible so far has been spent on model calls or already paid out."
                        : "No advertiser or network revenue yet, so there is nothing to move out. Placeholder inventory cannot be paid out."}
                    </p>
                  )}
                </div>

                <button
                  className="btn btn-glass btn-sm w-full"
                  disabled={busy || !((e?.estimatedRevenueUsd ?? 0) > 0)}
                  onClick={() => run(() => api.reconcile(), "Pending network revenue reconciled into confirmed.")}
                >
                  <IconCheck size={13} />
                  Confirm {usd(e?.estimatedRevenueUsd ?? 0)} pending
                </button>

                <div className="hairline" />

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="field-label">Amount (USD)</label>
                    <input className="input num" value={payoutAmount} onChange={(ev) => setPayoutAmount(ev.target.value)} placeholder={payable.toFixed(2)} />
                  </div>
                  <div>
                    <label className="field-label">Note</label>
                    <input className="input" value={payoutNote} onChange={(ev) => setPayoutNote(ev.target.value)} placeholder="EthicalAds → bank, Sept" />
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-sm w-full"
                  disabled={busy || !(Number(payoutAmount) > 0)}
                  onClick={() =>
                    run(async () => {
                      await api.payout(Number(payoutAmount), payoutNote || undefined);
                      setPayoutAmount("");
                      setPayoutNote("");
                    }, "Payout recorded — that revenue can no longer fund API spend.")
                  }
                >
                  Record payout
                </button>

                <div className="hairline" />

                <div>
                  <label className="field-label">Account the money lands in</label>
                  <input
                    className="input"
                    value={account || settings.data?.payoutAccount || ""}
                    onChange={(ev) => setAccount(ev.target.value)}
                    onBlur={() => {
                      if (account && account !== settings.data?.payoutAccount) {
                        void run(() => api.setPayoutAccount(account), "Payout account saved.");
                      }
                    }}
                    placeholder="Wise ··4821 or paypal.me/you"
                  />
                  <p className="t-micro mt-2">Stamped on payout entries so the ledger shows where each dollar went.</p>
                </div>
              </div>
            </div>
          </section>

          {/* -------------------------- campaigns ------------------------- */}
          <section>
            <SectionHeading
              eyebrow="Advertising"
              title="Campaigns"
              hint="Every impression a campaign delivers is booked to the ledger. It only becomes money you can spend once a paying advertiser is behind it and its invoice is issued — score the split below."
              action={
                <button className="btn btn-glass btn-sm" onClick={() => setShowCampaignForm((s) => !s)}>
                  <IconPlus size={13} />
                  New campaign
                </button>
              }
            />

            {campaigns.data && (
              <>
                <div className="glass panel mb-5 grid gap-4 sm:grid-cols-3">
                  <div>
                    <div className="eyebrow">Collectible</div>
                    <div className="num mt-1.5 text-[19px] text-[var(--mint)]">{usd(campaigns.data.revenue.collectibleUsd)}</div>
                    <div className="t-micro mt-1">
                      {campaigns.data.revenue.backedCampaignIds.length} campaign{campaigns.data.revenue.backedCampaignIds.length === 1 ? "" : "s"} invoiced — this is what may pay for models
                    </div>
                  </div>
                  <div>
                    <div className="eyebrow">Unbilled</div>
                    <div className="num mt-1.5 text-[19px] text-[var(--text-3)]">{usd(campaigns.data.revenue.placeholderUsd)}</div>
                    <div className="t-micro mt-1">
                      {campaigns.data.billing.filter((b) => !b.backed).length} campaign{campaigns.data.billing.filter((b) => !b.backed).length === 1 ? "" : "s"} with nobody on the hook for it
                    </div>
                  </div>
                  <div>
                    <div className="eyebrow">Booked total</div>
                    <div className="num mt-1.5 text-[19px] text-[var(--text-1)]">{usd(campaigns.data.revenue.confirmedUsd)}</div>
                    <div className="t-micro mt-1">what the ledger shows, billed or not</div>
                  </div>
                </div>

                {/*
                  Receivables, kept separate from the ledger on purpose. Invoiced
                  money is not money in hand until a payment is recorded against
                  it, and the two are easiest to confuse exactly when it matters.
                */}
                {campaigns.data.receivables.invoiceCount > 0 && (
                  <div className="glass panel mb-5 grid gap-4 sm:grid-cols-4">
                    <div>
                      <div className="eyebrow">Invoiced</div>
                      <div className="num mt-1.5 text-[19px] text-[var(--text-1)]">{usd(campaigns.data.receivables.invoicedUsd, 2)}</div>
                      <div className="t-micro mt-1">
                        across {campaigns.data.receivables.invoiceCount} invoice{campaigns.data.receivables.invoiceCount === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div>
                      <div className="eyebrow">Collected</div>
                      <div className="num mt-1.5 text-[19px] text-[var(--mint)]">{usd(campaigns.data.receivables.collectedUsd, 2)}</div>
                      <div className="t-micro mt-1">real payments recorded — actually in hand</div>
                    </div>
                    <div>
                      <div className="eyebrow">Outstanding</div>
                      <div className="num mt-1.5 text-[19px] text-[var(--text-1)]">{usd(campaigns.data.receivables.outstandingUsd, 2)}</div>
                      <div className="t-micro mt-1">invoiced but not yet received</div>
                    </div>
                    <div>
                      <div className="eyebrow">Overdue</div>
                      <div className={`num mt-1.5 text-[19px] ${campaigns.data.receivables.overdueUsd > 0 ? "text-[var(--amber)]" : "text-[var(--text-3)]"}`}>
                        {usd(campaigns.data.receivables.overdueUsd, 2)}
                      </div>
                      <div className="t-micro mt-1">
                        {campaigns.data.receivables.overdueCount === 0
                          ? "nothing past its terms"
                          : `${campaigns.data.receivables.overdueCount} invoice${campaigns.data.receivables.overdueCount === 1 ? "" : "s"} past its terms`}
                      </div>
                    </div>
                    {/*
                      These two questions have different answers and it matters
                      which one the reserve tier uses. Billing is what you billed;
                      the gate counts delivered impressions, because a typed-in
                      total must never be able to unlock spending by itself.
                    */}
                    <p className="t-micro sm:col-span-4">
                      What you have billed, which is not the same figure the reserve tier spends against: that one counts what the campaigns
                      actually delivered, so an invoiced total cannot unlock models on its own. Invoice an amount above what the ads accrues and
                      the difference is real money owed to you — it just is not spendable here until the impressions back it.
                    </p>
                  </div>
                )}
              </>
            )}

            {showCampaignForm && (
              <div className="glass panel rise mb-5">
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  <div>
                    <label className="field-label">Headline</label>
                    <input className="input" value={cTitle} onChange={(ev) => setCTitle(ev.target.value)} placeholder="The AI code reviewer" />
                  </div>
                  <div>
                    <label className="field-label">Destination URL</label>
                    <input className="input" value={cUrl} onChange={(ev) => setCUrl(ev.target.value)} placeholder="https://advertiser.com" />
                  </div>
                  <div>
                    <label className="field-label">Description</label>
                    <input className="input" value={cText} onChange={(ev) => setCText(ev.target.value)} placeholder="One line of ad copy" />
                  </div>
                  <div>
                    <label className="field-label">Targeting keywords</label>
                    <input className="input" value={cKw} onChange={(ev) => setCKw(ev.target.value)} placeholder="code, review, test" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="field-label">CPM (USD/1k)</label>
                      <input className="input num" value={cCpm} onChange={(ev) => setCCpm(ev.target.value)} />
                    </div>
                    <div>
                      <label className="field-label">CPC (USD)</label>
                      <input className="input num" value={cCpc} onChange={(ev) => setCCpc(ev.target.value)} />
                    </div>
                  </div>
                </div>
                <button
                  className="btn btn-accent btn-sm mt-5"
                  disabled={busy || !cTitle.trim() || !cUrl.trim()}
                  onClick={() =>
                    run(async () => {
                      await api.addCampaign({
                        title: cTitle,
                        adText: cText,
                        url: cUrl,
                        keywords: cKw.split(",").map((s) => s.trim()).filter(Boolean),
                        cpmUsd: Number(cCpm) || 2,
                        cpcUsd: Number(cCpc) || 0.5,
                      });
                      setCTitle("");
                      setCText("");
                      setCUrl("");
                      setCKw("");
                      setShowCampaignForm(false);
                    }, "Campaign created — it is eligible to serve on the next tool step.")
                  }
                >
                  Create campaign
                </button>
              </div>
            )}

            {campaigns.error ? (
              <ErrorState body={campaigns.error} onRetry={campaigns.refresh} retrying={campaigns.loading} />
            ) : (campaigns.data?.billing ?? []).length ? (
              <div className="glass panel p-2">
                {(campaigns.data?.billing ?? []).map((c) => {
                  const inv = c.invoice;
                  const st = c.settlement;
                  // Due date and lateness come from the server's terms arithmetic,
                  // so the badge cannot disagree with what the invoice says.
                  const dueOn = st ? new Date(st.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
                  return (
                    <div key={c.id} className="rounded-[var(--r-md)] px-4 py-3.5 transition-colors hover:bg-[rgba(255,255,255,0.035)]">
                      <div className="flex flex-wrap items-center gap-4">
                        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r-xs)] border ${c.backed ? "border-[rgba(53,224,161,0.35)] text-[var(--mint)]" : "border-[var(--border-1)] text-[var(--text-3)]"}`}>
                          <IconInvoice size={16} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13.5px] text-[var(--text-1)]">{c.title}</span>
                            <span className={`chip ${c.active ? "chip-mint" : "chip-muted"}`}>{c.active ? "active" : "paused"}</span>
                            {c.backed ? (
                              st?.state === "overdue" ? (
                                <span className="chip chip-amber" title={`${usd(st.balanceUsd)} was due ${dueOn}`}>
                                  overdue {st.daysOverdue}d
                                </span>
                              ) : st?.state === "paid" ? (
                                <span className={`chip ${st.unbacked ? "chip-amber" : "chip-mint"}`} title={st.unbacked ? "Marked paid, but no payment with real detail is recorded" : `Settled in full from ${st.verifiedPayments} payment(s)${inv?.paidAt ? ` on ${new Date(inv.paidAt).toLocaleDateString()}` : ""}`}>
                                  {st.unbacked ? "paid (unverified)" : "invoiced · paid"}
                                </span>
                              ) : st?.state === "partial" ? (
                                <span className="chip" title={`${usd(st.paidUsd, 2)} received of ${usd(inv?.amountUsd ?? 0, 2)}`}>
                                  part paid
                                </span>
                              ) : (
                                <span className="chip chip-mint">invoiced</span>
                              )
                            ) : (
                              <span className="chip chip-muted" title="Impressions are booked, but nobody is going to pay for them">unbilled</span>
                            )}
                          </div>
                          <div className="t-micro mt-1 truncate">
                            {c.advertiser} · {c.impressions} impressions · {c.clicks} clicks · {usd(c.deliveredUsd)} delivered
                            {c.backed && inv ? ` · ${inv.invoiceId} for ${usd(inv.amountUsd, 2)} (${inv.terms})` : ""}
                            {c.backed && st ? ` · ${usd(st.paidUsd, 2)} received · ${usd(st.balanceUsd, 2)} outstanding` : ""}
                            {c.backed && st && st.state !== "paid" ? ` · due ${dueOn}` : ""}
                            {c.uninvoicedUsd > 0.0001 ? ` · ${usd(c.uninvoicedUsd)} delivered since invoicing` : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {c.backed && inv && st && st.state !== "paid" && (
                            <button
                              className="btn btn-accent btn-sm"
                              onClick={() => {
                                setPayFor(payFor === c.id ? null : c.id);
                                // Prefilled with the outstanding balance, which is
                                // what arrives in the common case; a partial is
                                // just an edit.
                                setPayAmount(st.balanceUsd.toFixed(2));
                                setPayMethod("");
                                setPayRef("");
                                setPayDate(new Date().toISOString().slice(0, 10));
                              }}
                            >
                              <IconWallet size={13} />
                              Record payment
                            </button>
                          )}
                          {c.backed && inv && st && st.state === "paid" && (inv.payments?.length ?? 0) > 0 && (
                            <button className="btn btn-quiet btn-sm" onClick={() => setPayFor(payFor === c.id ? null : c.id)}>
                              Receipt{(inv.payments?.length ?? 0) === 1 ? "" : "s"}
                            </button>
                          )}
                          {c.backed ? (
                            <button
                              className="btn btn-quiet btn-sm"
                              disabled={busy}
                              onClick={() => run(() => api.detachAdvertiser(c.id), "Advertiser removed — the campaign's revenue is unbilled again.")}
                            >
                              Unbilled
                            </button>
                          ) : (
                            <button
                              className="btn btn-glass btn-sm"
                              onClick={() => {
                                setInvoiceFor(invoiceFor === c.id ? null : c.id);
                                setInvName(c.advertiser.startsWith("Example") ? "" : c.advertiser);
                                setInvContact("");
                                setInvTerms("net30");
                                setInvIssued("");
                              }}
                            >
                              <IconInvoice size={13} />
                              Invoice advertiser
                            </button>
                          )}
                          <button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => run(() => api.setCampaignActive(c.id, !c.active))}>
                            {c.active ? "Pause" : "Resume"}
                          </button>
                          {confirmDelete === c.id ? (
                            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => run(async () => { await api.removeCampaign(c.id); setConfirmDelete(null); }, "Campaign deleted.")}>
                              <IconCheck size={13} />
                              Confirm
                            </button>
                          ) : (
                            <button className="btn btn-quiet btn-sm" onClick={() => setConfirmDelete(c.id)}>
                              Delete
                            </button>
                          )}
                        </div>
                      </div>

                      {invoiceFor === c.id && (
                        <div className="rise mt-3 rounded-[var(--r-md)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.24)] p-4">
                          <p className="t-micro mb-3 leading-relaxed">
                            Name the advertiser who owes for this campaign. The invoice is raised for what it has already delivered —
                            <span className="num text-[var(--mint)]"> {usd(c.deliveredUsd)}</span> at the current CPM — and its revenue moves from
                            booked to collectible, which is what unlocks reserve-tier models.
                          </p>
                          <div className="grid gap-3 md:grid-cols-4">
                            <div>
                              <label className="field-label">Advertiser</label>
                              <input className="input" value={invName} onChange={(ev) => setInvName(ev.target.value)} placeholder="Acme Infrastructure Inc." />
                            </div>
                            <div>
                              <label className="field-label">Billing contact</label>
                              <input className="input" value={invContact} onChange={(ev) => setInvContact(ev.target.value)} placeholder="billing@acme.com" />
                            </div>
                            <div>
                              <label className="field-label">Terms</label>
                              <select className="input" value={invTerms} onChange={(ev) => setInvTerms(ev.target.value as PaymentTerms)}>
                                <option value="prepaid">Prepaid</option>
                                <option value="net15">Net 15</option>
                                <option value="net30">Net 30</option>
                                <option value="net60">Net 60</option>
                              </select>
                            </div>
                            <div>
                              {/* Blank means today. Set it when you are entering an
                                  invoice that went out earlier, so its due date —
                                  and therefore whether it is late — is right. */}
                              <label className="field-label">Issued</label>
                              <input className="input" type="date" value={invIssued} onChange={(ev) => setInvIssued(ev.target.value)} />
                            </div>
                          </div>
                          <div className="mt-3 flex items-center gap-2">
                            <button
                              className="btn btn-accent btn-sm"
                              disabled={busy || !invName.trim()}
                              onClick={() =>
                                run(async () => {
                                  await api.invoiceCampaign(c.id, {
                                    name: invName,
                                    contact: invContact,
                                    terms: invTerms,
                                    status: "issued",
                                    ...(invIssued ? { issuedAt: new Date(`${invIssued}T12:00:00`).getTime() } : {}),
                                  });
                                  setInvoiceFor(null);
                                }, "Invoice issued — this campaign's revenue now counts as collectible.")
                              }
                            >
                              Issue invoice
                            </button>
                            <button className="btn btn-quiet btn-sm" onClick={() => setInvoiceFor(null)}>
                              Cancel
                            </button>
                            {c.deliveredUsd <= 0.0001 && (
                              <span className="t-micro">Nothing delivered yet — the invoice will record $0.00 until impressions land.</span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* ---- settlement: receipts and recording a payment ---- */}
                      {payFor === c.id && inv && st && (
                        <div className="rise mt-3 rounded-[var(--r-md)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.24)] p-4">
                          <div className="flex flex-wrap items-baseline justify-between gap-3">
                            <div>
                              <div className="field-label">Outstanding on {inv.invoiceId}</div>
                              <div className={`num text-[22px] ${st.overdue ? "text-[var(--amber)]" : "text-[var(--text-1)]"}`}>
                                {usd(st.balanceUsd, 2)}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="t-micro">
                                {usd(st.paidUsd, 2)} of {usd(inv.amountUsd, 2)} received
                              </div>
                              <div className="t-micro mt-0.5">
                                {st.state === "paid"
                                  ? st.unbacked
                                    ? "Marked paid with no payment detail recorded"
                                    : `Settled from ${st.verifiedPayments} payment${st.verifiedPayments === 1 ? "" : "s"}${inv.paidAt ? ` on ${new Date(inv.paidAt).toLocaleDateString()}` : ""}`
                                  : st.overdue
                                    ? `Was due ${dueOn} — ${st.daysOverdue} day${st.daysOverdue === 1 ? "" : "s"} late`
                                    : `Due ${dueOn}`}
                              </div>
                            </div>
                          </div>

                          {/* ---- getting paid: the link the advertiser uses ---- */}
                          <div className="mt-4 rounded-[var(--r-md)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.18)] p-3">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="field-label mb-0">Payment link</span>
                              <span className="t-micro">via {collectorLabel}</span>
                              <button
                                className="btn btn-glass btn-sm ml-auto"
                                disabled={linkBusy || collector?.provider === "none"}
                                title={
                                  collector?.provider === "stripe"
                                    ? "Ask Stripe which sessions have been paid and record the new ones."
                                    : collector?.provider === "link"
                                      ? "A static link cannot be checked automatically — record the payment when it lands."
                                      : "No provider is configured yet."
                                }
                                onClick={syncPayments}
                              >
                                Check for payments
                              </button>
                            </div>

                            {inv.payLink ? (
                              <>
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <button
                                    className="btn btn-glass btn-sm max-w-full"
                                    title={inv.payLink.url}
                                    onClick={() => copyText(inv.payLink?.url ?? "", "Payment link")}
                                  >
                                    <IconExternal size={13} />
                                    <span className="truncate">{new URL(inv.payLink.url).host}</span>
                                  </button>
                                  <a className="btn btn-quiet btn-sm" href={inv.payLink.url} target="_blank" rel="noreferrer">
                                    Open
                                  </a>
                                  <button
                                    className="btn btn-quiet btn-sm"
                                    disabled={busy}
                                    onClick={() =>
                                      run(async () => {
                                        const { text } = await api.invoiceMessage(c.id);
                                        await copyText(text, "Invoice message");
                                      })
                                    }
                                  >
                                    Copy invoice email
                                  </button>
                                  {/*
                                    Only when there is still something to collect
                                    and the link no longer matches it. Offering a
                                    re-raise on a settled invoice would ask the
                                    advertiser for $0.00.
                                  */}
                                  {st.balanceUsd > 0.005 && Math.abs(inv.payLink.amountUsd - st.balanceUsd) > 0.005 && (
                                    <button
                                      className="btn btn-accent btn-sm"
                                      disabled={linkBusy}
                                      onClick={() => raiseLink(c.id, inv.invoiceId)}
                                    >
                                      Re-raise for {usd(st.balanceUsd, 2)}
                                    </button>
                                  )}
                                </div>
                                <p className="t-micro mt-2">
                                  Raised {new Date(inv.payLink.createdAt).toLocaleDateString()} for {usd(inv.payLink.amountUsd, 2)}
                                  {st.balanceUsd <= 0.005
                                    ? " and this invoice is settled — there is nothing left to collect on it."
                                    : Math.abs(inv.payLink.amountUsd - st.balanceUsd) > 0.005
                                      ? ` — the outstanding balance is now ${usd(st.balanceUsd, 2)}, so re-raise it before sending this link again.`
                                      : "."}{" "}
                                  {inv.payLink.provider === "stripe"
                                    ? "Stripe can be read back, so a payment made here records itself."
                                    : "A static link cannot be read back — record the payment when it arrives."}
                                </p>
                              </>
                            ) : (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <button
                                  className="btn btn-accent btn-sm"
                                  disabled={linkBusy || collector?.provider === "none"}
                                  onClick={() => raiseLink(c.id, inv.invoiceId)}
                                >
                                  <IconExternal size={13} />
                                  Create payment link for {usd(st.balanceUsd, 2)}
                                </button>
                                <span className="t-micro">
                                  {collector?.provider === "none"
                                    ? "No provider configured — add one in Settings → Payments first."
                                    : collector?.provider === "stripe"
                                      ? "A Stripe checkout page for exactly the outstanding balance."
                                      : "Sends the advertiser to your own payment URL."}
                                </span>
                              </div>
                            )}

                            {linkNote && (
                              <p className={`t-micro mt-2 ${linkNote.tone === "danger" ? "text-[#ff9b9b]" : linkNote.tone === "success" ? "text-[var(--mint)]" : ""}`}>
                                {linkNote.text}
                              </p>
                            )}
                          </div>

                          {(inv.payments?.length ?? 0) > 0 && (
                            <div className="mt-4 space-y-1.5">
                              {(inv.payments ?? []).map((p) => (
                                <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-[var(--r-xs)] border border-[var(--border-1)] px-3 py-2">
                                  <span className="num text-[13px] text-[var(--mint)]">{usd(p.amountUsd, 2)}</span>
                                  <span className="t-micro">{new Date(p.receivedAt).toLocaleDateString()}</span>
                                  <span className="t-micro">{p.method}</span>
                                  {/*
                                    Where the receipt came from matters: a Stripe
                                    payment was read back from the provider, the
                                    rest were typed in by hand. Without this the two
                                    look identical, which is exactly the confusion
                                    `unbacked` exists to prevent.
                                  */}
                                  {p.source && p.source !== "manual" && (
                                    <span className="chip chip-mint" title={p.source === "stripe" ? "Read back from Stripe — machine-verified" : "Matched to a static payment link by hand"}>
                                      {p.source === "stripe" ? "from Stripe" : "from link"}
                                    </span>
                                  )}
                                  {p.reference && <span className="t-micro mono">{p.reference}</span>}
                                  {p.note && <span className="t-micro flex-1 truncate">{p.note}</span>}
                                  <button
                                    className="btn btn-quiet btn-sm btn-danger ml-auto"
                                    disabled={busy}
                                    onClick={() => run(() => api.removeInvoicePayment(c.id, p.id), "Receipt removed — the outstanding balance moved back up.")}
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}

                          {st.state !== "paid" && (
                            <div className="mt-4">
                              <div className="grid gap-3 md:grid-cols-4">
                                <div>
                                  <label className="field-label">Amount received</label>
                                  <input className="input num" value={payAmount} onChange={(ev) => setPayAmount(ev.target.value)} inputMode="decimal" />
                                </div>
                                <div>
                                  <label className="field-label">Date received</label>
                                  <input className="input" type="date" value={payDate} onChange={(ev) => setPayDate(ev.target.value)} />
                                </div>
                                <div>
                                  <label className="field-label">Method</label>
                                  <input className="input" value={payMethod} onChange={(ev) => setPayMethod(ev.target.value)} placeholder="ACH, card, wire…" />
                                </div>
                                <div>
                                  <label className="field-label">Reference</label>
                                  <input className="input" value={payRef} onChange={(ev) => setPayRef(ev.target.value)} placeholder="Bank / txn id" />
                                </div>
                              </div>
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <button
                                  className="btn btn-accent btn-sm"
                                  disabled={busy || !(Number(payAmount) > 0)}
                                  onClick={() =>
                                    run(async () => {
                                      await api.recordInvoicePayment(c.id, {
                                        amountUsd: Number(payAmount),
                                        ...(payDate ? { receivedAt: new Date(`${payDate}T12:00:00`).getTime() } : {}),
                                        ...(payMethod.trim() ? { method: payMethod.trim() } : {}),
                                        ...(payRef.trim() ? { reference: payRef.trim() } : {}),
                                      });
                                      setPayFor(null);
                                    }, `Payment recorded against ${inv.invoiceId}.`)
                                  }
                                >
                                  <IconCheck size={13} />
                                  Record payment
                                </button>
                                <button
                                  className="btn btn-quiet btn-sm"
                                  disabled={busy}
                                  title="Settles the balance without payment detail — the receipt will say so."
                                  onClick={() => run(() => api.setInvoiceStatus(c.id, "paid"), `${inv.invoiceId} marked paid.`)}
                                >
                                  Mark paid in full
                                </button>
                                <button className="btn btn-quiet btn-sm" onClick={() => setPayFor(null)}>
                                  Close
                                </button>
                                <span className="t-micro">Payments do not move the ledger — this revenue was already booked when the ads ran.</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={<IconBolt size={18} />}
                title="No campaigns"
                body="Create one and it serves inline as the agent works — impressions and clicks land on the ledger immediately."
                action={
                  <button className="btn btn-glass btn-sm" onClick={() => setShowCampaignForm(true)}>
                    New campaign
                  </button>
                }
                compact
              />
            )}

            <p className="t-micro mt-4">
              Delivered so far: {campaigns.data?.billing.reduce((n, c) => n + c.impressions, 0) ?? 0} impressions ·{" "}
              {campaigns.data?.billing.reduce((n, c) => n + c.clicks, 0) ?? 0} clicks · last entry {entries[0] ? clockTime(entries[0].ts) : "—"}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
