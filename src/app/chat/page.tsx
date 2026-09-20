"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ComposerBar from "@/components/ComposerBar";
import Markdown from "@/components/Markdown";
import ToolSteps, { StepRow } from "@/components/ToolSteps";
import AdCard from "@/components/AdCard";
import DockAd from "@/components/DockAd";
import SponsorBreak from "@/components/SponsorBreak";
import { ErrorState, Mark, Notice } from "@/components/ui";
import { IconArrowRight, IconClose, IconFile, IconPlus, IconSparkle } from "@/components/icons";
import { useAgentChat } from "@/hooks/useAgentChat";
import { api, errorMessage, type UiModel } from "@/lib/client/api";
import { useChatPrefs, useMotionPref, usePreferredModel, useResource } from "@/lib/client/store";
import { timeAgo } from "@/lib/client/format";
import type { Attachment, ChatMessage } from "@/lib/types";

/**
 * How full the context window is.
 *
 * Prefers real measurement: the provider's own token counts for the last metered
 * call (prompt + completion are together what occupied the window). Only when a
 * conversation has no metered call yet does it fall back to a character estimate,
 * which is labelled as an estimate in the tooltip rather than passed off as fact.
 */
function contextTokens(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i].usage;
    if (u) return u.promptTokens + u.completionTokens;
  }
  const chars = messages.reduce(
    (n, m) =>
      n +
      m.content.length +
      (m.toolEvents ?? []).reduce((k, t) => k + (t.output?.length ?? 0) + JSON.stringify(t.args ?? {}).length, 0),
    0,
  );
  return Math.round(chars / 4);
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const STARTERS = [
  "Explain the architecture of this project and where the risky parts are.",
  "Find the most likely bug in this codebase and fix it.",
  "Add tests for the most complex function in the workspace.",
];

