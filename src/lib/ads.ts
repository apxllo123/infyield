import type {
  AdCampaign,
  AdvertiserAccount,
  AdsSettings,
  InvoicePayLink,
  InvoicePayment,
  InvoiceSettlementState,
  InvoiceStatus,
  PaymentSource,
  PaymentTerms,
  SponsoredAd,
} from "./types";
import { readJson, withFileLock, writeJson } from "./store";
import { allEntries, creditAdRevenue, creditEstimatedRevenue, getState } from "./economy";
import { getSettings } from "./settings";
import { logEvent } from "./log";
import {
  ackNetworkImpression,
  ackNetworkViewTime,
  fetchCarbonAds,
  fetchEthicalAds,
  networkConfigured,
  networkReasonText,
  networkState,
  recordNetworkOutcome,
} from "./networks";
import {
  checkAdFrequency,
  recordAdEvent,
  type ClientFamily,
  type FrequencyVerdict,
} from "./adlifecycle";

const FILE = "campaigns.json";

// ---------- Campaign store ----------

function load(): AdCampaign[] {
  return readJson<AdCampaign[]>(FILE, []);
}

function save(c: AdCampaign[]): void {
  writeJson(FILE, c);
}

export function listCampaigns(): AdCampaign[] {
  return load();
}

export function addCampaign(
  input: Omit<AdCampaign, "id" | "impressions" | "clicks" | "spentUsd" | "createdAt">,
): AdCampaign {
  const cs = load();
  const c: AdCampaign = { ...input, id: crypto.randomUUID(), impressions: 0, clicks: 0, spentUsd: 0, createdAt: Date.now() };
  cs.push(c);
  save(cs);
  return c;
}

export function updateCampaign(id: string, patch: Partial<AdCampaign>): AdCampaign | undefined {
  const cs = load();
  const i = cs.findIndex((c) => c.id === id);
  if (i === -1) return undefined;
  cs[i] = { ...cs[i], ...patch, id };
  save(cs);
  return cs[i];
}

export function deleteCampaign(id: string): boolean {
  const cs = load();
  const next = cs.filter((c) => c.id !== id);
  save(next);
  return next.length !== cs.length;
}

