import { NextRequest } from "next/server";
import { serveAd } from "@/lib/ads";
import { clientFamilyFromUserAgent } from "@/lib/adlifecycle";
import { runAutoSetup } from "@/lib/autosetup";

export const dynamic = "force-dynamic";

/**
 * Freebuff-style ads serve endpoint: contextual targeting from sanitized
 * message history, normalized AdResponse back.
 */
export async function POST(req: NextRequest) {
  let body: { messages?: { role: string; content: string }[]; sessionId?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  // Full setup, not just seeding: ad settings an operator set through the
  // environment (a network publisher id, say) have to be in force before the
  // first serve, or an ad slot would earn nothing until some other page happened
  // to bootstrap first.
  runAutoSetup();

  const context = (body.messages ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-4)
    .map((m) => m.content)
    .join(" ");

  // The session comes from the body because it groups serves for the cap; the
  // client family does not, because a claim is never what classifies an event.
  const sessionId = body.sessionId ?? req.headers.get("x-infyield-session");
  const { ad, frequency } = await serveAd(context, [], {
    sessionId,
    clientFamily: clientFamilyFromUserAgent(req.headers.get("user-agent")),
  });
  return Response.json({
    ads: ad ? [ad] : [],
    provider: ad?.provider ?? "none",
    // A refusal is reported rather than looking like an empty auction, so a
    // caller can tell "the cap says no" from "nobody had an ad".
    ...(frequency && !frequency.allowed ? { refused: frequency.code, reason: frequency.reason } : {}),
  });
}
