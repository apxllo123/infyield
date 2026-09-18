import { NextRequest } from "next/server";
import type { InvoiceStatus, PaymentTerms } from "@/lib/types";
import {
  addCampaign,
  attachAdvertiser,
  billingSummary,
  campaignBilling,
  deleteCampaign,
  detachAdvertiser,
  listCampaigns,
  recordInvoicePayment,
  removeInvoicePayment,
  seedHouseAdsIfEmpty,
  setInvoiceStatus,
  updateCampaign,
} from "@/lib/ads";
import { requireAdmin } from "@/lib/auth";
import { revenueBreakdown } from "@/lib/funds";

export const dynamic = "force-dynamic";

const TERMS: PaymentTerms[] = ["prepaid", "net15", "net30", "net60"];
const STATUSES: InvoiceStatus[] = ["draft", "issued", "paid"];

function accountInput(b: Record<string, unknown>) {
  return {
    name: String(b.name ?? b.advertiser ?? ""),
    contact: b.contact === undefined ? undefined : String(b.contact),
    terms: TERMS.includes(b.terms as PaymentTerms) ? (b.terms as PaymentTerms) : undefined,
    status: STATUSES.includes(b.status as InvoiceStatus) ? (b.status as InvoiceStatus) : undefined,
    amountUsd: b.amountUsd === undefined ? undefined : Number(b.amountUsd),
    note: b.note === undefined ? undefined : String(b.note),
    invoiceId: b.invoiceId === undefined ? undefined : String(b.invoiceId),
    // Accepts an epoch ms or an ISO/`YYYY-MM-DD` date, because the UI sends a date
    // input's value and a caller sending raw JSON has a timestamp.
    issuedAt: dateInput(b.issuedAt),
  };
}

function dateInput(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  seedHouseAdsIfEmpty();
  const billing = campaignBilling();
  return Response.json({
    campaigns: listCampaigns(),
    // Computed server-side so the UI never has to re-derive what an advertiser
    // owes by summing a truncated ledger of its own.
    billing,
    receivables: billingSummary(billing),
    revenue: revenueBreakdown(),
  });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!b.title || !b.url) return Response.json({ error: "title and url required" }, { status: 400 });
  const c = addCampaign({
    title: String(b.title),
    adText: String(b.adText ?? ""),
    cta: String(b.cta ?? "Learn more"),
    url: String(b.url),
    advertiser: String(b.advertiser ?? "House"),
    ...(typeof b.icon === "string" && b.icon.trim() ? { icon: b.icon.trim() } : {}),
    cpmUsd: Number(b.cpmUsd ?? 2),
    cpcUsd: Number(b.cpcUsd ?? 0.5),
    budgetUsd: Number(b.budgetUsd ?? 0),
    keywords: Array.isArray(b.keywords) ? (b.keywords as string[]) : String(b.keywords ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    weight: Number(b.weight ?? 1),
    active: b.active !== false,
  });

  // Creating a campaign for a paying advertiser in one step: the invoice is
  // minted from what the campaign has delivered (nothing yet, so $0.00 is
  // replaced by the real accrual as impressions land — the invoice view shows it).
  if (b.backedBy || b.name) {
    const withAccount = attachAdvertiser(c.id, accountInput({ ...b, name: String(b.backedBy ?? b.name) }));
    if ("error" in withAccount) return Response.json({ error: withAccount.error }, { status: 400 });
    return Response.json({ campaign: withAccount });
  }
  return Response.json({ campaign: c });
}

export async function PATCH(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { id?: string; action?: string } & Record<string, unknown>;
  if (!b.id) return Response.json({ error: "id required" }, { status: 400 });

  if (b.action === "attach-advertiser") {
    const c = attachAdvertiser(b.id, accountInput(b));
    if ("error" in c) return Response.json({ error: c.error }, { status: 400 });
    return Response.json({ campaign: c, billing: campaignBilling() });
  }
  if (b.action === "invoice-status") {
    if (!STATUSES.includes(b.status as InvoiceStatus)) {
      return Response.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
    }
    const c = setInvoiceStatus(b.id, b.status as InvoiceStatus);
    if ("error" in c) return Response.json({ error: c.error }, { status: 400 });
    return Response.json({ campaign: c, billing: campaignBilling() });
  }
  if (b.action === "record-payment") {
    const c = recordInvoicePayment(b.id, {
      amountUsd: Number(b.amountUsd),
      receivedAt: b.receivedAt === undefined ? undefined : Number(b.receivedAt),
      method: b.method === undefined ? undefined : String(b.method),
      reference: b.reference === undefined ? undefined : String(b.reference),
      note: b.note === undefined ? undefined : String(b.note),
    });
    if ("error" in c) return Response.json({ error: c.error }, { status: 400 });
    return Response.json({ campaign: c, billing: campaignBilling() });
  }
  if (b.action === "remove-payment") {
    const c = removeInvoicePayment(b.id, String(b.paymentId ?? ""));
    if ("error" in c) return Response.json({ error: c.error }, { status: 404 });
    return Response.json({ campaign: c, billing: campaignBilling() });
  }
  if (b.action === "detach-advertiser") {
    const c = detachAdvertiser(b.id);
    if ("error" in c) return Response.json({ error: c.error }, { status: 404 });
    return Response.json({ campaign: c, billing: campaignBilling() });
  }

  const { id, action, ...patch } = b;
  void action;
  const c = updateCampaign(id, patch);
  if (!c) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ campaign: c, billing: campaignBilling() });
}

export async function DELETE(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  deleteCampaign(id);
  return Response.json({ ok: true });
}
