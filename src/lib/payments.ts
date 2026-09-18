import type {
  AdvertiserAccount,
  InvoicePayLink,
  PaymentProviderKind,
  PaymentsSettings,
} from "./types";
import { getSettings, saveSettings } from "./settings";
import { invoiceSettlement, listCampaigns, recordInvoicePayment, setInvoicePayLink } from "./ads";
import { keychainDelete, keychainInUse, keychainSet, resolveStripeKey } from "./keychain";

/**
 * Getting paid, rather than recording that you were.
 *
 * Everything else in the economy is bookkeeping: impressions accrue a claim, an
 * invoice states it, a receipt settles it. This module is the part that can
 * actually move money, and it does it by handing the advertiser to a payment
 * provider. The app never holds funds, never sees a card number, and has no
 * privileged view of the operator's account — it raises a payment page and, when
 * the provider allows it, reads the transaction back so nobody types the receipt
 * in by hand.
 *
 * Three things shape the design:
 *
 *  1. **A local desktop app cannot receive webhooks.** Stripe (and every other
 *     provider) pushes payment events to a public HTTPS endpoint. A server bound
 *     to 127.0.0.1 has no such endpoint, and tunnelling one is out of scope for a
 *     local app. So reconciliation is **pull-based**: `reconcileProviderPayments`
 *     asks what has been paid. That is a constraint of running locally, stated
 *     here so nobody goes looking for the missing webhook route.
 *
 *  2. **Polling sees the same transaction repeatedly**, so a payment needs a
 *     unique handle on it or it would be credited on every poll. Payments carry
 *     `externalId` (the provider's own id) and reconciliation refuses any
 *     transaction already recorded *anywhere*, not merely on the invoice it
 *     appears to target.
 *
 *  3. **A mismatch is reported, never guessed at.** If a provider says more money
 *     arrived than the invoice still owes, that is not a bigger payment — it is
 *     an overpayment, a duplicate, or the wrong invoice. `recordInvoicePayment`
 *     refuses those, and reconciliation surfaces them as needing attention
 *     instead of quietly recording a different number than the one that arrived.
 */

const STRIPE_BASE = "https://api.stripe.com";
const STRIPE_TIMEOUT_MS = 8000;
/** How many recent sessions a poll looks at. Enough for a slow advertiser. */
const SYNC_WINDOW = 100;

export function paymentsSettings(): PaymentsSettings {
  const p = getSettings().payments;
  return {
    provider: p?.provider ?? "none",
    linkUrl: p?.linkUrl ?? "",
    /** The on-disk field. On a real install this is normally empty: the key
     *  lives in the Keychain (see keychain.ts) and effectivePayments() is what
     *  hands the real credential to the Stripe client. */
    stripeSecretKey: p?.stripeSecretKey ?? "",
    successUrl: p?.successUrl ?? "",
    cancelUrl: p?.cancelUrl ?? "",
    stripeBaseUrl: p?.stripeBaseUrl ?? (process.env.INFYIELD_STRIPE_BASE_URL?.trim() || ""),
    lastSyncAt: p?.lastSyncAt,
    lastSyncText: p?.lastSyncText,
  };
}

/**
 * The payments settings as the Stripe client should see them: with the secret
 * key resolved from wherever it actually lives (Keychain first, then the legacy
 * plaintext field, which is also what verification-harness servers use).
 */
export async function effectivePayments(): Promise<PaymentsSettings> {
  const base = paymentsSettings();
  const resolved = await resolveStripeKey();
  return { ...base, stripeSecretKey: resolved.key };
}

/** Server-side only view. The route strips the secret before it leaves. */
export function publicPayments(p: PaymentsSettings) {
  return {
    provider: p.provider,
    linkUrl: p.linkUrl,
    successUrl: p.successUrl,
    cancelUrl: p.cancelUrl,
    /** Never the key itself — only whether one is stored. */
    hasStripeKey: p.stripeSecretKey.trim().length > 0,
    keyMode: stripeKeyMode(p.stripeSecretKey),
    /** Where the key lives, so the UI can say so truthfully. */
    storage: keychainInUse() ? ("keychain" as const) : ("file" as const),
    lastSyncAt: p.lastSyncAt ?? null,
    lastSyncText: p.lastSyncText ?? null,
  };
}

