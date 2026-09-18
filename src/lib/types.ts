// Type-only import: erased at compile time, so the runtime dependency stays
// one-way (funding.ts → types.ts).
import type { FundingSnapshot } from "./funding";

// ---------- Ads (Freebuff-style AdResponse shape, Apache-2.0 reference) ----------

export type AdProvider = "first_party" | "house" | "ethicalads" | "carbon";

export interface SponsoredAd {
  adText: string; // description copy
  title: string; // headline
  cta: string; // e.g. "Learn more"
  url: string; // advertiser landing page (display)
  favicon?: string;
  /** The thing's icon: an emoji for house inventory, or an image URL the
   * network supplied (Carbon ships one per creative). The card renders the
   * emoji in a tile; a URL is loaded as a small image with a letter fallback. */
  icon?: string;
  clickUrl: string; // tracked click endpoint
  impUrl: string; // tracked impression endpoint
  placementId?: string;
  provider: AdProvider;
  impressionIds?: string[];
  domain?: string; // display label
}

export type PaymentTerms = "prepaid" | "net15" | "net30" | "net60";
export type InvoiceStatus = "draft" | "issued" | "paid";

/**
 * The paying party behind a campaign, and the invoice covering what the ads
 * delivered.
 *
 * This is the difference between inventory that looks like revenue and revenue
 * somebody will actually pay. A campaign without an account here is either
 * first-party demonstration inventory or an unpaid pitch; only a campaign with
 * a named advertiser and an issued/paid invoice is billed, collected, and
 * therefore allowed to pay for models.
 */
/**
 * Money actually received against an invoice — the receipt.
 *
 * This is what makes `paid` a fact rather than a label. An invoice is settled by
 * its payments; `status` and `paidAt` are consequences of them, never the other
 * way round. Payments are deliberately NOT ledger entries: the revenue was
 * already credited when the impressions were served, so a payment settles a
 * receivable and must not move the balance a second time.
 */
export interface InvoicePayment {
  id: string;
  /** Amount received, in USD. May be less than the invoice: partials are normal. */
  amountUsd: number;
  /** When the money landed (bank date, not the date it was typed in). */
  receivedAt: number;
  /** How it arrived — ACH, card, wire, PayPal… free text, because it varies. */
  method: string;
  /** Bank/transaction reference, so a receipt can be reconciled later. */
  reference?: string;
  note?: string;
  /**
   * How the receipt got here. `manual` is someone typing it in; `stripe` is a
   * provider transaction read back from the API; `link` is a static payment link
   * the operator matched by hand. Only `stripe` is machine-verified.
   */
  source?: PaymentSource;
  /**
   * The provider's own transaction id (a Stripe Checkout Session id, say).
   *
   * This is the reconciliation idempotency key: the money arrives exactly once,
   * but a poll that runs every few minutes sees the same transaction every time,
   * and without a unique handle on it the same payment would be recorded over and
   * over. Checked across every invoice, not just the one it is aimed at, so a
   * transaction can never be booked twice even if it is re-targeted.
   */
  externalId?: string;
}

export type PaymentSource = "manual" | "stripe" | "link";

/**
 * Where an advertiser pays a particular invoice.
 *
 * A link is a real, provider-hosted payment page: money moves between the
 * advertiser and the provider, and lands in the operator's account. The app never
 * touches funds — it hands over the link and, when it can, reads the transaction
 * back so the receipt is not typed in by hand.
 */
export interface InvoicePayLink {
  provider: PaymentProviderKind;
  url: string;
  createdAt: number;
  /** Amount this link was raised for, so a later amount change is visible. */
  amountUsd: number;
  /** Provider object id (Checkout Session), used for reconciliation. */
  externalId?: string;
}

/**
 * Settlement is derived from the payments, so it can never drift from them.
 * `overdue` wins over `partial` deliberately: a late partial payment is still
 * something you have to chase.
 */
export type InvoiceSettlementState = "unpaid" | "partial" | "paid" | "overdue";

