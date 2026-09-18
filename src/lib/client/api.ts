"use client";

import type {
  AdCampaign,
  AdvertiserAccount,
  AppSettings,
  Attachment,
  EconomyState,
  InvoicePayLink,
  InvoiceSettlementState,
  ModelInfo,
  PaymentProviderKind,
  PaymentTerms,
  ProviderKind,
} from "@/lib/types";

export type { InvoiceSettlementState };

/**
 * Every network call the UI makes goes through here, so error states are
 * uniform and no page has to remember endpoint shapes. Nothing here invents
 * data: each call maps 1:1 onto a real route in src/app/api.
 *
 * It is also the only place a request gets its credentials, so a page cannot
 * forget them. That was the gap that made setting a password break the app: the
 * server has always checked a Bearer token, and the client has never sent one.
 */

export class ApiFailure extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
  }
}

/* ------------------------------- access -------------------------------- */

/**
 * Which password a surface wants, and where the browser keeps it.
 *
 * Two are stored rather than one because the server keeps them separate on
 * purpose: a program handed the API password can hold a conversation but cannot
 * change the deployment. The UI needs both — chat and the model catalog use the
 * API one, every other screen uses the admin one — so it keeps both and picks per
 * request, rather than the server accepting either password for everything.
 */
const TOKEN_KEYS = { admin: "infyield.adminpw", api: "infyield.apipw" } as const;

export type TokenKind = keyof typeof TOKEN_KEYS;

function readToken(kind: TokenKind): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(TOKEN_KEYS[kind]) ?? "";
  } catch {
    return "";
  }
}

/** Whether this browser holds a password for that surface. */
export function hasAccessToken(kind: TokenKind): boolean {
  return readToken(kind).length > 0;
}

/** Store one of the access passwords — or clear it, by passing an empty value. */
export function setAccessToken(kind: TokenKind, value: string): void {
  if (typeof window === "undefined") return;
  try {
    const v = value.trim();
    if (v) localStorage.setItem(TOKEN_KEYS[kind], v);
    else localStorage.removeItem(TOKEN_KEYS[kind]);
  } catch {
    /* Storage blocked: requests go out unauthenticated and the server says so,
       which is a visible failure rather than a silent one. */
  }
}

/** The header a request needs for its surface, or nothing when none is stored. */
export function authHeaders(kind: TokenKind): Record<string, string> {
  const token = readToken(kind);
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit, kind: TokenKind = "admin"): Promise<T> {
  const hasBody = init?.body !== undefined;
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      cache: "no-store",
      headers: { ...(hasBody ? { "content-type": "application/json" } : {}), ...authHeaders(kind), ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiFailure("Can’t reach the local Infyield server. Is the app still running?", 0);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const raw = (body as { error?: unknown } | null)?.error;
    // A 401 is the one failure a user can act on themselves, so it says how.
    const message =
      res.status === 401
        ? "Unauthorized — this browser has no (or the wrong) access password. Enter it in Settings → Privacy."
        : typeof raw === "string"
          ? raw
          : `Request failed (${res.status})`;
    throw new ApiFailure(message, res.status);
  }
  return body as T;
}

const get = <T>(path: string, kind: TokenKind = "admin") => request<T>(path, undefined, kind);
const send = <T>(path: string, body: unknown, method = "POST", kind: TokenKind = "admin") =>
  request<T>(path, { method, body: JSON.stringify(body ?? {}) }, kind);

/* ------------------------------- shapes ---------------------------------- */

export interface UiModel {
  id: string;
  label: string;
  blurb: string;
  contextWindow: number;
  priceIn: number;
  priceOut: number;
  unmetered: boolean;
  tags: string[];
  available: boolean;
  via: string | null;
  /** Reserve tier: priced far above the everyday catalog and gated behind
   * earned ad revenue. */
  premium: boolean;
  requiresBalanceUsd: number;
  typicalTurnUsd: number;
  unlocked: boolean;
  shortfallUsd: number;
  /** False in BYOK mode, where the caller's own key is billed directly. */
  gateEnforced: boolean;
  /** Model accepts a deliberation level; the composer disables the control when false. */
  reasoning: boolean;
}

