"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight, IconChat, IconCompass, IconHome, IconLibrary, IconPlug, IconSearch, IconSettings, IconSparkle, IconWallet } from "./icons";
import { api, type UiModel } from "@/lib/client/api";
import { setActiveChatId, useChats, usePreferredModel } from "@/lib/client/store";
import { chatSummary, timeAgo } from "@/lib/client/format";

interface Item {
  id: string;
  group: "Go to" | "Conversations" | "Models";
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

/**
 * Search across the things that actually exist: pages, the conversations on
 * this machine, and the model catalog the server reports. Nothing is invented
 * to fill the list.
 */
export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { chats } = useChats();
  const { choose } = usePreferredModel(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [models, setModels] = useState<UiModel[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    const t = setTimeout(() => inputRef.current?.focus(), 40);
    api
      .models()
      .then((d) => setModels(d.models ?? []))
      .catch(() => setModels([]));
    return () => clearTimeout(t);
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (href: string, label: string, icon: React.ReactNode, hint: string): Item => ({
      id: `go:${href}`,
      group: "Go to",
      label,
      hint,
      icon,
      run: () => router.push(href),
    });

    const base: Item[] = [
      go("/", "Home", <IconHome size={15} />, "Overview and activity"),
      go("/chat", "Chat", <IconChat size={15} />, "Work with the agent"),
      go("/explore", "Explore models", <IconCompass size={15} />, "Catalog and capabilities"),
      go("/library", "Library", <IconLibrary size={15} />, "Saved conversations and files"),
      go("/connections", "Connections", <IconPlug size={15} />, "Providers and API keys"),
      go("/settings", "Settings", <IconSettings size={15} />, "Workspace, appearance, advanced"),
    ];

    const conversations: Item[] = chats.map((c) => ({
      id: `chat:${c.id}`,
      group: "Conversations" as const,
      label: c.title,
      hint: `${chatSummary(c.messages)} · ${timeAgo(c.updatedAt)}`,
      icon: <IconChat size={15} />,
      run: () => {
        setActiveChatId(c.id);
        router.push("/chat");
      },
    }));

    const modelItems: Item[] = models.map((m) => ({
      id: `model:${m.id}`,
      group: "Models" as const,
      label: m.label,
      hint: `${m.via ?? "no key"} · ${m.blurb}`,
      icon: <IconSparkle size={15} />,
      run: () => {
        choose(m.id);
        router.push("/chat");
      },
    }));

    return [...base, ...conversations, ...modelItems];
  }, [chats, models, router, choose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 12);
    return items
      .filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(q))
      .slice(0, 14);
  }, [items, query]);

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(0);
  }, [filtered.length, cursor]);

  if (!open) return null;

  const grouped = filtered.reduce<Record<string, Item[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});
  let flatIndex = -1;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(4,4,8,0.62)] px-5 pt-[14vh] backdrop-blur-[6px]" onMouseDown={onClose}>
      <div
        className="glass-strong sheen w-full max-w-[620px] overflow-hidden rounded-[var(--r-xl)]"
        style={{ boxShadow: "var(--shadow-pop)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--border-1)] px-5 py-4">
          <IconSearch size={17} className="shrink-0 text-[var(--text-3)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, filtered.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              }
              if (e.key === "Enter" && filtered[cursor]) {
                e.preventDefault();
                filtered[cursor].run();
                onClose();
              }
            }}
            placeholder="Search conversations, models and pages…"
            className="w-full bg-transparent text-[15px] text-[var(--text-1)] placeholder-[var(--text-4)] focus:outline-none"
          />
          <kbd className="mono shrink-0 rounded-md border border-[var(--border-2)] bg-[rgba(0,0,0,0.3)] px-2 py-1 text-[10.5px] text-[var(--text-3)]">esc</kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-2">
          {filtered.length === 0 && (
            <div className="px-4 py-10 text-center">
              <div className="t-title">No matches</div>
              <div className="t-meta mt-1.5">Try a model name, a conversation title, or a page.</div>
            </div>
          )}
          {Object.entries(grouped).map(([group, list]) => (
            <div key={group} className="mb-1">
              <div className="eyebrow px-3 pb-1.5 pt-2.5">{group}</div>
              {list.map((item) => {
                flatIndex++;
                const active = flatIndex === cursor;
                const myIndex = flatIndex;
                return (
                  <button
                    key={item.id}
                    onMouseEnter={() => setCursor(myIndex)}
                    onClick={() => {
                      item.run();
                      onClose();
                    }}
                    className={`flex w-full items-center gap-3 rounded-[var(--r-sm)] px-3 py-2.5 text-left transition-colors ${
                      active ? "bg-[rgba(255,255,255,0.08)]" : "hover:bg-[rgba(255,255,255,0.045)]"
                    }`}
                  >
                    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-[var(--r-xs)] border border-[var(--border-1)] ${active ? "text-[var(--mint)]" : "text-[var(--text-3)]"}`}>
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-[var(--text-1)]">{item.label}</span>
                      {item.hint && <span className="t-micro block truncate">{item.hint}</span>}
                    </span>
                    {active && <IconArrowRight size={14} className="shrink-0 text-[var(--text-3)]" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-[var(--border-1)] px-5 py-2.5">
          <span className="t-micro">↑↓ navigate</span>
          <span className="t-micro">↵ open</span>
          <span className="t-micro">esc close</span>
        </div>
      </div>
    </div>
  );
}
