"use client";

import Link from "next/link";
import type { Chat, LedgerEntry } from "@/lib/types";
import type { UiModel, WorkspaceEntry } from "@/lib/client/api";
import { bytes, chatSummary, clockTime, compactNumber, timeAgo, usd, usdSigned } from "@/lib/client/format";
import { IconArrowRight, IconBolt, IconChat, IconFile, IconFolder, IconSparkle } from "./icons";

/* ========================= conversations ================================= */

export function ConversationCard({ chat, modelLabel, onOpen }: { chat: Chat; modelLabel?: string; onOpen: () => void }) {
  const turns = chat.messages.filter((m) => m.role === "user").length;
  return (
    <button onClick={onOpen} className="glass card-hover tile-hover sheen w-[312px] text-left">
      <div className="flex items-center justify-between gap-3">
        <span className="grid h-8 w-8 place-items-center rounded-[var(--r-xs)] border border-[var(--border-1)] bg-[var(--surface-1)] text-[var(--text-3)]">
          <IconChat size={15} />
        </span>
        <span className="t-micro">{timeAgo(chat.updatedAt)}</span>
      </div>
      <div className="mt-4 truncate text-[15px] font-medium text-[var(--text-1)]">{chat.title}</div>
      <p className="t-meta mt-1.5 line-clamp-2 h-[38px] leading-relaxed">{chatSummary(chat.messages)}</p>
      <div className="mt-4 flex items-center gap-2">
        <span className="chip chip-muted">{turns} {turns === 1 ? "turn" : "turns"}</span>
        {modelLabel && <span className="chip truncate">{modelLabel}</span>}
      </div>
    </button>
  );
}

/* ============================== models =================================== */

export function ModelCard({
  model,
  active,
  onUse,
  width = 320,
}: {
  model: UiModel;
  active?: boolean;
  onUse: () => void;
  /** A number pins the card in a rail; "full" lets it fill a grid cell. */
  width?: number | "full";
}) {
  return (
    <button
      onClick={onUse}
      style={typeof width === "number" ? { width } : undefined}
      className={`glass card-hover tile-hover sheen group text-left ${width === "full" ? "w-full" : ""} ${active ? "border-[rgba(53,224,161,0.4)]" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r-xs)] border ${
            model.available ? "border-[rgba(53,224,161,0.28)] bg-[rgba(53,224,161,0.09)] text-[var(--mint)]" : "border-[var(--border-1)] bg-[var(--surface-1)] text-[var(--text-4)]"
          }`}
        >
          <IconSparkle size={16} />
        </span>
        <span className="flex flex-wrap justify-end gap-1.5">
          {model.premium && (
            <span className={`chip ${model.unlocked ? "chip-amber" : "chip-muted"}`}>
              {model.unlocked ? "reserve" : `needs $${model.requiresBalanceUsd.toFixed(2)}`}
            </span>
          )}
          {model.unmetered && <span className="chip chip-mint">unmetered</span>}
          {!model.available && <span className="chip chip-muted">no key</span>}
          {active && <span className="chip chip-mint">active</span>}
        </span>
      </div>

      <div className="mt-4 truncate text-[15.5px] font-medium tracking-[-0.01em] text-[var(--text-1)]">{model.label}</div>
      <div className="t-micro mt-1 uppercase tracking-[0.14em]">{model.via ?? "needs a key"}</div>
      <p className="t-meta mt-2.5 line-clamp-2 h-[38px] leading-relaxed">{model.blurb}</p>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        <span className="chip">{compactNumber(model.contextWindow)} ctx</span>
        {model.priceIn === 0 && model.priceOut === 0 ? (
          <span className="chip">no charge</span>
        ) : (
          <span className="chip num">
            ${model.priceIn.toFixed(2)} in · ${model.priceOut.toFixed(2)} out
          </span>
        )}
        {/* Two decimals here: a representative turn is a headline figure, and
            four decimals reads like a meter reading rather than a price. */}
        {model.premium && <span className="chip num">≈{usd(model.typicalTurnUsd, 2)} per turn</span>}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <span className="t-micro">per 1M tokens · metered to the ledger</span>
        <span className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-3)] transition-colors group-hover:text-[var(--text-1)]">
          Use model
          <IconArrowRight size={13} />
        </span>
      </div>
    </button>
  );
}

/* ============================= workspace ================================= */

/** Display-only by design: the agent reads and edits these files, the client
 * has no editor to open them in, so no button is offered. */
export function FileTile({ entry }: { entry: WorkspaceEntry }) {
  return (
    <div className="glass-quiet tile w-[212px]">
      <div className="flex items-center justify-between gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-[var(--r-xs)] border border-[var(--border-1)] text-[var(--text-3)]">
          {entry.kind === "dir" ? <IconFolder size={14} /> : <IconFile size={14} />}
        </span>
        {entry.kind === "file" && entry.ext && <span className="chip chip-muted">{entry.ext}</span>}
      </div>
      <div className="mt-3.5 truncate text-[13.5px] text-[var(--text-1)]" title={entry.name}>
        {entry.name}
      </div>
      <div className="t-micro mt-1">
        {entry.kind === "dir" ? "folder" : bytes(entry.sizeBytes)} · {timeAgo(entry.modifiedAt)}
      </div>
    </div>
  );
}

/* ============================== activity ================================= */

export function ActivityRow({ entry }: { entry: LedgerEntry }) {
  const incoming = entry.delta >= 0;
  const pending = entry.pending;
  return (
    <div className="flex items-center gap-3.5 border-t border-[var(--border-1)] py-3 first:border-0">
      <span
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border ${
          incoming ? "border-[rgba(53,224,161,0.3)] bg-[rgba(53,224,161,0.1)] text-[var(--mint)]" : "border-[var(--border-2)] bg-[var(--surface-1)] text-[var(--text-3)]"
        }`}
      >
        {incoming ? <IconBolt size={13} /> : <IconChat size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-[var(--text-2)]">{entry.note}</div>
        <div className="t-micro mt-0.5">
          {clockTime(entry.ts)} · {entry.kind.replace("-", " ")}
          {entry.model ? ` · ${entry.model}` : ""}
          {pending ? " · pending" : ""}
        </div>
      </div>
      <span className={`num shrink-0 text-[13px] ${incoming ? "text-[var(--mint)]" : "text-[var(--text-2)]"}`}>{usdSigned(entry.delta)}</span>
    </div>
  );
}

/* =============================== rails =================================== */

export function Rail({ children, ariaLabel }: { children: React.ReactNode; ariaLabel: string }) {
  return (
    <div className="rail -mx-1" role="region" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export function ViewAllLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="btn btn-glass btn-sm">
      {label}
      <IconArrowRight size={13} />
    </Link>
  );
}