/** Mirrors Skill in src/lib/types.ts as the /api/skills route serves it. */
export interface UiSkill {
  id: string;
  name: string;
  blurb: string;
  builtin: boolean;
  tools: string[];
  readOnly: boolean;
}

/** Mirrors EarnPlan in src/lib/premium.ts (server module, types only). */
export interface EarnPlanResponse {
  adFunded: boolean;
  balanceUsd: number;
  confirmedRevenueUsd: number;
  pendingRevenueUsd: number;
  spendUsd: number;
  targetUsd: number;
  targetReached: boolean;
  collectibleRevenueUsd: number;
  placeholderRevenueUsd: number;
  spendableUsd: number;
  toTargetUsd: number;
  impressionsToTarget: number;
  clicksToTarget: number;
  perImpressionUsd: number;
  perClickUsd: number;
  intensity: "relaxed" | "steady" | "aggressive" | "maximum";
  cadenceSteps: number;
  maxAdsPerResponse: number;
  adPressure: number;
  network: string;
  usingPlaceholderInventory: boolean;
  /** Campaigns with a paying advertiser + issued/paid invoice. */
  backedCampaigns: number;
  placeholderCampaigns: number;
  premium: {
    id: string;
    label: string;
    priceIn: number;
    priceOut: number;
    requiredUsd: number;
    typicalTurnUsd: number;
    impressionsToUnlock: number;
    impressionsPerTurnFunded: number;
    unlocked: boolean;
    shortfallUsd: number;
  }[];
}

/** Mirrors FundingStatus in src/lib/autosetup.ts (server module, types only). */
export interface FundingStatus {
  mode: "sponsored" | "byok" | "unfunded";
  ready: boolean;
  hasOperatorKey: boolean;
  estimatedRevenueUsd: number;
  /** Booked ad revenue, including placeholder inventory nobody will pay. */
  confirmedRevenueUsd: number;
  spendUsd: number;
  /** Booked minus spend and payouts. Prefer spendableUsd for "available". */
  balanceUsd: number;
  /** Revenue an advertiser or network is actually on the hook to pay. */
  collectibleRevenueUsd: number;
  /** Booked revenue from seeded campaigns with no advertiser behind it. */
  placeholderRevenueUsd: number;
  /** Collectible minus spend minus payouts — the figure adPressure reads. */
  spendableUsd: number;
  adPressure: number;
  adBudgetPerResponse: number;
}

export interface DeliveryReport {
  network: "house" | "ethicalads";
  networkConfigured: boolean;
  /** Why the network slot is or is not paying, in plain language. */
  networkStatus: {
    reason: string;
    at: number | null;
    /** Raw upstream detail (e.g. the network's rejection body), or null. */
    detail: string | null;
    text: string;
  };
  campaigns: { id: string; advertiser: string; title: string; impressions: number; clicks: number; spentUsd: number; budgetUsd: number; active: boolean }[];
  totals: { impressions: number; clicks: number; spentUsd: number };
}

/** Mirrors CampaignBilling in src/lib/ads.ts. */
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
  uninvoicedUsd: number;
  /** Derived from the recorded payments: what was received, what is owed, and
   * whether it is late. Null when the campaign has no invoice. */
  settlement: InvoiceSettlement | null;
}

/** Mirrors InvoiceSettlement in src/lib/ads.ts. */
export interface InvoiceSettlement {
  paidUsd: number;
  balanceUsd: number;
  dueAt: number;
  state: InvoiceSettlementState;
  overdue: boolean;
  daysOverdue: number;
  /** Settled, but only by a "marked paid" assertion — no verified receipt. */
  unbacked: boolean;
  /** Receipts carrying real payment detail. */
  verifiedPayments: number;
}

/** Mirrors BillingSummary in src/lib/ads.ts. */
export interface BillingSummary {
  invoiceCount: number;
  invoicedUsd: number;
  collectedUsd: number;
  outstandingUsd: number;
  overdueUsd: number;
  overdueCount: number;
}