/**
 * How invoices get collected.
 *
 * `none`   — nothing wired up; invoices are settled by hand.
 * `link`   — a static payment URL (a Stripe Payment Link, PayPal.me, Wise…).
 *            Works with no credentials, but the amount is whatever the link is
 *            set to, so reconciliation is manual.
 * `stripe` — the app creates a Checkout Session per invoice for the exact
 *            outstanding balance and reads paid sessions back from the API.
 *
 * A local desktop app cannot receive webhooks — there is no public URL for
 * Stripe to call — so provider reconciliation is necessarily **pull-based**: the
 * app asks what has been paid. That is a constraint of running locally, not a
 * missing feature.
 */
export type PaymentProviderKind = "none" | "link" | "stripe";

export interface PaymentsSettings {
  provider: PaymentProviderKind;
  /** For `link`: the payment URL advertisers are sent to. */
  linkUrl: string;
  /** For `stripe`: a **restricted** secret key (`rk_…`), server-side only. */
  stripeSecretKey: string;
  /** Where Stripe sends the advertiser after paying. Must be a real URL. */
  successUrl: string;
  /** Where Stripe sends the advertiser if they back out. */
  cancelUrl: string;
  /**
   * Test seam: point the Stripe client at a mock. Deliberately not exposed in
   * the UI — aiming a live install at a fake provider would let it book money
   * that does not exist. Set only via the environment, like the ad-network one.
   */
  stripeBaseUrl: string;
  /** When payments were last checked against the provider. */
  lastSyncAt?: number;
  /** Plain-language outcome of the last check, so a silent failure is visible. */
  lastSyncText?: string;
}

export interface AdvertiserAccount {
  /** Legal/company name on the invoice. */
  name: string;
  /** Billing contact (email), printed on the invoice. */
  contact: string;
  /** Invoice reference, e.g. INV-2026-0004. */
  invoiceId: string;
  /** Amount invoiced, in USD — normally what the campaign has actually delivered. */
  amountUsd: number;
  terms: PaymentTerms;
  status: InvoiceStatus;
  issuedAt: number;
  paidAt?: number;
  /** Free-text memo carried onto the invoice record. */
  note?: string;
  /** Every payment received against this invoice. Absent means nothing arrived. */
  payments?: InvoicePayment[];
  /** Where the advertiser pays this invoice, once a link has been raised. */
  payLink?: InvoicePayLink;
}

export interface AdCampaign {
  id: string;
  title: string;
  adText: string;
  cta: string;
  url: string;
  advertiser: string;
  /** The advertiser's mark — an emoji tile on the card, or an image URL. */
  icon?: string;
  cpmUsd: number; // revenue per 1000 impressions
  cpcUsd: number; // revenue per click
  budgetUsd: number; // 0 = unlimited
  spentUsd: number;
  keywords: string[]; // contextual targeting
  weight: number; // rotation weight
  active: boolean;
  impressions: number;
  clicks: number;
  createdAt: number;
  /** Seeded demonstration inventory with no advertiser behind it. Its
   * impressions credit the ledger but earn no real money, so it must never
   * count towards what the reserve tier is allowed to spend. */
  isPlaceholder?: boolean;
  /** The paying advertiser + invoice record, when there is one. */
  advertiserAccount?: AdvertiserAccount;
}

// ---------- Chat protocol ----------

export type Role = "system" | "user" | "assistant" | "tool";

export type ToolEventStatus = "running" | "done" | "error";

