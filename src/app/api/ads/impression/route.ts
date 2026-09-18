import { NextRequest } from "next/server";
import { recordImpression } from "@/lib/ads";
import { clampRenderDelayMs, clientFamilyFromUserAgent, readClientEventId } from "@/lib/adlifecycle";

export const dynamic = "force-dynamic";

/**
 * The client POSTs here when a card is actually on screen.
 *
 * Async because a network impression has to reach the ad network's own pixel
 * before any revenue is booked: the network pays for impressions it recorded, so
 * crediting the ledger first and firing the pixel in the background would mean
 * booking money that never arrives.
 *
 * Three inputs come off the wire, and each is read the same way: take the value
 * if it is well formed, otherwise fall back — never reject the request over
 * telemetry. Losing an impression is worse than losing the metadata about it.
 *
 *  - the event id (`X-Infyield-Event-Id`, or the legacy `X-Event-Id`), which is
 *    the idempotency key for this logical event across retries;
 *  - the render delay (`X-Infyield-Render-Delay-Ms`), clamped, and stored as
 *    null when unmeasurable rather than derived from the serve time;
 *  - the session, which groups serves for the per-session frequency cap.
 *
 * The client family is derived from the User-Agent server-side. A client can
 * claim any surface it likes, so a claim is never what classifies an event.
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const impressionId = url.searchParams.get("i") ?? "";
  const clientEventId = readClientEventId(
    req.headers.get("x-infyield-event-id"),
    req.headers.get("x-event-id"),
  );
  const renderDelayMs = clampRenderDelayMs(req.headers.get("x-infyield-render-delay-ms"));
  const sessionId = req.headers.get("x-infyield-session") ?? url.searchParams.get("s");

  const res = await recordImpression({
    impressionId,
    clientEventId,
    sessionId,
    clientFamily: clientFamilyFromUserAgent(req.headers.get("user-agent")),
    renderDelayMs,
  });
  if (!res.ok) return Response.json({ error: "unknown impression" }, { status: 404 });
  return Response.json(
    {
      ok: true,
      alreadyRecorded: res.alreadyRecorded ?? false,
      creditedUsd: res.creditedUsd ?? 0,
      ...(res.stage ? { stage: res.stage } : {}),
      ...(res.pending ? { pending: true } : {}),
      ...(res.warning ? { warning: res.warning } : {}),
    },
    {
      // Mirrors how Freebuff signals a deduplicated ack, so a client can tell
      // "already counted" from "counted now" without parsing the body.
      headers: res.alreadyRecorded
        ? { "x-infyield-ack-outcome": "deduped" }
        : { "x-infyield-ack-outcome": "accepted" },
    },
  );
}

export async function GET(req: NextRequest) {
  return POST(req);
}
