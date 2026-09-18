import { NextRequest } from "next/server";
import { listModels } from "@/lib/modelstore";
import { requireApi } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** OpenAI-compatible model listing: point any client at our server. */
export async function GET(req: NextRequest) {
  const denied = requireApi(req);
  if (denied) return denied;
  return Response.json({
    object: "list",
    data: listModels().map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(m.contextWindow / 1000),
      owned_by: "infyield",
      // extras our UI uses
      label: m.label,
      blurb: m.blurb,
      unmetered: m.unmetered ?? false,
      context_window: m.contextWindow,
    })),
  });
}
