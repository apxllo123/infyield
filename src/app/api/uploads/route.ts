import { NextRequest } from "next/server";
import type { Attachment } from "@/lib/types";
import { deleteAttachment, listAttachments, saveAttachment } from "@/lib/attachments";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Attachment upload.
 *
 * Two shapes, because the composer has two entry points: a file picker/drop
 * sends multipart (the browser streams the bytes, no base64 inflation), and a
 * clipboard paste sends a JSON data URL, which is the only thing a paste event
 * offers. Both end up in the same store.
 *
 * The body is deliberately not part of the chat request: uploading once means
 * re-sends of the conversation (every tool step re-sends the context) don't
 * re-upload megabytes.
 *
 * Admin-guarded: this writes files into the app's own data directory, which is
 * the last endpoint that should have been open to anything that could reach the
 * port.
 */
export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const type = req.headers.get("content-type") ?? "";
  const saved: Attachment[] = [];
  const errors: string[] = [];

  if (type.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return Response.json({ error: "Invalid multipart body" }, { status: 400 });
    for (const value of form.getAll("file")) {
      if (!(value instanceof File)) continue;
      const bytes = Buffer.from(await value.arrayBuffer());
      const res = saveAttachment({ name: value.name || "attachment", mime: value.type, bytes });
      if ("error" in res) errors.push(res.error);
      else saved.push(res);
    }
  } else {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      mime?: string;
      dataUrl?: string;
      base64?: string;
    };
    const encoded = body.base64 ?? (body.dataUrl?.includes(",") ? body.dataUrl.split(",")[1] : body.dataUrl);
    if (!encoded) return Response.json({ error: "file or dataUrl required" }, { status: 400 });
    const mimeFromUrl = body.dataUrl?.match(/^data:([^;]+);/)?.[1];
    const res = saveAttachment({
      name: body.name || "pasted",
      mime: body.mime || mimeFromUrl || "application/octet-stream",
      bytes: Buffer.from(encoded, "base64"),
    });
    if ("error" in res) errors.push(res.error);
    else saved.push(res);
  }

  if (!saved.length) {
    return Response.json({ error: errors[0] ?? "Nothing to upload" }, { status: 400 });
  }
  return Response.json({ attachments: saved, ...(errors.length ? { warnings: errors } : {}) });
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  return Response.json({ attachments: listAttachments() });
}

export async function DELETE(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  deleteAttachment(id);
  return Response.json({ ok: true });
}