export interface RevenueBreakdown {
  collectibleUsd: number;
  placeholderUsd: number;
  confirmedUsd: number;
  backedCampaignIds: string[];
}

export interface CampaignsResponse {
  campaigns: AdCampaign[];
  billing: CampaignBilling[];
  receivables: BillingSummary;
  revenue: RevenueBreakdown;
}

export interface EconomyResponse extends EconomyState {
  funding: FundingStatus;
  delivery: DeliveryReport;
}

/** One provider's credential state. Carries no secret, by construction. */
export interface ProviderCredentialStatus {
  provider: string;
  configured: boolean;
  source: "environment" | "env-file" | null;
  envVars: string[];
}

/** Live vs simulated, with the mock endpoints that decided it. */
export interface ModeReport {
  mode: "live" | "test" | "simulated";
  simulated: boolean;
  mocks: { subsystem: string; env: string; label: string }[];
  notice: string | null;
}

/** Provider-spend admission state, as the health surface and UI read it. */
export interface FundingSnapshotResponse {
  confirmedRevenueUsd: number;
  pendingRevenueUsd: number;
  houseRevenueUsd: number;
  bookedRevenueUsd: number;
  spendUsd: number;
  spendTodayUsd: number;
  payoutsUsd: number;
  availableOperatingUsd: number;
  providerBudgetUsd: number;
  reserveUsd: number;
  policy: {
    reserveUsd: number;
    dailySpendCapUsd: number;
    maxRequestCostUsd: number;
    perSessionDailyRequests: number;
    emergencyStop: boolean;
  };
  health: "healthy" | "at-risk" | "blocked";
  reason: string;
  simulated: boolean;
}

export interface BootstrapResponse {
  ready: boolean;
  /** Exact variables an operator must set when nothing can be served. */
  missingProviderEnv: string[];
  servableCount: number;
  totalModels: number;
  hasAnyKey: boolean;
  keys: number;
  autoImported: number;
  providers: ProviderCredentialStatus[];
  mode: ModeReport;
  fundingSnapshot: FundingSnapshotResponse;
  funding: FundingStatus;
  economy: EconomyState;
  /** Ad-funded accounting, split so the readout can show money that can
   * actually settle a bill rather than the gross booked figure. */
  earn: {
    collectibleUsd: number;
    placeholderUsd: number;
    spendableUsd: number;
    targetUsd: number;
    intensity: EarnPlanResponse["intensity"];
    /** Campaigns with a paying advertiser behind them. */
    backedCampaigns: number;
    /** Campaigns whose delivery is booked but never billed. */
    placeholderCampaigns: number;
  };
}

export interface WorkspaceEntry {
  name: string;
  kind: "dir" | "file";
  sizeBytes: number;
  modifiedAt: number;
  ext: string;
}
export interface WorkspaceResponse {
  root: string;
  exists: boolean;
  entries: WorkspaceEntry[];
  recentWorkspaces?: string[];
  error?: string;
}

export interface WorkspacePickResult {
  ok: boolean;
  /** False when no native dialog is available (a plain dev server). */
  dialog?: boolean;
  canceled?: boolean;
  root?: string;
  error?: string;
}

export interface WorkspaceSetResult {
  ok: boolean;
  root?: string;
  error?: string;
}

/**
 * Settings as they leave the server.
 *
 * Identical to `AppSettings` minus the two access passwords, which are reported
 * as booleans instead — the server never serialises them, so a client cannot read
 * a password back even after authenticating. `SettingsPatch` is the write side,
 * which does accept them.
 */
export type SettingsResponse = Omit<AppSettings, "apiPassword" | "adminPassword"> & {
  hasApiPassword: boolean;
  hasAdminPassword: boolean;
};

export type SettingsPatch = Partial<AppSettings>;

export interface NewModelInput {
  label: string;
  provider: ProviderKind;
  upstreamModel: string;
  baseUrl?: string;
  priceIn?: number;
  priceOut?: number;
  contextWindow?: number;
  /** Capability tags; "reasoning" enables the composer's thinking control. */
  tags?: string[];
}

