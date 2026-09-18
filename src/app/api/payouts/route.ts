import { NextRequest } from "next/server";
import { getState, recordPayout, reconcileRevenue } from "@/lib/economy";
import { getSettings, saveSettings } from "@/lib/settings";
import { deliveryReport } from "@/lib/ads";
import { collectibleRevenueUsd, placeholderRevenueUsd, spendableUsd } from "@/lib/funds";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * What may genuinely leave the account.
 *
 * `recordPayout` in economy.ts caps a payout at the ledger's booked revenue, and
 * it has to: it is the ledger primitive and cannot import funds.ts without a
 * cycle. But booked revenue includes placeholder inventory — the seeded house
 * campaigns with no advertiser behind them — so that cap alone would happily
 * record paying out money nobody has ever paid in. The ceiling that matters is
 * collectible revenue minus spend minus payouts, the same figure the reserve-tier
 * gate spends against, and it is enforced here where both modules are importable.
 */
function payableUsd(): number {
  return Math.max(0, spendableUsd());
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return Response.json({
    ...getState(),
    // The honest ceiling, so the payout form cannot pre-fill an amount that will
    // be refused — and cannot imply placeholder revenue is liquid.
    payableUsd: payableUsd(),
    collectibleUsd: collectibleRevenueUsd(),
    placeholderUsd: placeholderRevenueUsd(),
    delivery: deliveryReport(),
    account: getSettings().payoutAccount,
  });
}

/**
 * POST { action, amount, note }
 *   action=account   — set the label of the account ad money is paid into
 *   action=payout    — move confirmed ad revenue out to your account
 *   action=reconcile — the network/advertiser statement landed: convert pending
 *                      estimated revenue into confirmed revenue (draws on the
 *                      pending bucket, so it can never invent money)
 */
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { action?: string; amount?: number; note?: string };
  const action = b.action ?? "payout";

  if (action === "account") {
    const s = getSettings();
    const next = { ...s, payoutAccount: (b.note ?? "").slice(0, 120) };
    saveSettings(next);
    return Response.json(getState());
  }

  if (action === "reconcile") {
    const res = reconcileRevenue(b.amount === undefined ? undefined : Number(b.amount), b.note);
    if ("error" in res) return Response.json({ error: res.error }, { status: 400 });
    return Response.json(res);
  }

  const amount = Number(b.amount ?? 0);
  const payable = payableUsd();
  if (amount > payable + 1e-9) {
    const placeholder = placeholderRevenueUsd();
    return Response.json(
      {
        error:
          `Only $${payable.toFixed(4)} is payable — collectible revenue minus model spend and earlier payouts.` +
          (placeholder > 0.0001
            ? ` $${placeholder.toFixed(4)} of the ledger is placeholder inventory from seeded campaigns, which no advertiser will ever pay and which cannot be paid out.`
            : ""),
      },
      { status: 400 },
    );
  }

  const res = recordPayout(amount, b.note || `Payout to ${getSettings().payoutAccount || "operator account"}`);
  if ("error" in res) return Response.json({ error: res.error }, { status: 400 });
  return Response.json(res);
}