// ---------- Contextual targeting (Freebuff sends sanitized message history) ----------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Score campaigns against recent conversation context; weight is the base. */
export function scoreCampaigns(campaigns: AdCampaign[], context: string): AdCampaign[] {
  const words = new Set(tokenize(context));
  return campaigns
    .filter((c) => c.active && c.url.trim() !== "")
    .filter((c) => c.budgetUsd <= 0 || c.spentUsd < c.budgetUsd)
    .map((c) => {
      let score = c.weight;
      for (const kw of c.keywords) if (words.has(kw.toLowerCase())) score += 10;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

// ---------- Seed house ads so the system works out of the box ----------

/**
 * Is this campaign demonstration inventory with no advertiser behind it?
 *
 * Seeded campaigns credit the ledger exactly like real ones, so anything that
 * decides how much money may be spent has to exclude them — otherwise the app
 * would happily pay a real provider bill with revenue that will never arrive.
 *
 * The flag is checked first, but the example.com/advertiser heuristic also
 * covers campaigns seeded before the flag existed and already sitting on disk.
 *
 * An explicit advertiser account with an issued invoice overrides all of that:
 * once somebody is invoiced for a campaign, only the invoice decides whether the
 * money is real, and the seed heuristic must not keep calling it fake.
 */
export function isPlaceholderCampaign(c: AdCampaign): boolean {
  if (isAdvertiserBacked(c)) return false;
  if (c.isPlaceholder) return true;
  return domainOf(c.url).endsWith("example.com") || c.advertiser.trim().toLowerCase().startsWith("example ");
}

// ------------------------- advertisers & invoicing -------------------------
//
// The difference between "the ledger says "2.81 was earned" and "somebody is
// going to pay 2.81". A campaign becomes *backed* when it has a named
// advertiser and an invoice that has been issued (or paid) for it. Revenue
// attributable to a backed campaign is collectible, and collectible revenue is
// the only money allowed to buy reserve-tier models — see src/lib/funds.ts.

/** True when a paying advertiser is on record with an issued/paid invoice. */
export function isAdvertiserBacked(c: AdCampaign): boolean {
  const a = c.advertiserAccount;
  if (!a) return false;
  if (!a.name.trim() || !a.invoiceId.trim()) return false;
  return a.status === "issued" || a.status === "paid";
}

/**
 * What a campaign has actually delivered, from the ledger rather than from a
 * counter: the sum of every impression/click entry attributed to it. Network
 * entries carry no campaign id and are not attributable here.
 */
export function campaignAccrualUsd(campaignId: string): number {
  let total = 0;
  for (const e of allEntries()) {
    if (e.kind !== "ad-impression" && e.kind !== "ad-click") continue;
    if (e.campaignId !== campaignId) continue;
    total += e.delta;
  }
  return total;
}

export interface InvoiceInput {
  name: string;
  contact?: string;
  terms?: PaymentTerms;
  status?: InvoiceStatus;
  /** Defaults to what the campaign has delivered so far. */
  amountUsd?: number;
  note?: string;
  /** Reuse an existing reference instead of minting a new one. */
  invoiceId?: string;
  /**
   * When the invoice was actually issued. Defaults to now, but entering an
   * invoice days after it went out is normal, and the due date has to follow the
   * real issue date or an overdue invoice reads as freshly issued.
   */
  issuedAt?: number;
}

/** Next sequential invoice reference, e.g. INV-2026-0007. */
function nextInvoiceId(campaigns: AdCampaign[]): string {
  const year = new Date().getFullYear();
  let highest = 0;
  for (const c of campaigns) {
    const m = /^INV-(\d{4})-(\d+)$/.exec(c.advertiserAccount?.invoiceId ?? "");
    if (m) highest = Math.max(highest, Number(m[2]));
  }
  return `INV-${year}-${String(highest + 1).padStart(4, "0")}`;
}

/**
 * Put a paying advertiser behind a campaign and record the invoice for it.
 *
 * The amount defaults to the campaign's real accrual (what the ads delivered),
 * so invoicing is a statement of fact rather than a number someone typed. This
 * is what flips the campaign out of placeholder inventory and makes its revenue
 * collectible.
 */
export function attachAdvertiser(campaignId: string, input: InvoiceInput): AdCampaign | { error: string } {
  const cs = load();
  const c = cs.find((x) => x.id === campaignId);
  if (!c) return { error: "Campaign not found." };
  const name = String(input.name ?? "").trim();
  if (!name) return { error: "Advertiser name is required." };
  if (name.toLowerCase().startsWith("example ")) {
    return { error: "That looks like placeholder copy — use the real advertiser's name." };
  }
  const delivered = campaignAccrualUsd(campaignId);
  const account: AdvertiserAccount = {
    name,
    contact: String(input.contact ?? "").trim(),
    invoiceId: String(input.invoiceId ?? "").trim() || nextInvoiceId(cs),
    amountUsd: Number.isFinite(Number(input.amountUsd)) ? Number(input.amountUsd) : round2(delivered),
    terms: input.terms ?? "net30",
    status: input.status ?? "issued",
    // Backdating is allowed (invoices are often entered late); postdating is not,
    // since an invoice cannot have been issued in the future.
    issuedAt: Number.isFinite(Number(input.issuedAt)) ? Math.min(Number(input.issuedAt), Date.now()) : Date.now(),
    ...(input.status === "paid" ? { paidAt: Date.now() } : {}),
    ...(input.note ? { note: String(input.note) } : {}),
  };
  c.advertiserAccount = account;
  c.advertiser = name; // the invoiced party is the advertiser we display
  delete c.isPlaceholder; // explicitly real from here on
  save(cs);
  return c;
}

/* ------------------------------ settlement ------------------------------- */

const DAY_MS = 86_400_000;

/** How long a term allows before the invoice is late. Prepaid is due on issue. */
export function termsDays(terms: PaymentTerms): number {
  switch (terms) {
    case "prepaid":
      return 0;
    case "net15":
      return 15;
    case "net60":
      return 60;
    case "net30":
    default:
      return 30;
  }
}

/** When the invoice falls due: issued date plus the term. */
export function invoiceDueAt(a: AdvertiserAccount): number {
  return (a.issuedAt || 0) + termsDays(a.terms) * DAY_MS;
}

/**
 * The method recorded when someone marks an invoice paid instead of entering the
 * receipt. It is kept as a visible value rather than a boolean so the receipt  
 * trail shows *how* it was settled, and so "no bank detail" stays distinguishable
 * from a reconciled payment.
 */
export const MARKED_PAID_METHOD = "marked paid";

export interface InvoiceSettlement {
  /** Sum of every recorded payment. */
  paidUsd: number;
  /** Still owed. Zero once the invoice is settled. */
  balanceUsd: number;
  dueAt: number;
  state: InvoiceSettlementState;
  overdue: boolean;
  daysOverdue: number;
  /**
   * Settled, but with nothing but an assertion behind it: every receipt is a
   * "marked paid" one rather than a payment with real detail. The invoice is not
   * late and not owed, but the money was not verified either.
   */
  unbacked: boolean;
  /** Receipts that carry real payment detail. */
  verifiedPayments: number;
}

/**
 * What has actually been received against an invoice, and what is still owed.
 *
 * Derived from the payment records every time, so `status` cannot disagree with
 * the money: the only thing that can mark an invoice paid is payments adding up
 * to its total.
 */
export function invoiceSettlement(a: AdvertiserAccount, now = Date.now()): InvoiceSettlement {
  const payments = a.payments ?? [];
  const paidUsd = payments.reduce((n, p) => n + (Number(p.amountUsd) || 0), 0);
  const balanceUsd = Math.max(0, a.amountUsd - paidUsd);
  const dueAt = invoiceDueAt(a);
  const settled = balanceUsd <= 1e-9;
  // Day granularity, not milliseconds. Due dates are read as days, and comparing
  // raw timestamps made the answer flap: a prepaid invoice was "not overdue" in
  // the response that created it (same millisecond as its issue) and "overdue" in
  // the very next request. An invoice is late once a whole day has passed.
  const daysOverdue = Math.max(0, Math.floor((now - dueAt) / DAY_MS));
  const overdue = !settled && daysOverdue >= 1;
  const state: InvoiceSettlementState = settled
    ? "paid"
    : overdue
      ? "overdue"
      : paidUsd > 0
        ? "partial"
        : "unpaid";
  const verified = payments.filter((p) => p.method !== MARKED_PAID_METHOD);
  return {
    paidUsd,
    balanceUsd,
    dueAt,
    state,
    overdue,
    daysOverdue: overdue ? daysOverdue : 0,
    // Settled with no receipt at all, or with only "marked paid" placeholders:
    // reported as unbacked rather than presented as money that was verified.
    unbacked: settled && verified.length === 0,
    verifiedPayments: verified.length,
  };
}

export interface PaymentInput {
  amountUsd: number;
  /** Defaults to today, but a bank date is often earlier than the entry date. */
  receivedAt?: number;
  method?: string;
  reference?: string;
  note?: string;
  /** Defaults to `manual` — someone typed this in. */
  source?: PaymentSource;
  /** Provider transaction id; reconciliation refuses a repeat of one of these. */
  externalId?: string;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Record money received against an invoice.
 *
 * Refuses to overpay: a payment larger than the outstanding balance is almost
 * always a typo, and accepting it would make the receipt trail lie about what
 * was owed. Partial payments are the normal case and leave the invoice `partial`.
 *
 * Nothing here touches the ledger. The revenue was credited when the ads were
 * served; this is the receivable being settled, and double-counting it would
 * invent money.
 */
export function recordInvoicePayment(campaignId: string, input: PaymentInput): AdCampaign | { error: string } {
  const cs = load();
  const c = cs.find((x) => x.id === campaignId);
  if (!c?.advertiserAccount) return { error: "Campaign has no advertiser on record." };
  const a = c.advertiserAccount;
  const amount = round6(Number(input.amountUsd));
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Payment amount must be greater than zero." };
  const before = invoiceSettlement(a);
  if (before.balanceUsd <= 1e-9) {
    return { error: `${a.invoiceId} is already settled in full (${money(a.amountUsd)}).` };
  }
  if (amount > before.balanceUsd + 1e-9) {
    return {
      error: `That is more than the ${money(before.balanceUsd)} still outstanding on ${a.invoiceId} — refusing an overpayment.`,
    };
  }
  // A provider transaction is booked at most once, anywhere. The money arrives
  // once; a poll that runs every few minutes sees the same transaction every time,
  // so without this the same payment would be credited on every pass.
  if (input.externalId) {
    for (const other of cs) {
      const dup = (other.advertiserAccount?.payments ?? []).find((p) => p.externalId === input.externalId);
      if (dup) {
        return {
          error: `Transaction ${input.externalId} is already recorded against ${other.advertiserAccount?.invoiceId ?? "another invoice"}.`,
        };
      }
    }
  }
  const payment: InvoicePayment = {
    id: crypto.randomUUID(),
    amountUsd: amount,
    receivedAt: Number.isFinite(Number(input.receivedAt)) ? Number(input.receivedAt) : Date.now(),
    method: String(input.method ?? "").trim() || "unspecified",
    source: input.source ?? "manual",
    ...(String(input.reference ?? "").trim() ? { reference: String(input.reference).trim() } : {}),
    ...(String(input.note ?? "").trim() ? { note: String(input.note).trim() } : {}),
    ...(String(input.externalId ?? "").trim() ? { externalId: String(input.externalId).trim() } : {}),
  };
  // `payments` used to be absent entirely, so it is created here on first use.
  c.advertiserAccount = settleAccount({ ...a, payments: [...(a.payments ?? []), payment] }, payment.receivedAt);
  save(cs);
  return c;
}

/** Remove a payment recorded by mistake. Settlement follows it back down. */
export function removeInvoicePayment(campaignId: string, paymentId: string): AdCampaign | { error: string } {
  const cs = load();
  const c = cs.find((x) => x.id === campaignId);
  if (!c?.advertiserAccount) return { error: "Campaign has no advertiser on record." };
  const a = c.advertiserAccount;
  const payments = (a.payments ?? []).filter((p) => p.id !== paymentId);
  if (payments.length === (a.payments ?? []).length) return { error: "No such payment on this invoice." };
  const cleared = [...payments].sort((x, y) => x.receivedAt - y.receivedAt);
  c.advertiserAccount = settleAccount({ ...a, payments }, cleared[cleared.length - 1]?.receivedAt);
  save(cs);
  return c;
}

/**
 * Bring `status`/`paidAt` in line with the payments.
 *
 * `paidAt` is the date the invoice was *actually* cleared — the receipt that
 * settled it, not the moment it was marked. Dropping the payment again clears it.
 */
/**
 * Attach (or replace) the payment link an advertiser is sent to.
 *
 * Stored on the invoice rather than in settings because a link is only meaningful
 * with the amount it was raised for: keeping the two together means a stale link
 * against a changed balance is visible instead of silent.
 */
export function setInvoicePayLink(campaignId: string, link: InvoicePayLink): AdCampaign | { error: string } {
  const cs = load();
  const c = cs.find((x) => x.id === campaignId);
  if (!c?.advertiserAccount) return { error: "Campaign has no advertiser on record." };
  c.advertiserAccount = { ...c.advertiserAccount, payLink: link };
  save(cs);
  return c;
}

function settleAccount(a: AdvertiserAccount, settledAt?: number): AdvertiserAccount {
  const s = invoiceSettlement(a);
  const next: AdvertiserAccount = { ...a };
  if (s.balanceUsd <= 1e-9) {
    // Fall back to the last receipt that cleared it, so the date is the money's.
    const last = [...(a.payments ?? [])].sort((x, y) => x.receivedAt - y.receivedAt).pop();
    next.status = "paid";
    next.paidAt = settledAt ?? last?.receivedAt ?? a.issuedAt;
  } else {
    // Anything paid against is issued by definition, and it is not paid.
    next.status = "issued";
    delete next.paidAt;
  }
  return next;
}

/** Money, to the cent, but keeping sub-cent precision where it exists. */
function money(v: number): string {
  return `$${v.toFixed(4)}`;
}

/**
 * Move an invoice through its lifecycle.
 *
 * `paid` is special-cased: rather than just writing a flag, it records a payment
 * for the outstanding balance so the receipt trail stays complete. A status that
 * says money arrived with nothing to back it is exactly the label the operator
 * could not trust, and it is what this replaces.
 */
export function setInvoiceStatus(campaignId: string, status: InvoiceStatus): AdCampaign | { error: string } {
  const cs = load();
  const c = cs.find((x) => x.id === campaignId);
  if (!c?.advertiserAccount) return { error: "Campaign has no advertiser on record." };
  const a = c.advertiserAccount;
  if (status === "paid") {
    const s = invoiceSettlement(a);
    // Already settled by real payments: keep the detail, just assert the state.
    c.advertiserAccount = settleAccount(a);
    if (s.balanceUsd > 1e-9) {
      const payment: InvoicePayment = {
        id: crypto.randomUUID(),
        amountUsd: round6(s.balanceUsd),
        receivedAt: Date.now(),
        method: MARKED_PAID_METHOD,
        note: "Settled by marking the invoice paid, without payment detail.",
      };
      c.advertiserAccount = settleAccount({ ...c.advertiserAccount, payments: [...(a.payments ?? []), payment] });
    }
  } else {
    c.advertiserAccount = { ...a, status };
    delete c.advertiserAccount.paidAt;
  }
  save(cs);
  return c;
}

/** Detach the advertiser; the campaign goes back to being unbilled inventory. */
export function detachAdvertiser(campaignId: string): AdCampaign | { error: string } {
  const cs = load();
  const c = cs.find((x) => x.id === campaignId);
  if (!c) return { error: "Campaign not found." };
  delete c.advertiserAccount;
  save(cs);
  return c;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Per-campaign billing state for the Economy page. */
export interface CampaignBilling {
  id: string;
  title: string;
  advertiser: string;
  impressions: number;
  clicks: number;
  deliveredUsd: number;
  active: boolean;
  placeholder: boolean;
  backed: boolean;
  invoice: AdvertiserAccount | null;
  /** Delivered since the invoice was issued — what a follow-up bill covers. */
  uninvoicedUsd: number;
  /** What has actually been received, what is still owed, and whether it is late. */
  settlement: InvoiceSettlement | null;
}

export function campaignBilling(): CampaignBilling[] {
  const now = Date.now();
  return load().map((c) => {
    const delivered = campaignAccrualUsd(c.id);
    const placeholder = isPlaceholderCampaign(c);
    const backed = isAdvertiserBacked(c);
    const invoiced = c.advertiserAccount?.amountUsd ?? 0;
    return {
      id: c.id,
      title: c.title,
      advertiser: c.advertiser,
      impressions: c.impressions,
      clicks: c.clicks,
      // Ledger accrual, not the CPM counter: this is what the advertiser owes.
      deliveredUsd: delivered,
      active: c.active,
      placeholder,
      backed,
      invoice: c.advertiserAccount ?? null,
      uninvoicedUsd: backed ? Math.max(0, delivered - invoiced) : 0,
      settlement: c.advertiserAccount ? invoiceSettlement(c.advertiserAccount, now) : null,
    };
  });
}

/**
 * The receivables position, in one place, because every number here answers a
 * different question and reading them off the campaigns by hand invites the
 * usual mistake of treating invoiced money as money in the bank.
 */
export interface BillingSummary {
  invoiceCount: number;
  invoicedUsd: number;
  /** Money actually received — the only figure that is in hand. */
  collectedUsd: number;
  /** Still owed across all invoices. */
  outstandingUsd: number;
  /** The late part of the above, which is the actionable part. */
  overdueUsd: number;
  overdueCount: number;
}

export function billingSummary(rows: CampaignBilling[] = campaignBilling()): BillingSummary {
  const withInvoice = rows.filter((r) => r.invoice && r.settlement);
  const sum = (f: (r: CampaignBilling) => number) => withInvoice.reduce((n, r) => n + f(r), 0);
  return {
    invoiceCount: withInvoice.length,
    invoicedUsd: sum((r) => r.invoice?.amountUsd ?? 0),
    collectedUsd: sum((r) => r.settlement?.paidUsd ?? 0),
    outstandingUsd: sum((r) => r.settlement?.balanceUsd ?? 0),
    overdueUsd: sum((r) => (r.settlement?.overdue ? r.settlement.balanceUsd : 0)),
    overdueCount: withInvoice.filter((r) => r.settlement?.overdue).length,
  };
}

/**
 * The house inventory, seeded so the system works (and earns) out of the box.
 *
 * Ten creatives across deliberately distinct keyword clusters: contextual
 * targeting can only rotate what exists, and three campaigns covering
 * "database / deploy / review" meant every conversation saw the same card
 * within a couple of turns — which is how an ad slot trains its audience to
 * stop reading. Each cluster gets its own CPM/CPC so the top-3 lottery has
 * real choices to make.
 *
 * These are placeholder advertisers (example.com, `isPlaceholder`): they credit
 * the ledger for delivery measurement but are excluded from spendable revenue
 * by `funds.ts` until a real advertiser is invoiced. More inventory still means
 * more impressions and better rotation the day a real campaign lands — and the
 * network slot (EthicalAds) rides on top of all of it.
 */
const SEED_CAMPAIGNS: Parameters<typeof addCampaign>[0][] = [
  {
    title: "The AI code reviewer",
    adText: "AI agents that review and test PRs with full context of the codebase.",
    cta: "Learn more",
    url: "https://example.com/reviewer",
    advertiser: "Example Reviewer",
    icon: "🧠",
    cpmUsd: 2,
    cpcUsd: 0.5,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["code", "review", "pr", "test", "agent", "refactor"],
    weight: 1,
    active: true,
  },
  {
    title: "Postgres for agents",
    adText: "Serverless Postgres that scales to zero. Branch your database like your code.",
    cta: "Try free",
    url: "https://example.com/postgres",
    advertiser: "Example DB",
    icon: "🐘",
    cpmUsd: 3,
    cpcUsd: 0.75,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["database", "postgres", "sql", "schema", "migration", "query"],
    weight: 1,
    active: true,
  },
  {
    title: "Ship faster with previews",
    adText: "Every push gets a live preview URL. Share it, test it, merge it.",
    cta: "Deploy now",
    url: "https://example.com/deploy",
    advertiser: "Example Host",
    icon: "🚀",
    cpmUsd: 2.5,
    cpcUsd: 0.6,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["deploy", "hosting", "preview", "docker", "server", "release"],
    weight: 1,
    active: true,
  },
  {
    title: "CI that finishes before your coffee",
    adText: "Remote builds with caching that actually works. 4,000 free minutes monthly.",
    cta: "Speed up CI",
    url: "https://example.com/ci",
    advertiser: "Example CI",
    icon: "⚡",
    cpmUsd: 4,
    cpcUsd: 0.9,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["ci", "build", "pipeline", "github", "actions", "cache", "test"],
    weight: 1,
    active: true,
  },
  {
    title: "See the error before the user does",
    adText: "Error tracking with session replay for web and mobile apps. Free tier.",
    cta: "Start tracking",
    url: "https://example.com/errors",
    advertiser: "Example Monitor",
    icon: "📡",
    cpmUsd: 5,
    cpcUsd: 1.1,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["error", "monitoring", "logging", "observability", "crash", "debug", "sentry"],
    weight: 1,
    active: true,
  },
  {
    title: "Ship safer with secrets done right",
    adText: "Scan every commit for leaked keys, tokens and credentials — in seconds.",
    cta: "Scan my repo",
    url: "https://example.com/secrets",
    advertiser: "Example Security",
    icon: "🔐",
    cpmUsd: 4.5,
    cpcUsd: 1,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["security", "secret", "token", "key", "vulnerability", "auth", "credential"],
    weight: 1,
    active: true,
  },
  {
    title: "Design tokens your code understands",
    adText: "From Figma to production CSS variables, automatically in sync.",
    cta: "Sync designs",
    url: "https://example.com/design",
    advertiser: "Example Design",
    icon: "🎨",
    cpmUsd: 3,
    cpcUsd: 0.8,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["design", "css", "ui", "component", "figma", "style", "frontend", "layout"],
    weight: 1,
    active: true,
  },
  {
    title: "Docs your team actually reads",
    adText: "Knowledge base that lives next to your code and updates from your PRs.",
    cta: "Try it free",
    url: "https://example.com/docs",
    advertiser: "Example Docs",
    icon: "📚",
    cpmUsd: 2.5,
    cpcUsd: 0.7,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["docs", "documentation", "readme", "wiki", "knowledge", "guide"],
    weight: 1,
    active: true,
  },
  {
    title: "One API key, every model",
    adText: "Route between 400+ LLMs with one OpenAI-compatible endpoint and automatic failover.",
    cta: "Get the key",
    url: "https://example.com/router",
    advertiser: "Example Router",
    icon: "🔀",
    cpmUsd: 6,
    cpcUsd: 1.25,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["llm", "model", "api", "openai", "router", "inference", "ai", "token"],
    weight: 1,
    active: true,
  },
  {
    title: "Issues that triage themselves",
    adText: "Bug reports enriched with logs, repro steps and likely culprits — automatically.",
    cta: "See it work",
    url: "https://example.com/track",
    advertiser: "Example Tracker",
    icon: "🗂️",
    cpmUsd: 3.5,
    cpcUsd: 0.85,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["issue", "bug", "ticket", "backlog", "project", "sprint", "task"],
    weight: 1,
    active: true,
  },
  {
    title: "Kubernetes, minus the YAML",
    adText: "See and scale your cluster from one pane of glass. Free for small teams.",
    cta: "Tame the cluster",
    url: "https://example.com/k8s",
    advertiser: "Example Ops",
    icon: "⛵",
    cpmUsd: 3.5,
    cpcUsd: 0.9,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["kubernetes", "k8s", "cluster", "helm", "pod", "container", "devops", "infra"],
    weight: 1,
    active: true,
  },
  {
    title: "Type-safe APIs, no codegen step",
    adText: "Your schema is the contract: clients, server and mock all derive from one file.",
    cta: "Try the schema",
    url: "https://example.com/types",
    advertiser: "Example Types",
    icon: "🧩",
    cpmUsd: 3,
    cpcUsd: 0.8,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["typescript", "types", "api", "schema", "graphql", "endpoint", "rpc", "contract"],
    weight: 1,
    active: true,
  },
  {
    title: "Log in with one line",
    adText: "Drop-in auth with passkeys, OAuth and sessions that just work. Free to 10k users.",
    cta: "Add auth",
    url: "https://example.com/auth",
    advertiser: "Example Auth",
    icon: "🔑",
    cpmUsd: 4,
    cpcUsd: 0.95,
    budgetUsd: 0,
    isPlaceholder: true,
    keywords: ["auth", "login", "oauth", "session", "user", "identity", "password", "passkey"],
    weight: 1,
    active: true,
  },
];

export function seedHouseAdsIfEmpty(): void {
  const cs = load();
  const byTitle = new Map(cs.map((c) => [c.title, c]));
  // Top-up, not just first-run seeding: installs created before this list grew
  // keep their old campaigns forever otherwise, and the rotation starves. An
  // existing campaign also inherits an icon it predates — the seeds gained
  // icons after these rows were written, and without the backfill the old
  // inventory renders iconless forever.
  for (const seed of SEED_CAMPAIGNS) {
    const existing = byTitle.get(seed.title);
    if (!existing) {
      addCampaign(seed);
      continue;
    }
    if (seed.icon && !existing.icon) {
      updateCampaign(existing.id, { icon: seed.icon });
    }
  }
}

// ---------- Serving ----------

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// impressionId -> campaignId. Next bundles routes separately, so module-level
// memory is NOT shared across endpoints — this map lives on disk.
const IMP_MAP_FILE = "impmap.json";

function registerImpressionToken(impressionId: string, campaignId: string): void {
  const m = readJson<Record<string, string>>(IMP_MAP_FILE, {});
  m[impressionId] = campaignId;
  const keys = Object.keys(m);
  if (keys.length > 5_000) delete m[keys[0]]; // drop oldest inserted key
  writeJson(IMP_MAP_FILE, m);
}

function campaignIdFor(impressionId: string): string {
  return readJson<Record<string, string>>(IMP_MAP_FILE, {})[impressionId] ?? "";
}

export interface ServeResult {
  ad: SponsoredAd | null;
  impressionId: string;
  campaignId: string;
  /** Present when a frequency cap refused the request, so the UI can say why. */
  frequency?: FrequencyVerdict;
}

// Network creatives carry their own trackers, keyed by the id we hand the
// client. Disk-backed because route bundles don't share module state.
const NET_FILE = "netads.json";
const NET_PREFIX = "net:";

interface NetworkTracker {
  viewUrl: string;
  clickUrl: string;
  viewTimeUrl: string;
  /** The network's own creative id, carried so bookings can be reconciled to it. */
  networkEventId?: string | null;
  /** Serve-counted networks (Carbon) verify at serve; no pixel to await. */
  verifiedOnServe?: boolean;
}

function rememberNetworkAd(id: string, tracker: NetworkTracker): void {
  const m = readJson<Record<string, NetworkTracker>>(NET_FILE, {});
  m[id] = tracker;
  const keys = Object.keys(m);
  if (keys.length > 2_000) delete m[keys[0]];
  writeJson(NET_FILE, m);
}

function networkAdFor(id: string): NetworkTracker | null {
  return readJson<Record<string, NetworkTracker>>(NET_FILE, {})[id] ?? null;
}

/** The configured credential of whichever network is selected, or "". */
function activeNetworkId(s: AdsSettings): string {
  return (s.network === "carbon" ? s.carbonPlacementId ?? "" : s.ethicalAdsPublisherId).trim();
}

/**
 * Serve one ad for the inline transcript surface. `context` is recent
 * conversation text for targeting; `recentCampaignIds` avoids repeating the
 * same creative within one response. Revenue credits on impression ack.
 *
 * Fill order mirrors Freebuff's server chain (Gravity → ZeroClick → Carbon →
 * first-party): try the selected paying network, then fall back to first-party
 * campaigns so the slot is never blank.
 */
export interface ServeOptions {
  /** Groups serves for the per-session frequency cap. */
  sessionId?: string | null;
  /** Derived server-side from the User-Agent by the route, never from a body. */
  clientFamily?: ClientFamily;
  /** Skip the caps. Only the verification suites ever ask for this. */
  ignoreFrequencyCaps?: boolean;
}

export async function serveAd(
  context: string,
  recentCampaignIds: string[],
  opts: ServeOptions = {},
): Promise<ServeResult> {
  const s: AdsSettings = getSettings().ads;
  if (!s.enabled) return { ad: null, impressionId: "", campaignId: "" };

  // Server-enforced pacing. Checked here, before any provider call, so a client
  // that asks too often costs nothing and gets told why.
  const frequency = opts.ignoreFrequencyCaps
    ? ({ allowed: true, reason: "Frequency caps bypassed (verification run).", code: "ok" } as FrequencyVerdict)
    : checkAdFrequency({ sessionId: opts.sessionId ?? null });
  if (!frequency.allowed) return { ad: null, impressionId: "", campaignId: "", frequency };

  const placement = "cli_chat";
  const sessionId = opts.sessionId ?? null;
  const clientFamily = opts.clientFamily ?? "unknown";
  const networkId = activeNetworkId(s);
  const netProvider: "ethicalads" | "carbon" | "house" =
    s.network === "ethicalads" || s.network === "carbon" ? s.network : "house";
  recordAdEvent({
    type: "requested",
    impressionId: "",
    provider: netProvider === "house" ? "house" : networkId ? netProvider : "house",
    placement,
    sessionId,
    clientFamily,
  });

  if (netProvider !== "house" && networkConfigured(networkId)) {
    const net = netProvider === "carbon" ? await fetchCarbonAds(networkId) : await fetchEthicalAds(networkId, { keywords: keywordsFrom(context) });
    // Record every outcome, not just the failures: "no fill" and "invalid
    // publisher" are indistinguishable from the outside, and the difference
    // decides whether any network money can ever arrive.
    recordNetworkOutcome(net, networkId);
    if (net.ad) {
      // Two ids for two different jobs, because they are not the same id. The
      // network's creative id names the *campaign* and repeats constantly — a
      // small pool rotates the same creative in and out — so it cannot identify a
      // serve. Using it as the booking token made every serve after the first look
      // like a replay of the first, so the repeat's view pixel never fired and its
      // impression could never be paid for. The token the client acks with is
      // minted per serve; the creative id is kept beside it purely for
      // reconciliation and provenance.
      const creativeId = net.ad.networkCreativeId.trim() || null;
      const token = `${NET_PREFIX}${crypto.randomUUID()}`;
      rememberNetworkAd(token, {
        viewUrl: net.ad.networkViewUrl,
        clickUrl: net.ad.networkClickUrl,
        viewTimeUrl: net.ad.networkViewTimeUrl,
        networkEventId: creativeId,
        ...(net.ad.verifiedOnServe ? { verifiedOnServe: true } : {}),
      });
      const ad: SponsoredAd = {
        adText: net.ad.adText,
        title: net.ad.title,
        cta: net.ad.cta,
        url: net.ad.url,
        domain: net.ad.domain,
        ...(net.ad.icon ? { icon: net.ad.icon } : {}),
        clickUrl: `/api/ads/click?i=${encodeURIComponent(token)}`,
        impUrl: `/api/ads/impression?i=${encodeURIComponent(token)}`,
        placementId: net.ad.placementId,
        provider: netProvider,
      };
      recordAdEvent({
        type: "served",
        // Per serve, like the token: serving the same creative twice is two
        // serves, and a shared id would collapse them into one in the pipeline.
        eventId: `served:${token}`,
        impressionId: token,
        provider: netProvider,
        placement,
        sessionId,
        networkEventId: creativeId,
        clientFamily,
      });
      return { ad, impressionId: token, campaignId: "", frequency };
    }
  }

  const cs = scoreCampaigns(load(), context).filter((c) => !recentCampaignIds.includes(c.id));
  if (!cs.length) return { ad: null, impressionId: "", campaignId: "", frequency };

  const c = cs[Math.floor(Math.random() * Math.min(cs.length, 3))]; // top-3 lottery
  const impressionId = crypto.randomUUID();
  registerImpressionToken(impressionId, c.id);
  const ad: SponsoredAd = {
    adText: c.adText,
    title: c.title,
    cta: c.cta,
    url: c.url,
    clickUrl: `/api/ads/click?i=${encodeURIComponent(impressionId)}`,
    impUrl: `/api/ads/impression?i=${encodeURIComponent(impressionId)}`,
    placementId: "cli_chat",
    provider: "first_party",
    domain: domainOf(c.url),
    ...(c.icon ? { icon: c.icon } : {}),
  };
  recordAdEvent({
    type: "served",
    eventId: `served:${impressionId}`,
    impressionId,
    provider: "first_party",
    placement,
    campaignId: c.id,
    sessionId,
    clientFamily,
  });
  return { ad, impressionId, campaignId: c.id, frequency };
}

/** Keywords for network targeting, derived from recent conversation context. */
function keywordsFrom(context: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "you", "your", "are", "was", "have", "from", "not", "but", "can", "will", "one", "all", "how", "why", "use", "get", "make", "add"]);
  const counts = new Map<string, number>();
  for (const w of tokenize(context)) {
    if (stop.has(w) || w.length < 4) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w]) => w);
}

// ---------- Impression / click acknowledgement (idempotent per event id) ----------

// Disk-backed for the same reason as impMap: shared across route bundles.
const EVENTS_FILE = "events.json";

function rememberEvent(id: string): boolean {
  const seen = readJson<string[]>(EVENTS_FILE, []);
  if (seen.includes(id)) return false;
  seen.unshift(id);
  writeJson(EVENTS_FILE, seen.slice(0, 10_000));
  return true;
}

function eventRemembered(id: string): boolean {
  return readJson<string[]>(EVENTS_FILE, []).includes(id);
}

/**
 * Booking keys the client cannot mint.
 *
 * Client event ids are `[A-Za-z0-9._:-]+`. Prefixing with `@` keeps these
 * internal, so a header cannot collide with (or pre-empt) another impression's
 * booking key.
 */
function impressionBookingKey(impressionId: string): string {
  return `@imp:${impressionId}`;
}
function clickBookingKey(impressionId: string): string {
  return `@click:${impressionId}`;
}

function alreadyBooked(keys: string[]): boolean {
  return keys.some((k) => k && eventRemembered(k));
}

function rememberAll(keys: string[]): void {
  for (const k of keys) if (k) rememberEvent(k);
}

export interface AdEventInput {
  impressionId: string;
  /** One id per logical client event, reused on every retry of it. */
  clientEventId?: string | null;
  sessionId?: string | null;
  clientFamily?: ClientFamily;
  /** Client-measured; null when it could not be measured. Never derived. */
  renderDelayMs?: number | null;
}

export interface ImpressionResult {
  ok: boolean;
  alreadyRecorded?: boolean;
  creditedUsd?: number;
  pending?: boolean;
  /** The lifecycle stage reached, so a caller can tell a verify from a booking. */
  stage?: "displayed" | "verified" | "pending" | "confirmed";
  /** Set when the provider did not accept the event, so the money is NOT booked. */
  warning?: string;
}

/**
 * Record that an ad was actually rendered.
 *
 * The stages are separate on purpose. `displayed` is the client's claim that the
 * card mounted; `verified` is the *provider* accepting the event on its own
 * side. Only after verification is revenue booked, and where it is booked
 * depends on who owes it:
 *
 *  - **network** → `pending`. The network counts the impression itself and pays
 *    on its own schedule; nothing about that is spendable yet.
 *  - **advertiser-backed campaign** → `confirmed`. Somebody is on the hook.
 *  - **house inventory** → booked, but tagged `house`: recorded so delivery is
 *    measurable, excluded from every spendable figure by `funds.ts`.
 *
 * A failed verification books nothing and says so, rather than crediting money
 * the provider will not pay.
 */
export function recordImpression(input: AdEventInput): Promise<ImpressionResult> {
  // The check, the pixel and the booking are one critical section. They have to
  // be: the network path awaits the pixel in the middle, so the dedupe decision is
  // read in one task and written in another, and two concurrent acks of the same
  // impression would otherwise both pass the check and book twice.
  return withFileLock(EVENTS_FILE, () => bookImpression(input));
}

async function bookImpression(input: AdEventInput): Promise<ImpressionResult> {
  const { impressionId } = input;
  if (!impressionId) return { ok: false };
  const clientEventId = input.clientEventId || impressionId;
  // One served ad is one impression, regardless of how many client event ids a
  // remount, Strict Mode double-effect, or chat-history revisit mints. Deduping
  // only on the client id booked the same token twice every time AdCard mounted.
  const bookingKey = impressionBookingKey(impressionId);
  if (alreadyBooked([bookingKey, clientEventId])) return { ok: true, alreadyRecorded: true };

  const common = {
    impressionId,
    sessionId: input.sessionId ?? null,
    clientFamily: input.clientFamily ?? ("unknown" as ClientFamily),
    renderDelayMs: input.renderDelayMs ?? null,
  };

  if (impressionId.startsWith(NET_PREFIX)) {
    const tracker = networkAdFor(impressionId);
    if (!tracker) {
      // An ack for a network token this server never minted (a stale tab after a
      // restart drops the in-memory tracker). Silent before this: the caller saw a
      // 404 and the operator saw nothing, so a wave of these looked like traffic.
      logEvent("warn", "ads.impression.unknown_network_token", { impressionId, sessionId: input.sessionId ?? null });
      return { ok: false };
    }
    const provider = tracker.verifiedOnServe ? "carbon" : "ethicalads";
    recordAdEvent({ type: "displayed", eventId: `displayed:${clientEventId}`, provider, ...common });
    const cpm = getSettings().ads.cpmUsd;
    const worth = cpm / 1000;
    // Serve-counted networks (Carbon/BuySellAds) verify at serve: the JSON
    // fetch was the impression, so there is no pixel to await. EthicalAds pays
    // for impressions its own pixel recorded, so there the pixel is awaited and
    // its result decides whether any money is booked at all.
    const accepted = tracker.verifiedOnServe ? true : await ackNetworkImpression(tracker.viewUrl);
    if (!accepted) {
      // The money path. The network refused its own view pixel, so nothing is
      // booked; the caller got only a `warning` field in one HTTP body. Logging it
      // with the network's own event id is what lets a "network revenue stopped
      // accruing" report be traced to refused pixels instead of replayed by hand.
      logEvent("warn", "ads.impression.pixel_rejected", {
        impressionId,
        provider,
        networkEventId: tracker.networkEventId ?? null,
        sessionId: input.sessionId ?? null,
      });
      return {
        ok: true,
        creditedUsd: 0,
        pending: true,
        stage: "displayed",
        warning: "The ad network did not accept the impression pixel, so no revenue was booked.",
      };
    }
    // The creative id, for provenance: the token identifies this serve, the
    // creative id identifies what the network will pay for and is what the eventual
    // statement is matched against. It used to be read back out of the token,
    // which only worked while the token *was* the creative id.
    const networkEventId = tracker.networkEventId ?? null;
    recordAdEvent({
      type: "verified",
      eventId: `verified:${clientEventId}`,
      provider,
      networkEventId,
      ...common,
    });
    // Viewability confirmation (their own second pixel), then book the revenue.
    if (tracker.viewTimeUrl) ackNetworkViewTime(tracker.viewTimeUrl);
    creditEstimatedRevenue(
      worth,
      `Network impression — estimated at $${cpm.toFixed(2)} CPM`,
      {
        origin: "network",
        ...(networkEventId ? { sourceId: networkEventId } : {}),
        provider,
      },
      "impression",
    );
    // Only now — verified, revenue booked — is this serve marked done.
    // Writing the key before verification, as this used to, meant a failed or
    // timed-out ack still consumed the impression: the retry that should have
    // booked it was answered `alreadyRecorded` and the money was lost for good.
    rememberAll([bookingKey, clientEventId]);
    recordAdEvent({
      type: "pending",
      eventId: `pending:${clientEventId}`,
      provider,
      networkEventId,
      amountUsd: worth,
      pending: true,
      detail: "Network revenue is pending until the network's statement is reconciled.",
      ...common,
    });
    return { ok: true, creditedUsd: worth, pending: true, stage: "pending" };
  }

  const cs = load();
  const c = cs.find((x) => x.id === campaignIdFor(impressionId));
  if (!c) {
    // A first-party token whose campaign is gone (deleted between serve and ack).
    logEvent("warn", "ads.impression.unknown_campaign_token", {
      impressionId,
      sessionId: input.sessionId ?? null,
    });
    return { ok: false };
  }
  recordAdEvent({
    type: "displayed",
    eventId: `displayed:${clientEventId}`,
    provider: "first_party",
    campaignId: c.id,
    ...common,
  });
  c.impressions += 1;
  const worth = (c.cpmUsd > 0 ? c.cpmUsd : getSettings().ads.cpmUsd) / 1000;
  c.spentUsd += worth;
  save(cs);

  // A first-party creative is acknowledged by this server, which is the party
  // that would invoice for it — so `verified` here means "the delivery record
  // exists", not "an external network confirmed it".
  recordAdEvent({
    type: "verified",
    eventId: `verified:${clientEventId}`,
    provider: "first_party",
    campaignId: c.id,
    ...common,
  });

  const backed = isAdvertiserBacked(c);
  creditAdRevenue(worth, "ad-impression", `Impression — ${c.advertiser} / ${c.title}`, {
    campaignId: c.id,
    sourceId: impressionId,
    origin: backed ? "advertiser" : "house",
    provider: "first_party",
    costMethod: "fixed-cpm",
  });
  // Booked, so this serve is done and a retry of the same ack must be answered
  // `alreadyRecorded` rather than booked again. There is no external pixel here —
  // this server is the party that would invoice — so verification and booking are
  // the same synchronous step.
  rememberAll([bookingKey, clientEventId]);
  recordAdEvent({
    type: backed ? "confirmed" : "pending",
    eventId: `${backed ? "confirmed" : "pending"}:${clientEventId}`,
    provider: "first_party",
    campaignId: c.id,
    amountUsd: worth,
    pending: !backed,
    detail: backed
      ? "Advertiser-backed campaign: invoiced, so this counts as collectible revenue."
      : "House inventory: booked for delivery reporting only. No external payer, so it is not money.",
    ...common,
  });
  return { ok: true, creditedUsd: worth, ...(backed ? {} : { pending: true }), stage: backed ? "confirmed" : "pending" };
}

/**
 * Record a click-through.
 *
 * A click is its own event with its own id — never inferred from a render, a
 * hover, or a dwell time. Deduplicated like an impression, so a double-tap or a
 * retried beacon is one click.
 */
export interface ClickResult {
  ok: boolean;
  alreadyRecorded?: boolean;
  creditedUsd?: number;
  url?: string;
  pending?: boolean;
}

export function recordClick(input: AdEventInput): Promise<ClickResult> {
  // Same file, same rule as an impression: the booking decision is one critical
  // section. Nothing here awaits today, so the check and the write are already
  // uninterrupted — the lock keeps that true if a network click ever has to
  // confirm something before it books.
  return withFileLock(EVENTS_FILE, () => bookClick(input));
}

async function bookClick(input: AdEventInput): Promise<ClickResult> {
  const { impressionId } = input;
  if (!impressionId) return { ok: false };
  const clientEventId = input.clientEventId || `click-${impressionId}`;
  // Same served ad, one click. AdCard minted a fresh event id on every tap and
  // remount, so the client-id guard never saw a retry as a retry.
  const bookingKey = clickBookingKey(impressionId);
  if (alreadyBooked([bookingKey, clientEventId])) return { ok: true, alreadyRecorded: true };

  const common = {
    impressionId,
    sessionId: input.sessionId ?? null,
    clientFamily: input.clientFamily ?? ("unknown" as ClientFamily),
  };

  if (impressionId.startsWith(NET_PREFIX)) {
    const tracker = networkAdFor(impressionId);
    // The network's own click URL is the paid redirect: sending the browser there
    // is what makes the network record (and pay for) the click.
    if (!tracker) return { ok: false };
    const provider = tracker.verifiedOnServe ? "carbon" : "ethicalads";
    const bonus = getSettings().ads.clickBonusUsd;
    recordAdEvent({ type: "click", provider, amountUsd: bonus, pending: true, ...common });
    creditEstimatedRevenue(
      bonus,
      "Network click — estimated pending network statement",
      {
        origin: "network",
        provider,
        sourceId: tracker.networkEventId ?? undefined,
      },
      "click",
    );
    rememberAll([bookingKey, clientEventId]);
    return { ok: true, creditedUsd: bonus, pending: true, url: tracker.clickUrl || undefined };
  }

  const cs = load();
  const c = cs.find((x) => x.id === campaignIdFor(impressionId));
  if (!c) return { ok: false };
  c.clicks += 1;
  const bonus = c.cpcUsd > 0 ? c.cpcUsd : getSettings().ads.clickBonusUsd;
  c.spentUsd += bonus;
  save(cs);
  const backed = isAdvertiserBacked(c);
  recordAdEvent({
    type: "click",
    provider: "first_party",
    campaignId: c.id,
    amountUsd: bonus,
    pending: !backed,
    ...common,
  });
  creditAdRevenue(bonus, "ad-click", `Click — ${c.advertiser} / ${c.title}`, {
    campaignId: c.id,
    sourceId: impressionId,
    origin: backed ? "advertiser" : "house",
    provider: "first_party",
    costMethod: "fixed-cpm",
  });
  rememberAll([bookingKey, clientEventId]);
  return { ok: true, creditedUsd: bonus, url: c.url };
}

/** Delivery report: what sold, what it earned, and which side paid it. */
export function deliveryReport() {
  const cs = load();
  const s = getSettings().ads;
  const state = networkState();
  const networkId = activeNetworkId(s);
  return {
    network: s.network,
    networkConfigured: networkConfigured(networkId),
    // Why the network slot is (or is not) paying, in plain language. Without
    // this a rejected publisher id looks identical to healthy delivery.
    networkStatus: {
      reason: state?.reason ?? (networkConfigured(networkId) ? "unknown" : "not-configured"),
      at: state?.at ?? null,
      // The raw upstream detail, kept separate from the prose below. It is the
      // difference between "your publisher id is wrong" and "the network is
      // broken" — e.g. `{"publisher":["Invalid publisher"]}` — which is what
      // makes an edge block distinguishable from an API rejection.
      detail: state?.detail ?? null,
      text: networkReasonText(state, networkConfigured(networkId)),
    },
    campaigns: cs.map((c) => ({
      id: c.id,
      advertiser: c.advertiser,
      title: c.title,
      impressions: c.impressions,
      clicks: c.clicks,
      spentUsd: c.spentUsd,
      budgetUsd: c.budgetUsd,
      active: c.active,
    })),
    totals: {
      impressions: cs.reduce((n, c) => n + c.impressions, 0),
      clicks: cs.reduce((n, c) => n + c.clicks, 0),
      spentUsd: cs.reduce((n, c) => n + c.spentUsd, 0),
    },
  };
}

export function economySnapshot() {
  return getState();
}