export interface ToolEvent {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolEventStatus;
  output?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * The assistant message as it actually happened: text, tool steps and ad cards
 * in the order the stream produced them. Freebuff intersperses inline ads
 * between the nodes of a response; rendering that honestly needs the order, and
 * the old `content` + `toolEvents[]` + `ads[]` triple threw it away — every ad
 * ended up after the prose no matter when it was served. `timeline` is the
 * ordered truth; the three legacy fields stay populated for older transcripts.
 */
export type TimelineItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; event: ToolEvent }
  | { kind: "ad"; ad: SponsoredAd };

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  toolEvents?: ToolEvent[];
  ads?: SponsoredAd[]; // inline sponsored cards interleaved in this message
  /** Ordered transcript of this turn when the client kept one (newer saves). */
  timeline?: TimelineItem[];
  usage?: Usage;
  costUsd?: number;
  error?: string;
  model?: string;
  /** Files the user attached to this turn. Stored server-side by id, so the
   * bytes never ride in localStorage with the transcript. */
  attachments?: Attachment[];
  /** Thinking intensity this turn ran at, as chosen in the composer. */
  thinking?: ThinkingIntensity;
  /** Skills that were active for this turn. */
  skills?: string[];
  /** Tool access this turn ran at (full = may write and run commands). */
  access?: AccessMode;
}

/**
 * How much of the machine a turn may touch. `full` is the working default —
 * the agent reads, writes and runs commands like any coding agent. `readonly`
 * strips every tool that could change anything (writes, edits, command runs,
 * even run_tests, which executes project scripts), leaving pure reading and
 * searching. Enforced server-side at tool-execution time, not just in the prompt.
 */
export type AccessMode = "full" | "readonly";

/** Tools a readonly turn may never reach, whatever the prompt asks for. */
export const READONLY_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "run_command",
  "run_tests",
]);

// ---------- Attachments ----------

export type AttachmentKind = "image" | "text";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  kind: AttachmentKind;
}

// ---------- Skills ----------

/**
 * A skill is a named way of working: extra instructions plus the tools it needs.
 * Selecting one at send time shapes the turn without the user writing a prompt
 * for it, and the same catalog is what the /skills endpoint advertises.
 */
export interface Skill {
  id: string;
  name: string;
  blurb: string;
  /** Appended to the system prompt when the skill is active. */
  instructions: string;
  /** Tool names this skill is allowed to use. Empty = the full tool set. */
  tools: string[];
  builtin?: boolean;
}

// ---------- Thinking intensity ----------

/** How much deliberation to buy per upstream call. Maps to OpenRouter's
 * `reasoning.effort` and OpenAI's `reasoning_effort`. */
export type ThinkingIntensity = "off" | "low" | "medium" | "high";

// ---------- Workspace tools ----------

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  output: string;
}

// ---------- SSE wire protocol (agent chat) ----------

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; event: ToolEvent }
  | { type: "ad"; ad: SponsoredAd }
  /** costUsd is what was debited; actualUsd is present when the provider
   * reported its real charge, which we prefer over the price-table estimate.
   * costMethod records which of the two the ledger booked. */
  | { type: "usage"; usage: Usage; costUsd: number; actualUsd?: number; costMethod?: string }
  /** Something the server did that the user should know about but that is not an
   * error — an approved fallback being taken, for instance. */
  | { type: "notice"; message: string }
  /** Sent once at the start of a turn: which model was chosen and what funded
   * it, so the economics of a request are visible rather than implied. */
  | { type: "funding"; funding: FundingSnapshot; model: string; estimatedCostUsd: number }
  | { type: "done" }
  | { type: "error"; message: string; needsSetup?: boolean };

// ---------- Model catalog (catalog name -> upstream mapping) ----------

export type ProviderKind = "openai" | "anthropic" | "google" | "openrouter" | "custom";

export interface UpstreamMapping {
  provider: ProviderKind;
  model: string; // real upstream model id
  baseUrl?: string;
}