export interface NewCampaignInput {
  title: string;
  adText: string;
  url: string;
  advertiser?: string;
  keywords?: string[];
  cpmUsd?: number;
  cpcUsd?: number;
  /** Invoicing the campaign on creation: attach a paying advertiser in one step. */
  backedBy?: string;
  contact?: string;
  terms?: PaymentTerms;
}

export interface PaymentInput {
  amountUsd: number;
  /** The bank date, which is often earlier than the day it is entered. */
  receivedAt?: number;
  method?: string;
  reference?: string;
  note?: string;
}

/** Mirrors publicPayments() in src/lib/payments.ts — never carries the secret. */
export interface PaymentsPublic {
  provider: PaymentProviderKind;
  linkUrl: string;
  successUrl: string;
  cancelUrl: string;
  hasStripeKey: boolean;
  keyMode: "none" | "restricted" | "secret" | "unrecognised";
  lastSyncAt: number | null;
  lastSyncText: string | null;
}

/** Mirrors ReconcileResult in src/lib/payments.ts. */
export interface ReconcileResult {
  ok: boolean;
  provider: PaymentProviderKind;
  checked: number;
  recorded: { campaignId: string; invoiceId: string; advertiser: string; amountUsd: number; externalId: string; receivedAt: number }[];
  skipped: { externalId: string; reason: string }[];
  needsAttention: { externalId: string; invoiceId: string | null; amountUsd: number; reason: string }[];
  message: string;
  error?: string;
}