/** `publicPayments` for the current install, key included from its real home. */
export async function publicPaymentsAsync() {
  return publicPayments(await effectivePayments());
}

/**
 * Whether a stored Stripe key is a restricted key.
 *
 * Worth surfacing: a full secret key can move money out of the account, and this
 * app only ever needs to create a Checkout Session and list them. A restricted
 * key with Checkout write access is the right thing to paste here, and telling
 * someone their key is unrestricted is more useful than a blank field.
 */
export function stripeKeyMode(key: string): "none" | "restricted" | "secret" | "unrecognised" {
  const k = key.trim();
  if (!k) return "none";
  if (k.startsWith("rk_")) return "restricted";
  if (k.startsWith("sk_")) return "secret";
  return "unrecognised";
}

/**
 * Merge a patch into the stored payment settings.
 *
 * A field that is absent is left alone, so the UI can send `provider` without
 * re-sending the secret, and a key is only ever replaced when one is actually
 * provided — never blanked out by a form that did not have it loaded.
 *
 * The secret key is the one field that does not land in settings.json on a real
 * install: it goes to the macOS Keychain, and the on-disk field is kept empty.
 * An explicit empty string means "remove the key" and clears both stores.
 */
export async function savePaymentSettings(patch: Record<string, unknown>): Promise<PaymentsSettings> {
  const current = paymentsSettings();
  const str = (v: unknown, fallback: string) => (v === undefined ? fallback : String(v).trim());

  // ---- the key: route it to its store before anything else touches the file
  let keyOnDisk = current.stripeSecretKey;
  if (patch.stripeSecretKey !== undefined) {
    const incoming = String(patch.stripeSecretKey).trim();
    if (!incoming) {
      // An explicit blank is a removal: clear the Keychain entry and the field.
      await keychainDelete();
      keyOnDisk = "";
    } else if (keychainInUse()) {
      const ok = await keychainSet(incoming);
      if (ok) {
        keyOnDisk = ""; // the file must not carry what the Keychain now holds
      } else {
        // Keychain refused (headless/locked): fall back to the plaintext field
        // rather than losing the operator's key. publicPayments reports the
        // truthful `storage`, and the settings UI surfaces it.
        keyOnDisk = incoming;
      }
    } else {
      // Verification-harness server (or non-mac): plaintext field as before.
      keyOnDisk = incoming;
    }
  }

  const next: PaymentsSettings = {
    provider: (patch.provider as PaymentProviderKind | undefined) ?? current.provider,
    linkUrl: str(patch.linkUrl, current.linkUrl),
    stripeSecretKey: keyOnDisk,
    successUrl: str(patch.successUrl, current.successUrl),
    cancelUrl: str(patch.cancelUrl, current.cancelUrl),
    // Not settable from a request: a live install must not be aimable at a mock.
    stripeBaseUrl: current.stripeBaseUrl,
    ...(current.lastSyncAt ? { lastSyncAt: current.lastSyncAt } : {}),
    ...(current.lastSyncText ? { lastSyncText: current.lastSyncText } : {}),
  };
  const s = getSettings();
  saveSettings({ ...s, payments: next });
  return next;
}

export function stripeBase(p: PaymentsSettings = paymentsSettings()): string {
  return (p.stripeBaseUrl || STRIPE_BASE).replace(/\/+$/, "");
}

export async function collectionReady(p?: PaymentsSettings): Promise<boolean> {
  const pay = p ?? (await effectivePayments());
  if (pay.provider === "link") return pay.linkUrl.trim().length > 0;
  if (pay.provider === "stripe") return pay.stripeSecretKey.trim().length > 0;
  return false;
}

/* ------------------------------- Stripe client ------------------------------ */

interface StripeFailure {
  ok: false;
  error: string;
  /** The HTTP status, when there was one. 0 means the request never landed. */
  status: number;
}

