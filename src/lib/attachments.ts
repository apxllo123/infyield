import fs from "fs";
import path from "path";
import type { Attachment, AttachmentKind } from "./types";
import { dataPath, readJson, writeJson } from "./store";

/**
 * Attachments: files the user hands the agent with a message.
 *
 * Bytes live in the data directory, never in the transcript. The client keeps
 * only `{ id, name, mime, sizeBytes, kind }` per attachment, which is what makes
 * it safe to persist a conversation in localStorage — a 4 MB screenshot would
 * blow the quota instantly if it rode along with the messages.
 *
 * At request time `hydrateMessages` expands them into wire parts: images become
 * data-URL image parts (both OpenAI-compatible and Anthropic accept base64), and
 * text files are inlined as fenced blocks so the model sees the contents without
 * needing a tool round trip.
 */

const INDEX = "attachments.json";
const DIR = "uploads";

/** Images are sent whole to the model, so the cap has to be about what a
 * provider will accept, not about disk. 8 MB is comfortably inside every
 * vision endpoint's limit. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Text is inlined into the prompt, so it must stay bounded by context. */
export const MAX_TEXT_BYTES = 512 * 1024;

interface IndexEntry extends Attachment {
  createdAt: number;
}

export interface SaveInput {
  name: string;
  mime: string;
  bytes: Buffer;
}

export function classify(mime: string, name: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  const ext = path.extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"].includes(ext)) return "image";
  return "text";
}

function index(): IndexEntry[] {
  return readJson<IndexEntry[]>(INDEX, []);
}

function saveIndex(entries: IndexEntry[]): void {
  writeJson(INDEX, entries);
}

/** Persist one uploaded file and return its transcript-side descriptor. */
export function saveAttachment(input: SaveInput): Attachment | { error: string } {
  const name = path.basename(input.name || "attachment");
  const kind = classify(input.mime, name);
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  if (!input.bytes.length) return { error: `${name} is empty.` };
  if (input.bytes.length > limit) {
    return {
      error: `${name} is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB — the limit is ${(limit / 1024 / 1024).toFixed(0)} MB for ${kind === "image" ? "images" : "text files"}.`,
    };
  }
  const id = crypto.randomUUID();
  fs.writeFileSync(dataPath(DIR, id), input.bytes);
  const meta: Attachment = {
    id,
    name,
    mime: input.mime || (kind === "image" ? "image/png" : "text/plain"),
    sizeBytes: input.bytes.length,
    kind,
  };
  const entries = index().filter((e) => e.id !== id);
  entries.unshift({ ...meta, createdAt: Date.now() });
  // Keep the index bounded; the newest 500 is far beyond a chat's lifetime.
  saveIndex(entries.slice(0, 500));
  return meta;
}

export function listAttachments(): Attachment[] {
  return index().map(({ id, name, mime, sizeBytes, kind }) => ({ id, name, mime, sizeBytes, kind }));
}

export function readAttachment(id: string): { meta: Attachment; bytes: Buffer } | null {
  const entry = index().find((e) => e.id === id);
  if (!entry) return null;
  const file = path.join(dataPath(DIR, id));
  if (!fs.existsSync(file)) return null;
  return { meta: entry, bytes: fs.readFileSync(file) };
}

export function deleteAttachment(id: string): boolean {
  const entries = index();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  saveIndex(next);
  try {
    fs.unlinkSync(path.join(dataPath(DIR, id)));
  } catch {
    // Index removal is what matters; a missing blob is already gone.
  }
  return true;
}

/** One file the model will actually see, in wire-ready form. */
export interface HydratedAttachment {
  name: string;
  kind: AttachmentKind;
  /** Data URL for images; undefined for text. */
  dataUrl?: string;
  /** File contents for text; undefined for images. */
  text?: string;
  truncated?: boolean;
  missing?: boolean;
}

/**
 * Load the bytes for a message's attachments. Failures are reported per file
 * rather than thrown: one unreadable attachment must not kill the turn, and the
 * model should be told the file was unavailable instead of silently getting a
 * prompt that pretends it was never attached.
 */
export function hydrateAttachments(attachments: Attachment[] | undefined): HydratedAttachment[] {
  if (!attachments?.length) return [];
  const out: HydratedAttachment[] = [];
  for (const a of attachments) {
    const stored = readAttachment(a.id);
    if (!stored) {
      out.push({ name: a.name, kind: a.kind, missing: true });
      continue;
    }
    if (a.kind === "image") {
      out.push({
        name: a.name,
        kind: "image",
        dataUrl: `data:${stored.meta.mime};base64,${stored.bytes.toString("base64")}`,
      });
    } else {
      const raw = stored.bytes.toString("utf8");
      const cap = 120_000; // characters, not bytes: context is the real limit
      out.push({
        name: a.name,
        kind: "text",
        text: raw.length > cap ? raw.slice(0, cap) : raw,
        truncated: raw.length > cap,
      });
    }
  }
  return out;
}

/** The prompt-visible manifest of what was attached, for the model's benefit. */
export function attachmentManifest(attachments: HydratedAttachment[]): string {
  const lines: string[] = [];
  for (const a of attachments) {
    if (a.missing) lines.push(`- ${a.name}: could not be read (empty or removed)`);
    else if (a.kind === "image") lines.push(`- ${a.name}: image, attached below`);
    else lines.push(`- ${a.name}: text file${a.truncated ? ", truncated to 120k characters" : ""}, contents included`);
  }
  return lines.length ? `The user attached ${lines.length} file(s) to this message:\n${lines.join("\n")}` : "";
}
