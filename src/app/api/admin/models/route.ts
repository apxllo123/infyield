import { NextRequest } from "next/server";
import { addCustomModel, deleteCustomModel, listModels } from "@/lib/modelstore";
import type { ProviderKind } from "@/lib/types";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return Response.json({ models: listModels() });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as {
    label?: string;
    provider?: ProviderKind;
    upstreamModel?: string;
    baseUrl?: string;
    priceIn?: number;
    priceOut?: number;
    contextWindow?: number;
    tags?: string[] | string;
  };
  if (!b.label || !b.upstreamModel || !b.provider) {
    return Response.json({ error: "label, provider and upstreamModel required" }, { status: 400 });
  }
  const tags = Array.isArray(b.tags)
    ? b.tags
    : typeof b.tags === "string"
      ? b.tags.split(",").map((t) => t.trim())
      : [];
  const m = addCustomModel({
    label: b.label,
    provider: b.provider,
    upstreamModel: b.upstreamModel,
    baseUrl: b.baseUrl,
    priceIn: b.priceIn,
    priceOut: b.priceOut,
    contextWindow: b.contextWindow,
    tags,
  });
  return Response.json({ model: m });
}

export async function DELETE(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  deleteCustomModel(id);
  return Response.json({ ok: true });
}