export interface ModelInfo {
  id: string; // catalog id (what clients request)
  label: string; // display name
  blurb: string;
  contextWindow: number;
  priceIn: number; // USD per 1M input tokens (for spend accounting)
  priceOut: number;
  /**
   * Free-tier eligibility: the provider charges $0 for this route, so serving it
   * costs Infyield nothing and no ad revenue is consumed by it.
   *
   * This is a claim about the *provider's* price, not a marketing label, and it
   * is checked against OpenRouter's live catalog rather than assumed — an
   * `:free` suffix and a `0/0` pricing pair, or the `openrouter/free` router.
   * A model wrongly marked free would silently spend real money under a "free"
   * badge, so `router.ts` treats the flag as policy and the price fields as the
   * ledger's authority.
   */
  free?: boolean;
  /** Whether the server is willing to serve this model at all. */
  enabled?: boolean;
  /**
   * Whether a turn on this model may be refused when earned revenue is thin.
   * Only meaningful for models that cost money; a free route is never gated.
   */
  supportsTools?: boolean;
  /** Largest output the server will ask this model for. */
  maxOutputTokens?: number;
  /** Largest input this model may be sent before the router refuses the turn. */
  maxRequestTokens?: number;
  /**
   * What happens when the first-choice upstream cannot serve.
   *   `none`      — fail. Never quietly route somewhere else.
   *   `free-only` — may fall back, but only onto another $0 route.
   *   `same-tier` — may fall back onto any model in the same price tier.
   */
  fallbackPolicy?: "none" | "free-only" | "same-tier";
  /** Hard ceiling on a single turn's predicted spend, in USD. */
  maxTurnCostUsd?: number;
  /** Price ceiling sent to the aggregator, so it cannot silently pick a more
   * expensive upstream than the catalog priced. USD per 1M tokens. */
  maxPricePerMTokIn?: number;
  maxPricePerMTokOut?: number;
  /** 'free' | 'standard' | 'premium' — derived, but explicit in the catalog. */
  tier?: "free" | "standard" | "premium";
  /** Freebuff-style routing chain: try the direct provider first, then fall
   * back (typically OpenRouter). The first hop the *deployment* holds a
   * credential for serves the request, subject to the model's fallback policy. */
  upstream: UpstreamMapping;
  fallbacks?: UpstreamMapping[];
  unmetered?: boolean;
  tags?: string[];
  /** Heavyweight tier: expensive per turn, so it is gated behind earned ad
   * revenue rather than being freely selectable. */
  premium?: boolean;
  /** Confirmed ad revenue the ledger must hold before this model may be served
   * in ad-funded mode. Below it the router refuses, instead of spending money
   * the ads have not earned yet. Ignored in BYOK mode, where the caller's own
   * provider key is billed directly and the ledger is not the constraint. */
  requiresBalanceUsd?: number;
}

// ---------- Economy (ad revenue vs API spend, USD) ----------

export interface LedgerEntry {
  id: number;
  ts: number;
  delta: number;
  /**
   * `refund` is deliberately its own kind rather than a negative `spend`:
   * "what we were charged" and "what we got back" are the two sides a
   * reconciliation compares, and netting them into one number destroys the
   * comparison. `grant` is an operator adjustment that credits revenue.
   */
  kind: "ad-impression" | "ad-click" | "spend" | "grant" | "payout" | "estimate" | "reconcile" | "refund";
  note: string;
  model?: string;
  campaignId?: string;
  /** true while the money is booked but not yet paid by the advertiser/network */
  pending?: boolean;
  /**
   * The external thing this entry is *about*, so a figure can always be traced
   * back past the ledger to the provider or ad-network record that caused it.
   * `model-spend` entries carry the request id; ad entries carry the network's
   * own event/creative id. Never synthesised — an entry without one is one we
   * cannot reconcile, and saying so is the point.
   */
  sourceId?: string;
  /**
   * Which side moved the money, for reconciliation and for honest labelling.
   *
   * `house` is the one that is not money: revenue booked from inventory with no
   * external payer. It is recorded so delivery stays measurable and is excluded
   * from every spendable figure by `funds.ts`.
   */
  origin?: "provider" | "advertiser" | "network" | "operator" | "house";
  /** Who served the request, and whether its figure came from the provider. */
  provider?: string;
  costMethod?: "provider-reported" | "catalog-calculated" | "fixed-cpm" | "estimated";
}

