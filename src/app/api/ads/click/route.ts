import { NextRequest } from "next/server";
import { recordClick } from "@/lib/ads";
import { clientFamilyFromUserAgent, readClientEventId } from "@/lib/adlifecycle";

export const dynamic = "force-dynamic";

/**
 * Records the click, then hands back the advertiser URL for the client to open.
 *
 * A click is always its own event with its own id: it is never inferred from a
 * render, a hover, or dwell time, and it is deduplicated server-side so a
 * double-tap or a retried beacon counts once.
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const impressionId = url.searchParams.get("i") ?? "";
  const clientEventId = readClientEventId(
    req.headers.get("x-infyield-event-id"),
    req.headers.get("x-event-id"),
  );
  const sessionId = req.headers.get("x-infyield-session") ?? url.searchParams.get("s");

  const res = await recordClick({
    impressionId,
    clientEventId,
    sessionId,
    clientFamily: clientFamilyFromUserAgent(req.headers.get("user-agent")),
  });
  if (!res.ok) return Response.json({ error: "unknown impression" }, { status: 404 });
  return Response.json(
    {
      ok: true,
      alreadyRecorded: res.alreadyRecorded ?? false,
      creditedUsd: res.creditedUsd ?? 0,
      ...(res.pending ? { pending: true } : {}),
      url: res.url,
    },
    {
      headers: res.alreadyRecorded
        ? { "x-infyield-ack-outcome": "deduped" }
        : { "x-infyield-ack-outcome": "accepted" },
    },
  );
}
