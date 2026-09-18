import { NextRequest } from "next/server";
import { getState } from "@/lib/economy";
import { fundingStatus, runAutoSetup } from "@/lib/autosetup";
import { deliveryReport } from "@/lib/ads";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Where the money stands: what ads earned (confirmed + pending), what the
 * models cost, and what has actually been paid out. */
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  runAutoSetup();
  return Response.json({
    ...getState(),
    funding: fundingStatus(),
    delivery: deliveryReport(),
  });
}