export default function ChatPage() {
  const models = useResource(() => api.models(), []);
  const bootstrap = useResource(() => api.bootstrap(), []);
  const skills = useResource(() => api.skills(), []);
  const { modelId, choose } = usePreferredModel(models.data?.defaultModelId ?? null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const chat = useAgentChat(modelId || "glm-5.3-flash");
  const prefs = useChatPrefs(chat.activeId || undefined);
  const thinking = prefs.thinking;
  const activeSkills = prefs.skills;
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  useMotionPref();

  // Follow the stream, but only when the reader is already near the bottom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 260;
    if (near) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.active?.messages]);

  const send = (text: string) => {
    const value = text.trim();
    if (!value && !attachments.length) return;
    const files = attachments;
    setInput("");
    setAttachments([]);
    void chat.send(value, files);
  };

  /** Upload then queue: the transcript stores ids, so the upload must finish
   * before the message can reference the files. */
  const attach = async (files: File[]) => {
    setAttachError(null);
    try {
      const res = await api.uploadFiles(files);
      setAttachments((prev) => [...prev, ...res.attachments]);
      if (res.warnings?.length) setAttachError(res.warnings.join(" "));
    } catch (e) {
      setAttachError(errorMessage(e));
    }
  };

  const messages = useMemo(() => chat.active?.messages ?? [], [chat.active?.messages]);
  const hasKey = !!bootstrap.data?.hasAnyKey;
  const activeModel = models.data?.models.find((m) => m.id === (modelId || chat.active?.modelId));
  const usedTokens = useMemo(() => contextTokens(messages), [messages]);
  const selectedSkills = useMemo(() => (skills.data?.skills ?? []).filter((s) => activeSkills.includes(s.id)), [skills.data, activeSkills]);

  return (
    <div className="flex h-[calc(100dvh-152px)] min-h-[540px] gap-5">
      {/* ------------------------- conversation rail ------------------------- */}
      <aside className="glass hidden w-[262px] shrink-0 flex-col rounded-[var(--r-xl)] p-3 lg:flex">
        <button className="btn btn-glass w-full" onClick={chat.newChat}>
          <IconPlus size={14} />
          New conversation
        </button>

        <div className="mt-3 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
          {!chat.ready ? (
            <div className="space-y-2 pt-1">
              <div className="skeleton h-9" />
              <div className="skeleton h-9" />
              <div className="skeleton h-9" />
            </div>
          ) : (
            chat.chats.map((c) => {
              const active = c.id === chat.activeId;
              return (
                <button
                  key={c.id}
                  onClick={() => chat.setActiveId(c.id)}
                  className={`w-full rounded-[var(--r-sm)] px-3 py-2.5 text-left transition-colors ${
                    active ? "bg-[rgba(255,255,255,0.08)]" : "hover:bg-[rgba(255,255,255,0.045)]"
                  }`}
                >
                  <div className={`truncate text-[13px] ${active ? "text-[var(--text-1)]" : "text-[var(--text-2)]"}`}>{c.title}</div>
                  <div className="t-micro mt-0.5">
                    {c.messages.length} msg · {timeAgo(c.updatedAt)}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/*
          The "Available − spend" card and its Economy link used to sit here.
          It was a credits readout by another name, and Freebuff's spec deletes
          exactly that: no balance, no spend, no credits anywhere in the UI.
          What pays for the call is the ads running in the transcript itself.
        */}
      </aside>

      {/* --------------------------- transcript ----------------------------- */}
      <main className="glass flex min-w-0 flex-1 flex-col overflow-hidden rounded-[var(--r-xl)]">
        <header className="flex items-center gap-3 border-b border-[var(--border-1)] px-4 py-3 lg:px-5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium text-[var(--text-1)]">{chat.active?.title ?? "New conversation"}</div>
            <div className="t-micro mt-0.5 truncate">
              {activeModel ? `${activeModel.label} · ${activeModel.via ?? "no key"}` : "Select a model"}
              {messages.length ? ` · ${messages.length} messages` : ""}
            </div>
          </div>
          <button className="btn btn-quiet btn-sm lg:hidden" onClick={chat.newChat} aria-label="New conversation">
            <IconPlus size={15} />
          </button>
          {activeModel?.premium && !activeModel.unlocked && (
            <span className="chip chip-muted hidden h-[20px] px-2 text-[10px] sm:flex" title="This model needs ad revenue behind a connected key before it will run. Nothing is charged silently — it simply declines to start.">
              locked
            </span>
          )}
        </header>

        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 lg:px-8">
          <div className="mx-auto max-w-[760px]">
            {!messages.length ? (
              <div className="rise py-6 text-center">
                <div className="mb-6 flex justify-center">
                  <span className="grid h-14 w-14 place-items-center rounded-[var(--r-lg)] border border-[var(--border-2)] bg-[linear-gradient(160deg,rgba(255,255,255,0.12),rgba(255,255,255,0.02))]">
                    <Mark size={30} glow />
                  </span>
                </div>
                <h2 className="t-h1">What should we build?</h2>
                <p className="t-body mx-auto mt-3 max-w-[46ch]">
                  The agent reads, edits and runs your project. Sponsored cards appear between steps and pay for the model calls — nothing to top up.
                </p>
                <div className="mt-8 grid gap-2.5 sm:grid-cols-3">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="glass-quiet tile-hover rounded-[var(--r-md)] px-4 py-3.5 text-left"
                    >
                      <IconSparkle size={15} className="text-[var(--mint)]" />
                      <span className="mt-2.5 block text-[13px] leading-relaxed text-[var(--text-2)]">{s}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-8">
                {messages.map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="flex flex-col items-end gap-1.5">
                      {(m.attachments ?? []).length > 0 && (
                        <div className="flex max-w-[84%] flex-wrap justify-end gap-1.5">
                          {(m.attachments ?? []).map((a) => (
                            <span key={a.id} className="chip chip-muted h-[22px] gap-1.5 px-2 text-[11px]" title={`${a.mime} · ${fileSize(a.sizeBytes)}`}>
                              <IconFile size={11} />
                              <span className="max-w-[180px] truncate">{a.name}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {m.content ? (
                        <div className="max-w-[84%] rounded-[var(--r-lg)] rounded-br-[var(--r-xs)] border border-[var(--border-2)] bg-[linear-gradient(180deg,rgba(255,255,255,0.09),rgba(255,255,255,0.04))] px-4 py-3 text-[14.5px] leading-relaxed text-[var(--text-1)]">
                          {m.content}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <article key={m.id}>
                      {/*
                        The turn in stream order: text, tool steps and ad cards
                        exactly where they happened. Freebuff intersperses its
                        inline ads between the nodes of a response; rendering
                        the ordered timeline is what makes that real here. The
                        legacy fields render older saved transcripts that have
                        no timeline.
                      */}
                      {m.timeline?.length ? (
                        <>
                          {m.timeline.map((item, i) =>
                            item.kind === "text" ? (
                              item.text && <Markdown key={i} text={item.text} />
                            ) : item.kind === "tool" ? (
                              <StepRow key={`${item.event.callId}-${i}`} event={item.event} />
                            ) : (
                              <AdCard key={`${item.ad.impUrl}-${i}`} ad={item.ad} />
                            ),
                          )}
                        </>
                      ) : (
                        <>
                          <ToolSteps events={m.toolEvents ?? []} />
                          {m.content && <Markdown text={m.content} />}
                          {(m.ads ?? []).map((ad) => (
                            <AdCard key={ad.impUrl} ad={ad} />
                          ))}
                        </>
                      )}
                      {m.error && (
                        <div className="mt-3">
                          <Notice tone="warn" title="The agent stopped here">
                            {m.error}
                          </Notice>
                        </div>
                      )}
                      {m.usage && (
                        <div className="t-micro mt-3 flex items-center gap-3 border-t border-[var(--border-1)] pt-2.5">
                          <span>{m.model ?? modelId}</span>
                          <span>·</span>
                          <span className="num">{m.usage.promptTokens + m.usage.completionTokens} tokens</span>
                          {/* No "$x.xx metered" here: a per-message price is the
                              credits footer Freebuff's spec deletes. */}
                        </div>
                      )}
                    </article>
                  ),
                )}

                {chat.streaming && (
                  <div className="flex items-center gap-2.5">
                    <span className="dot-live" />
                    <span className="t-meta">Working…</span>
                  </div>
                )}
                {/*
                  The funding gate held the last request: the turn did not start,
                  so the reply slot shows the earn step instead — a sponsored
                  card served on the spot, then a retry. This is how "needs
                  credits" is supposed to look: not a wall, a break that pays.
                */}
                {chat.fundingHold && !chat.streaming && (
                  <SponsorBreak hold={chat.fundingHold} onRetry={() => void chat.retryLast()} />
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        {/* ---------------------------- composer ---------------------------- */}
        <div className="border-t border-[var(--border-1)] px-4 py-4 lg:px-5">
          <div className="mx-auto max-w-[760px] space-y-3">
            {/*
              The dock slot: a rotating sponsored card, always present, one
              impression per 60s creative — Freebuff's dock banner. It is also
              why a one-line answer still earns: inline cards only open between
              tool steps, and a quick turn has none.
            */}
            <DockAd sessionId={chat.activeId} />
            {/*
              No "connect your own key" prompt here on purpose. Infyield holds
              the provider credential and pays the bill; there is nothing for the
              person using it to connect, and offering one would be the BYOK model
              this build removed. What can be missing is the *deployment's*
              credential, which only an operator can fix — so the prompt says
              that, and points at status rather than at an input.
            */}
            {!hasKey && (
              <Notice
                tone="warn"
                title="AI provider is not configured"
                action={
                  <Link href="/connections" className="btn btn-ghost btn-sm">
                    View status
                  </Link>
                }
              >
                This deployment has no provider credential, so no model can run. That is a server-side setting, not
                something to enter here — the app will not pretend a connection exists.
              </Notice>
            )}
            {chat.error && hasKey && !chat.fundingHold && <ErrorState title="Request failed" body={chat.error} />}
            {attachError && (
              <Notice tone="warn" title="That file could not be attached">
                {attachError}
              </Notice>
            )}

            <div
              className={`glass-strong sheen rounded-[var(--r-lg)] p-2.5 transition-shadow ${dragging ? "ring-1 ring-[var(--mint)]" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const files = Array.from(e.dataTransfer.files ?? []);
                if (files.length) void attach(files);
              }}
            >
              {attachments.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1.5 px-1">
                  {attachments.map((a) => (
                    <span key={a.id} className="chip chip-mint h-[24px] gap-1.5 pl-2 pr-1 text-[11.5px]" title={`${a.mime} · ${fileSize(a.sizeBytes)}`}>
                      <IconFile size={11} />
                      <span className="max-w-[200px] truncate">{a.name}</span>
                      <button
                        onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                        className="grid h-4 w-4 place-items-center rounded-full transition-colors hover:bg-[rgba(0,0,0,0.3)]"
                        aria-label={`Remove ${a.name}`}
                      >
                        <IconClose size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                onPaste={(e) => {
                  // Clipboard images have no filename and exist only as blobs, so
                  // they take the JSON upload path rather than multipart.
                  const files = Array.from(e.clipboardData?.files ?? []);
                  if (files.length) {
                    e.preventDefault();
                    void attach(files);
                  }
                }}
                rows={2}
                placeholder={dragging ? "Drop to attach…" : "Describe what you want built, fixed or explained…"}
                className="max-h-44 min-h-[52px] w-full resize-none bg-transparent px-2.5 py-2 text-[14.5px] leading-relaxed text-[var(--text-1)] placeholder-[var(--text-4)] focus:outline-none"
              />
              <div className="flex items-center gap-2 px-1 pb-0.5 pt-1">
                <span className="t-micro hidden items-center gap-1.5 sm:flex">
                  <kbd className="mono rounded-md border border-[var(--border-2)] bg-[rgba(0,0,0,0.3)] px-1.5 py-0.5 text-[10px]">↵</kbd>
                  send
                  <kbd className="mono ml-2 rounded-md border border-[var(--border-2)] bg-[rgba(0,0,0,0.3)] px-1.5 py-0.5 text-[10px]">⇧↵</kbd>
                  newline
                </span>
                <span className="flex-1" />
                {chat.streaming ? (
                  <button className="btn btn-glass" onClick={chat.stop}>
                    Stop
                  </button>
                ) : (
                  <button className="btn btn-accent" onClick={() => send(input)} disabled={!input.trim() && !attachments.length}>
                    Send
                    <IconArrowRight size={14} />
                  </button>
                )}
              </div>
              <ComposerBar
                modelId={modelId}
                models={models.data?.models ?? []}
                onModel={choose}
                thinking={thinking}
                onThinking={prefs.setThinking}
                skills={skills.data?.skills ?? []}
                activeSkills={activeSkills}
                onToggleSkill={prefs.toggleSkill}
                access={prefs.access}
                onAccess={prefs.setAccess}
                onAttach={(files) => void attach(files)}
                attachments={attachments}
                onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
                onPasteHint={!messages.length}
                contextUsed={usedTokens}
                contextWindow={activeModel?.contextWindow ?? 0}
                elapsedSec={chat.elapsedSec}
                streaming={chat.streaming}
              />
            </div>
            <p className="t-micro">
              The agent edits real files and runs real commands in your workspace root. Sponsored cards between steps keep it free.
              {selectedSkills.length > 0 && (
                <>
                  {" "}
                  Active skills: {selectedSkills.map((s) => s.name).join(", ")}.
                </>
              )}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