type StripeResult<T> = { ok: true; data: T } | StripeFailure;

/**
 * Stripe wants form-encoded bodies with bracketed nesting, e.g.
 * `line_items[0][price_data][currency]=usd`. Built flat rather than by a generic
 * serialiser so every parameter sent is visible at the call site.
 */
function formEncode(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    q.append(k, String(v));
  }
  return q.toString();
}

function stripeErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
    const msg = parsed.error?.message ?? parsed.error?.type;
    if (msg) return msg;
  } catch {
    /* fall through to the raw body */
  }
  return body.slice(0, 200) || `HTTP ${status}`;
}

async function stripeRequest<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: Record<string, string | number | boolean | undefined> },
  p?: PaymentsSettings,
): Promise<StripeResult<T>> {
  const settings = p ?? (await effectivePayments());
  const key = settings.stripeSecretKey.trim();
  if (!key) return { ok: false, error: "No Stripe key is configured.", status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STRIPE_TIMEOUT_MS);
  try {
    const res = await fetch(`${stripeBase(settings)}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(init.body ? { body: formEncode(init.body) } : {}),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: stripeErrorMessage(res.status, text), status: res.status };
    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch {
      return { ok: false, error: "Stripe returned a response that was not JSON.", status: res.status };
    }
  } catch (err) {
    const aborted = (err as { name?: string }).name === "AbortError";
    return {
      ok: false,
      error: aborted ? `Stripe did not answer within ${STRIPE_TIMEOUT_MS / 1000}s.` : `Could not reach Stripe: ${(err as Error).message}`,
      status: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface StripeSession {
  id?: string;
  url?: string;
  status?: string;
  payment_status?: string;
  amount_total?: number;
  currency?: string;
  created?: number;
  client_reference_id?: string;
  payment_intent?: string;
  payment_method_types?: string[];
  metadata?: Record<string, string>;
  mode?: string;
}

export interface StripeAccount {
  available: { amount: number; currency: string }[];
  pending: { amount: number; currency: string }[];
  livemode?: boolean;
}

/* ------------------------------- the pay link ------------------------------- */

/** The metadata key that ties a provider transaction back to an invoice. */
export const INVOICE_METADATA_KEY = "infyield_invoice";

export interface PayLinkOk {
  ok: true;
  link: InvoicePayLink;
}
export interface PayLinkErr {
  ok: false;
  error: string;
}
export type PayLinkResult = PayLinkOk | PayLinkErr;

function campaignsWithInvoice() {
  return listCampaigns().filter((c) => c.advertiserAccount);
}

/**
 * Raise a payment link for an invoice's outstanding balance.
 *
 * For `stripe` this creates a real Checkout Session for the exact amount still
 * owed, so the advertiser cannot underpay by using a stale link, and stamps the
 * invoice reference into the session metadata so the payment can be matched back
 * automatically. The session id is kept, because that id is what makes
 * reconciliation idempotent.
 */
export async function createInvoicePayLink(
  campaignId: string,
  p?: PaymentsSettings,
): Promise<PayLinkResult> {
  const pay = p ?? (await effectivePayments());
  const campaign = listCampaigns().find((c) => c.id === campaignId);
  const account = campaign?.advertiserAccount;
  if (!campaign || !account) return { ok: false, error: "Campaign has no advertiser on record." };

  const settlement = invoiceSettlement(account);
  if (settlement.balanceUsd <= 1e-9) {
    return { ok: false, error: `${account.invoiceId} is already settled — there is nothing to collect.` };
  }
  if (pay.provider === "none") {
    return {
      ok: false,
      error: "No payment provider is configured. Choose one in Settings → Payments before raising a link.",
    };
  }

  if (pay.provider === "link") {
    const url = pay.linkUrl.trim();
    if (!url) return { ok: false, error: "No payment link URL is set in Settings → Payments." };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: `"${url}" is not a valid URL.` };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, error: "A payment link must be https — an advertiser's browser will not trust anything else." };
    }
    const link: InvoicePayLink = {
      provider: "link",
      url,
      createdAt: Date.now(),
      amountUsd: round2(settlement.balanceUsd),
    };
    storeLink(campaignId, link);
    return { ok: true, link };
  }

  // Stripe: a Checkout Session for exactly what is outstanding.
  if (!pay.successUrl.trim()) {
    return {
      ok: false,
      error:
        "Stripe needs a success URL — where the advertiser lands after paying. Set one in Settings → Payments (any page you control, or a Stripe-hosted confirmation).",
    };
  }
  const cents = Math.round(settlement.balanceUsd * 100);
  const body: Record<string, string | number | boolean | undefined> = {
    mode: "payment",
    // Hosted by Stripe, so no card data ever reaches this app.
    success_url: pay.successUrl.trim(),
    ...(pay.cancelUrl.trim() ? { cancel_url: pay.cancelUrl.trim() } : {}),
    client_reference_id: account.invoiceId,
    [`metadata[${INVOICE_METADATA_KEY}]`]: account.invoiceId,
    [`metadata[infyield_campaign]`]: campaignId,
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": cents,
    "line_items[0][price_data][product_data][name]": `${account.invoiceId} — ${account.name}`,
  };
  const res = await stripeRequest<StripeSession>("/v1/checkout/sessions", { method: "POST", body }, pay);
  if (!res.ok) return { ok: false, error: res.error };
  const url = res.data.url;
  if (!url) return { ok: false, error: "Stripe created a session but returned no payment URL." };

  const link: InvoicePayLink = {
    provider: "stripe",
    url,
    createdAt: Date.now(),
    amountUsd: round2(settlement.balanceUsd),
    ...(res.data.id ? { externalId: res.data.id } : {}),
  };
  storeLink(campaignId, link);
  return { ok: true, link };
}

// The write itself lives in ads.ts, so campaigns.json keeps exactly one writer
// and cannot race the ad-serving path.
function storeLink(campaignId: string, link: InvoicePayLink): void {
  setInvoicePayLink(campaignId, link);
}

/* ----------------------------- reconciliation ------------------------------ */

export interface ReconcileRecorded {
  campaignId: string;
  invoiceId: string;
  advertiser: string;
  amountUsd: number;
  externalId: string;
  receivedAt: number;
}

export interface ReconcileAttention {
  externalId: string;
  invoiceId: string | null;
  amountUsd: number;
  reason: string;
}

export interface ReconcileResult {
  ok: boolean;
  provider: PaymentProviderKind;
  /** Provider transactions examined in this pass. */
  checked: number;
  recorded: ReconcileRecorded[];
  /** Transactions deliberately not recorded, with the reason. */
  skipped: { externalId: string; reason: string }[];
  /** Things a human has to look at: mismatches, wrong currency, no invoice. */
  needsAttention: ReconcileAttention[];
  message: string;
  error?: string;
}

/** Every payment id already booked, across every invoice. */
function recordedExternalIds(): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of campaignsWithInvoice()) {
    for (const pay of c.advertiserAccount?.payments ?? []) {
      if (pay.externalId) out.set(pay.externalId, c.advertiserAccount?.invoiceId ?? c.id);
    }
  }
  return out;
}

function findByInvoiceId(invoiceId: string) {
  if (!invoiceId) return null;
  return campaignsWithInvoice().find((c) => c.advertiserAccount?.invoiceId === invoiceId) ?? null;
}

/**
 * Ask the provider what has been paid and record anything new.
 *
 * Safe to call on a timer: a transaction already booked anywhere is skipped, so
 * running it repeatedly cannot inflate the receipts. Nothing here marks an invoice
 * paid directly — a payment is recorded and the settlement follows it, which keeps
 * `paid` a consequence of money rather than an opinion.
 */
export async function reconcileProviderPayments(
  p?: PaymentsSettings,
): Promise<ReconcileResult> {
  const pay = p ?? (await effectivePayments());
  const base: ReconcileResult = {
    ok: true,
    provider: pay.provider,
    checked: 0,
    recorded: [],
    skipped: [],
    needsAttention: [],
    message: "",
  };

  if (pay.provider === "none") {
    return { ...base, ok: false, error: "No payment provider is configured." };
  }
  if (pay.provider === "link") {
    return {
      ...base,
      message:
        "A static payment link cannot be checked automatically — whoever pays goes to your provider, and the app has no way to see that. Record the payment when it lands, or switch to Stripe to have it read back for you.",
    };
  }
  if (!pay.stripeSecretKey.trim()) {
    return { ...base, ok: false, error: "No Stripe key is configured." };
  }

  const res = await stripeRequest<{ data?: StripeSession[] }>(
    `/v1/checkout/sessions?limit=${SYNC_WINDOW}&status=complete`,
    { method: "GET" },
    pay,
  );
  if (!res.ok) {
    const result: ReconcileResult = { ...base, ok: false, error: res.error };
    saveSyncOutcome(`Check failed: ${res.error}`);
    return result;
  }

  const sessions = (res.data.data ?? []).filter((s) => s.payment_status === "paid");
  const already = recordedExternalIds();
  const result: ReconcileResult = { ...base, checked: sessions.length };

  for (const s of sessions) {
    const externalId = String(s.id ?? "");
    if (!externalId) continue;

    if (already.has(externalId)) {
      result.skipped.push({ externalId, reason: `already recorded against ${already.get(externalId)}` });
      continue;
    }

    const invoiceId = String(s.metadata?.[INVOICE_METADATA_KEY] ?? s.client_reference_id ?? "");
    const campaign = findByInvoiceId(invoiceId);
    if (!campaign?.advertiserAccount) {
      result.needsAttention.push({
        externalId,
        invoiceId: invoiceId || null,
        amountUsd: centsToUsd(s.amount_total),
        reason: invoiceId
          ? `Payment names ${invoiceId}, which is not an invoice on record.`
          : "Payment carries no invoice reference, so it cannot be matched to one.",
      });
      continue;
    }

    const account = campaign.advertiserAccount;
    if ((s.currency ?? "").toLowerCase() !== "usd") {
      result.needsAttention.push({
        externalId,
        invoiceId: account.invoiceId,
        amountUsd: centsToUsd(s.amount_total),
        reason: `Paid in ${(s.currency ?? "an unknown currency").toUpperCase()} — only usd invoices reconcile without a conversion this app will not invent.`,
      });
      continue;
    }

    const amountUsd = centsToUsd(s.amount_total);
    const balanceUsd = invoiceSettlement(account).balanceUsd;
    if (amountUsd <= 0) {
      result.skipped.push({ externalId, reason: "zero-amount transaction" });
      continue;
    }
    if (amountUsd > balanceUsd + 1e-9) {
      result.needsAttention.push({
        externalId,
        invoiceId: account.invoiceId,
        amountUsd,
        reason: `Paid ${money(amountUsd)} but only ${money(balanceUsd)} is outstanding — overpaid, duplicated, or aimed at the wrong invoice. Not recorded automatically.`,
      });
      continue;
    }

    const written = recordInvoicePayment(campaign.id, {
      amountUsd,
      receivedAt: s.created ? s.created * 1000 : Date.now(),
      method: s.payment_method_types?.[0] ? `stripe:${s.payment_method_types[0]}` : "stripe",
      ...(s.payment_intent ? { reference: s.payment_intent } : {}),
      source: "stripe",
      externalId,
    });
    if ("error" in written) {
      result.needsAttention.push({ externalId, invoiceId: account.invoiceId, amountUsd, reason: written.error });
      continue;
    }
    result.recorded.push({
      campaignId: campaign.id,
      invoiceId: account.invoiceId,
      advertiser: account.name,
      amountUsd,
      externalId,
      receivedAt: s.created ? s.created * 1000 : Date.now(),
    });
    // Later sessions in the same pass must also see this one as taken.
    already.set(externalId, account.invoiceId);
  }

  result.message = summarize(result);
  saveSyncOutcome(result.message);
  return result;
}

function summarize(r: ReconcileResult): string {
  if (r.checked === 0) return "No paid Stripe transactions found.";
  const parts = [`${r.checked} paid transaction${r.checked === 1 ? "" : "s"} checked`];
  parts.push(r.recorded.length ? `${r.recorded.length} recorded` : "nothing new to record");
  if (r.skipped.length) parts.push(`${r.skipped.length} already recorded`);
  if (r.needsAttention.length) parts.push(`${r.needsAttention.length} needing attention`);
  return `${parts.join(", ")}.`;
}

/** Record when the last check ran and how it went, so a silent failure is visible. */
function saveSyncOutcome(text: string): void {
  const s = getSettings();
  saveSettings({
    ...s,
    payments: { ...paymentsSettings(), lastSyncAt: Date.now(), lastSyncText: text },
  });
}

function centsToUsd(cents: number | undefined): number {
  return typeof cents === "number" && Number.isFinite(cents) ? Math.round(cents) / 100 : 0;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

/**
 * Prove the credentials work without moving anything.
 *
 * Reads the account balance: an authenticated, read-only call, so a wrong key is
 * reported plainly and a correct one is confirmed rather than assumed. Nothing
 * is created, which is the point — a connectivity test must not be able to take
 * money or leave an artefact behind.
 */
export async function testPaymentProvider(
  p?: PaymentsSettings,
): Promise<{ ok: boolean; message: string; detail?: string }> {
  const pay = p ?? (await effectivePayments());
  if (pay.provider === "none") return { ok: false, message: "No payment provider is configured." };

  if (pay.provider === "link") {
    if (!pay.linkUrl.trim()) return { ok: false, message: "No payment link is set." };
    try {
      const u = new URL(pay.linkUrl.trim());
      if (u.protocol !== "https:") return { ok: false, message: "The payment link must be https." };
      return { ok: true, message: `Link looks usable (${u.host}). The app cannot verify it beyond that — it does not hold the account.` };
    } catch {
      return { ok: false, message: "That is not a valid URL." };
    }
  }

  const res = await stripeRequest<StripeAccount>("/v1/balance", { method: "GET" }, pay);
  if (!res.ok) {
    return {
      ok: false,
      message:
        res.status === 401
          ? "Stripe rejected that key (401). Check it is a restricted key with Checkout Sessions write access, and that it is for the right account."
          : `Stripe did not confirm the key: ${res.error}`,
      detail: res.error,
    };
  }
  const avail = (res.data.available ?? []).find((b) => b.currency === "usd");
  const pending = (res.data.pending ?? []).find((b) => b.currency === "usd");
  return {
    ok: true,
    message: `Stripe answered. Available $${((avail?.amount ?? 0) / 100).toFixed(2)}${pending ? `, pending $${(pending.amount / 100).toFixed(2)}` : ""}${res.data.livemode === false ? " (test mode — no real money will move)" : ""}.`,
  };
}

/** Where to send the advertiser, in one pasteable block. */
export function invoiceMessage(campaignId: string): { ok: boolean; text: string } {
  const campaign = listCampaigns().find((c) => c.id === campaignId);
  const a: AdvertiserAccount | undefined = campaign?.advertiserAccount;
  if (!campaign || !a) return { ok: false, text: "" };
  const s = invoiceSettlement(a);
  const lines = [
    `Invoice ${a.invoiceId} — ${a.name}`,
    `Amount due: ${money(s.balanceUsd)}${s.paidUsd > 0 ? ` (of ${money(a.amountUsd)}, ${money(s.paidUsd)} already received)` : ""}`,
    `Terms: ${a.terms}${s.overdue ? ` — ${s.daysOverdue} day${s.daysOverdue === 1 ? "" : "s"} overdue` : ` — due ${new Date(s.dueAt).toISOString().slice(0, 10)}`}`,
    a.payLink ? `Pay here: ${a.payLink.url}` : "Payment link not raised yet.",
    "",
    campaign.title,
  ];
  return { ok: true, text: lines.join("\n") };
}
