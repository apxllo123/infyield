import { NextRequest } from "next/server";
import type { PaymentProviderKind } from "@/lib/types";
import { requireAdmin } from "@/lib/auth";
import {
  createInvoicePayLink,
  invoiceMessage,
  publicPayments,
  reconcileProviderPayments,
  savePaymentSettings,
  testPaymentProvider,
} from "@/lib/payments";

export const dynamic = "force-dynamic";

const PROVIDERS: PaymentProviderKind[] = ["none", "link", "stripe"];

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return Response.json({ payments: publicPayments() });
}

export async function PATCH(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (b.provider !== undefined && !PROVIDERS.includes(b.provider as PaymentProviderKind)) {
    return Response.json({ error: `provider must be one of ${PROVIDERS.join(", ")}` }, { status: 400 });
  }
  if (b.linkUrl !== undefined) {
    const url = String(b.linkUrl).trim();
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") {
          return Response.json({ error: "A payment link must be https." }, { status: 400 });
        }
      } catch {
        return Response.json({ error: `"${url}" is not a valid URL.` }, { status: 400 });
      }
    }
  }
  for (const field of ["successUrl", "cancelUrl"] as const) {
    if (b[field] === undefined) continue;
    const url = String(b[field]).trim();
    if (!url) continue;
    try {
      new URL(url);
    } catch {
      return Response.json({ error: `${field} must be a valid URL.` }, { status: 400 });
    }
  }
  if (b.stripeSecretKey !== undefined) {
    const key = String(b.stripeSecretKey).trim();
    // Stripe publishable keys start `pk_` and are useless here; catching the
    // obvious mix-up beats a confusing 401 later.
    if (key && !/^(rk|sk)_(test|live)_/.test(key)) {
      return Response.json(
        { error: "That does not look like a Stripe secret key. It should start rk_live_/rk_test_ (restricted) or sk_live_/sk_test_." },
        { status: 400 },
      );
    }
  }

  savePaymentSettings(b);
  return Response.json({ payments: publicPayments() });
}

/**
 * Actions that talk to the provider: `test` proves the credentials work using a
 * read-only call, `sync` pulls paid transactions in and records the new ones.
 * Both are explicit — nothing reaches out to a payment provider on its own.
 */
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { action?: string; campaignId?: string };

  if (b.action === "test") {
    const res = await testPaymentProvider();
    return Response.json({ ...res, payments: publicPayments() }, { status: res.ok ? 200 : 400 });
  }

  if (b.action === "sync") {
    const res = await reconcileProviderPayments();
    return Response.json({ ...res, payments: publicPayments() }, { status: res.ok ? 200 : 400 });
  }

  if (b.action === "pay-link") {
    if (!b.campaignId) return Response.json({ error: "campaignId required" }, { status: 400 });
    const res = await createInvoicePayLink(b.campaignId);
    if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
    return Response.json({ link: res.link });
  }

  if (b.action === "invoice-message") {
    if (!b.campaignId) return Response.json({ error: "campaignId required" }, { status: 400 });
    const res = invoiceMessage(b.campaignId);
    if (!res.ok) return Response.json({ error: "Campaign has no advertiser on record." }, { status: 404 });
    return Response.json({ text: res.text });
  }

  return Response.json({ error: "Unknown action." }, { status: 400 });
}
