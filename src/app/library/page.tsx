"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { FileTile } from "@/components/cards";
import { CardSkeleton, EmptyState, ErrorState, SectionHeading } from "@/components/ui";
import { IconArrowRight, IconChat, IconCheck, IconClose, IconFolder, IconLibrary, IconSearch, IconTrash } from "@/components/icons";
import { api } from "@/lib/client/api";
import { removeChat, renameChat, setActiveChatId, useChats, useMotionPref, useResource } from "@/lib/client/store";
import { bytes, chatSummary, dateTime, timeAgo } from "@/lib/client/format";

type Filter = "all" | "week" | "empty";

export default function LibraryPage() {
  const router = useRouter();
  const { chats, ready } = useChats();
  const models = useResource(() => api.models(), []);
  const workspace = useResource(() => api.workspace(), []);
  useMotionPref();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const modelLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models.data?.models ?? []) map.set(m.id, m.label);
    return map;
  }, [models.data]);

  const conversations = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const q = query.trim().toLowerCase();
    return [...chats]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((c) => (filter === "week" ? c.updatedAt >= weekAgo : filter === "empty" ? c.messages.length === 0 : true))
      .filter((c) => (q ? `${c.title} ${chatSummary(c.messages)}`.toLowerCase().includes(q) : true));
  }, [chats, query, filter]);

  const open = (id: string) => {
    setActiveChatId(id);
    router.push("/chat");
  };

  const files = workspace.data?.entries ?? [];
  const folders = files.filter((f) => f.kind === "dir");
  const docs = files.filter((f) => f.kind === "file");

  return (
    <div className="space-y-12">
      <SectionHeading
        eyebrow="Library"
        title="Everything you've built"
        hint="Conversations live on this machine; the file column mirrors the folder the agent works in."
        action={
          <>
            <div className="relative hidden sm:block">
              <IconSearch size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-4)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search conversations"
                className="input h-9 w-[240px] pl-9"
              />
            </div>
            <div className="seg">
              {([["all", "All"], ["week", "This week"], ["empty", "Untouched"]] as [Filter, string][]).map(([value, label]) => (
                <button key={value} className="seg-item" data-active={filter === value} onClick={() => setFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
          </>
        }
      />

      {/* ------------------------ conversations ------------------------- */}
      <section>
        {!ready ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <CardSkeleton width="w-full" height="h-[112px]" />
            <CardSkeleton width="w-full" height="h-[112px]" />
            <CardSkeleton width="w-full" height="h-[112px]" />
            <CardSkeleton width="w-full" height="h-[112px]" />
          </div>
        ) : conversations.length ? (
          <div className="stagger grid gap-4 lg:grid-cols-2">
            {conversations.map((c) => {
              const isRenaming = renaming === c.id;
              const isConfirming = confirming === c.id;
              return (
                <div key={c.id} className="glass card-hover sheen overflow-hidden rounded-[var(--r-lg)] p-5">
                  <div className="flex items-start gap-4">
                    <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-[var(--r-xs)] border border-[var(--border-1)] bg-[var(--surface-1)] text-[var(--text-3)]">
                      <IconChat size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      {isRenaming ? (
                        <div className="flex items-center gap-2">
                          <input
                            autoFocus
                            className="input h-8"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                renameChat(c.id, draft);
                                setRenaming(null);
                              }
                              if (e.key === "Escape") setRenaming(null);
                            }}
                          />
                          <button
                            className="btn btn-quiet btn-sm"
                            onClick={() => {
                              renameChat(c.id, draft);
                              setRenaming(null);
                            }}
                            aria-label="Save name"
                          >
                            <IconCheck size={14} />
                          </button>
                          <button className="btn btn-quiet btn-sm" onClick={() => setRenaming(null)} aria-label="Cancel">
                            <IconClose size={14} />
                          </button>
                        </div>
                      ) : (
                        <button className="block max-w-full text-left" onClick={() => open(c.id)}>
                          <div className="truncate text-[14.5px] font-medium text-[var(--text-1)]">{c.title}</div>
                        </button>
                      )}
                      <p className="t-meta mt-1 line-clamp-2">{chatSummary(c.messages)}</p>
                      <div className="mt-3.5 flex flex-wrap items-center gap-2">
                        <span className="chip chip-muted">{c.messages.length} messages</span>
                        {modelLabel.get(c.modelId) && <span className="chip">{modelLabel.get(c.modelId)}</span>}
                        <span className="chip chip-muted" title={dateTime(c.updatedAt)}>
                          {timeAgo(c.updatedAt)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-1 border-t border-[var(--border-1)] pt-3.5">
                    <button className="btn btn-glass btn-sm" onClick={() => open(c.id)}>
                      Open
                      <IconArrowRight size={13} />
                    </button>
                    <span className="flex-1" />
                    <button
                      className="btn btn-quiet btn-sm"
                      onClick={() => {
                        setRenaming(c.id);
                        setDraft(c.title);
                      }}
                    >
                      Rename
                    </button>
                    {isConfirming ? (
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          removeChat(c.id);
                          setConfirming(null);
                        }}
                      >
                        <IconCheck size={13} />
                        Confirm delete
                      </button>
                    ) : (
                      <button className="btn btn-quiet btn-sm btn-danger" onClick={() => setConfirming(c.id)} aria-label="Delete conversation">
                        <IconTrash size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : chats.length ? (
          <EmptyState
            icon={<IconSearch size={18} />}
            title="Nothing matches that"
            body="Try a different search, or clear the filter."
            action={
              <button
                className="btn btn-glass btn-sm"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear filters
              </button>
            }
            compact
          />
        ) : (
          <EmptyState
            icon={<IconLibrary size={18} />}
            eyebrow="No conversations yet"
            title="Your saved conversations will appear here"
            body="Every chat is stored locally with its tool timeline and the sponsored cards it served."
            action={
              <Link href="/chat" className="btn btn-primary btn-sm">
                Start a conversation
                <IconArrowRight size={13} />
              </Link>
            }
          />
        )}
      </section>

      {/* --------------------------- files ------------------------------ */}
      <section>
        <SectionHeading
          eyebrow="Workspace"
          title="Files in the working folder"
          hint={workspace.data?.root ? workspace.data.root : "Set a workspace root and its contents appear here."}
          action={
            <Link href="/settings" className="btn btn-glass btn-sm">
              Change folder
            </Link>
          }
        />

        {workspace.error ? (
          <ErrorState body={workspace.error} onRetry={workspace.refresh} retrying={workspace.loading} />
        ) : workspace.loading && !workspace.data ? (
          <div className="rail">
            <CardSkeleton width="w-[212px]" height="h-[122px]" />
            <CardSkeleton width="w-[212px]" height="h-[122px]" />
            <CardSkeleton width="w-[212px]" height="h-[122px]" />
          </div>
        ) : files.length ? (
          <div className="space-y-8">
            {folders.length > 0 && (
              <div>
                <div className="eyebrow mb-3">Folders · {folders.length}</div>
                <div className="rail">
                  {folders.map((f) => (
                    <FileTile key={f.name} entry={f} />
                  ))}
                </div>
              </div>
            )}
            {docs.length > 0 && (
              <div>
                <div className="eyebrow mb-3">Files · {docs.length}</div>
                <div className="rail">
                  {docs.map((f) => (
                    <FileTile key={f.name} entry={f} />
                  ))}
                </div>
              </div>
            )}
            <p className="t-micro">
              {bytes(docs.reduce((n, f) => n + f.sizeBytes, 0))} across {docs.length} file{docs.length === 1 ? "" : "s"} · shown read-only; ask
              the agent to change anything you see here.
            </p>
          </div>
        ) : (
          <EmptyState
            icon={<IconFolder size={18} />}
            title={workspace.data?.exists ? "That folder is empty" : "No workspace folder yet"}
            body={workspace.data?.error || "Point Infyield at a project and the agent's files show up here."}
            action={
              <Link href="/settings" className="btn btn-glass btn-sm">
                Set workspace root
              </Link>
            }
            compact
          />
        )}
      </section>
    </div>
  );
}