export interface EconomyState {
  adRevenueUsd: number; // confirmed, invoiceable ad revenue
  estimatedRevenueUsd: number; // served-but-unreconciled network revenue
  spendUsd: number;
  balanceUsd: number; // confirmed ad revenue − api spend − payouts
  payoutsUsd: number;
  availableUsd: number; // confirmed ad revenue not yet paid out
  impressions: number;
  clicks: number;
  entries: LedgerEntry[];
  /**
   * The five figures as *concepts*, never merged into one number.
   *
   * Pending money has not been paid by anybody, so it can never be spent.
   * Confirmed money is owed and invoiceable. Available is what is left of
   * confirmed after money has actually been spent and paid out. Spend is what
   * the providers charged. Net is confirmed − spend: the operating result.
   * A single "balance" conflates all five and is exactly how a system talks
   * itself into believing an unpayable number is income.
   */
  pendingUsd: number;
  confirmedUsd: number;
  modelSpendUsd: number;
  netUsd: number;
}

// ---------- Settings ----------

export interface AdsSettings {
  network: "house" | "ethicalads" | "carbon";
  ethicalAdsPublisherId: string;
  /** Carbon Ads (BuySellAds) placement id — their serve API is public once an
   * application is approved; each fetch of a paid creative counts an impression. */
  carbonPlacementId?: string;
  cpmUsd: number; // fallback value of an impression when the campaign has none
  clickBonusUsd: number;
  cadenceSteps: number; // first ad after N tool steps, then every N
  maxAdsPerResponse: number;
  enabled: boolean; // always true in Freebuff mode; kept for operator control
}

/**
 * How much may be spent on providers, and under what floor.
 *
 * Separate from the ad settings on purpose: this is the *spending* policy, and
 * the whole point of keeping it explicit is that "can we afford this request?"
 * has a reviewable answer rather than being implied by whatever the account
 * happens to hold.
 */
export interface FundingPolicy {
  /** Revenue that must remain unspent at all times. */
  reserveUsd: number;
  /** Ceiling on provider spend per calendar day. 0 = no cap. */
  dailySpendCapUsd: number;
  /** Hard ceiling on any single request's predicted cost. 0 = no cap. */
  maxRequestCostUsd: number;
  /** Model requests one day may start, across every session. 0 = no cap. */
  perSessionDailyRequests: number;
  /** Operator kill switch: refuse every new request. */
  emergencyStop: boolean;
}

export interface AppSettings {
  workspaceRoot: string;
  /** Folders the operator has pointed the agent at, newest first — the
   * project switcher's list. The current root stays first. */
  recentWorkspaces?: string[];
  apiPassword: string; // bearer for /v1/chat/completions; empty = open
  adminPassword: string; // guard for /api/admin/*; empty = open (local)
  ads: AdsSettings;
  /** Where confirmed ad revenue is sent. Purely a label on the ledger entry. */
  payoutAccount: string;
  /** Auto-pull a real ad from the network when available (else house ads). */
  useNetworkAds: boolean;
  /** Balance the Earn panel is saving towards; 0 means no target set. */
  earnTargetUsd?: number;
  /** Default deliberation level for new conversations. */
  thinking?: ThinkingIntensity;
  /** Skills preselectable by default (ids from src/lib/skills.ts). */
  defaultSkills?: string[];
  /** Seconds a workspace command may run before it is killed. */
  commandTimeoutSec?: number;
  /** How invoices are collected: nothing, a static link, or Stripe checkout. */
  payments?: PaymentsSettings;
  /** Provider-spend admission control. See src/lib/funding.ts. */
  funding?: FundingPolicy;
}

// ---------- Chats (client-side persistence) ----------

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelId: string;
  messages: ChatMessage[];
  /** Composer state travels with the conversation, so reopening a chat restores
   * the model, the thinking level, the skills and the tool access it was being
   * worked on with. */
  thinking?: ThinkingIntensity;
  skills?: string[];
  access?: AccessMode;
}