export interface PaymentsPatch {
  provider?: PaymentProviderKind;
  linkUrl?: string;
  stripeSecretKey?: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface AdvertiserInput {
  name: string;
  contact?: string;
  terms?: PaymentTerms;
  status?: AdvertiserAccount["status"];
  amountUsd?: number;
  note?: string;
  /** Epoch ms the invoice was issued; omit for now. Drives the due date. */
  issuedAt?: number;
}

/* -------------------------------- api ------------------------------------ */

export const api = {
  bootstrap: () => get<BootstrapResponse>("/api/bootstrap"),
  /** The model catalog sits behind the API password, so read it with that one. */
  models: () => get<{ models: UiModel[]; defaultModelId: string }>("/api/models", "api"),
  economy: () => get<EconomyResponse>("/api/economy"),
  earn: () => get<EarnPlanResponse>("/api/earn"),
  setEarnTarget: (targetUsd: number) => send<{ plan: EarnPlanResponse }>("/api/earn", { targetUsd }, "PATCH"),
  setAdIntensity: (intensity: EarnPlanResponse["intensity"]) =>
    send<{ plan: EarnPlanResponse }>("/api/earn", { intensity }, "PATCH"),
  campaigns: () => get<CampaignsResponse>("/api/campaigns"),
  skills: () => get<{ skills: UiSkill[] }>("/api/skills"),
  settings: () => get<SettingsResponse>("/api/settings"),
  customModels: () => get<{ models: ModelInfo[] }>("/api/admin/models"),
  workspace: () => get<WorkspaceResponse>("/api/workspace"),
  pickWorkspace: () => send<WorkspacePickResult>("/api/workspace", { action: "pick" }, "POST"),
  setWorkspaceRoot: (path: string) => send<WorkspaceSetResult>("/api/workspace", { action: "set", path }, "POST"),

  connectAuthorize: (headless = false) =>
    get<{ url?: string; headless: boolean; pending: boolean }>(`/api/connect/openrouter${headless ? "?headless=1" : ""}`),
  connectWithCode: (code: string) => send<{ ok?: boolean; label?: string }>("/api/connect/openrouter", { code }),

  addModel: (input: NewModelInput) => send<{ model: ModelInfo }>("/api/admin/models", input),
  removeModel: (id: string) => request<{ ok: boolean }>(`/api/admin/models?id=${encodeURIComponent(id)}`, { method: "DELETE" }),

  addCampaign: (input: NewCampaignInput) => send<{ campaign: AdCampaign }>("/api/campaigns", input),
  setCampaignActive: (id: string, active: boolean) => send<{ campaign: AdCampaign }>("/api/campaigns", { id, active }, "PATCH"),
  removeCampaign: (id: string) => request<{ ok: boolean }>(`/api/campaigns?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** Put a paying advertiser behind a campaign and mint its invoice. */
  invoiceCampaign: (id: string, input: AdvertiserInput) =>
    send<{ campaign: AdCampaign; billing: CampaignBilling[] }>("/api/campaigns", { id, action: "attach-advertiser", ...input }, "PATCH"),
  setInvoiceStatus: (id: string, status: AdvertiserAccount["status"]) =>
    send<{ campaign: AdCampaign; billing: CampaignBilling[] }>("/api/campaigns", { id, action: "invoice-status", status }, "PATCH"),

  payments: () => get<{ payments: PaymentsPublic }>("/api/payments"),
  setPayments: (patch: PaymentsPatch) => send<{ payments: PaymentsPublic }>("/api/payments", patch, "PATCH"),
  /** Read-only proof the credentials work. Moves nothing. */
  testPayments: () => send<{ ok: boolean; message: string; payments: PaymentsPublic }>("/api/payments", { action: "test" }),
  /** Pull paid provider transactions in and record the new ones. */
  syncPayments: () => send<ReconcileResult & { payments: PaymentsPublic }>("/api/payments", { action: "sync" }),
  /** Raise a real payment page for an invoice's outstanding balance. */
  createPayLink: (campaignId: string) =>
    send<{ link: InvoicePayLink }>("/api/payments", { action: "pay-link", campaignId }),
  /** The invoice as a pasteable message, link included. */
  invoiceMessage: (campaignId: string) =>
    send<{ text: string }>("/api/payments", { action: "invoice-message", campaignId }),
  /** Record money actually received against an invoice. */
  recordInvoicePayment: (id: string, input: PaymentInput) =>
    send<{ campaign: AdCampaign; billing: CampaignBilling[] }>("/api/campaigns", { id, action: "record-payment", ...input }, "PATCH"),
  /** Undo a receipt recorded by mistake; settlement follows it back down. */
  removeInvoicePayment: (id: string, paymentId: string) =>
    send<{ campaign: AdCampaign; billing: CampaignBilling[] }>("/api/campaigns", { id, action: "remove-payment", paymentId }, "PATCH"),
  detachAdvertiser: (id: string) =>
    send<{ campaign: AdCampaign; billing: CampaignBilling[] }>("/api/campaigns", { id, action: "detach-advertiser" }, "PATCH"),

  /** Files sent with a message. Multipart for picker/drop, JSON for pastes. */
  uploadFiles: async (files: File[]): Promise<{ attachments: Attachment[]; warnings?: string[] }> => {
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    const res = await fetch("/api/uploads", { method: "POST", body: form, cache: "no-store", headers: authHeaders("admin") });
    const body = (await res.json().catch(() => null)) as { attachments?: Attachment[]; warnings?: string[]; error?: string } | null;
    if (!res.ok || !body?.attachments) throw new ApiFailure(body?.error ?? `Upload failed (${res.status})`, res.status);
    return { attachments: body.attachments, warnings: body.warnings };
  },
  uploadPaste: async (input: { name: string; mime: string; dataUrl: string }): Promise<{ attachments: Attachment[] }> => {
    const res = await request<{ attachments?: Attachment[] }>("/api/uploads", { method: "POST", body: JSON.stringify(input) }, "admin");
    return { attachments: res.attachments ?? [] };
  },

  saveSettings: (patch: SettingsPatch) => send<SettingsResponse>("/api/settings", patch, "PATCH"),

  reconcile: (note?: string) => send<EconomyState>("/api/payouts", { action: "reconcile", note }),
  payout: (amount: number, note?: string) => send<EconomyState>("/api/payouts", { action: "payout", amount, note }),
  setPayoutAccount: (account: string) => send<EconomyState>("/api/payouts", { action: "account", note: account }),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiFailure) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
