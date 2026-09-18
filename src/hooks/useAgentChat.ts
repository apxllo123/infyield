"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessMode, Attachment, ChatMessage, SponsoredAd, ThinkingIntensity, TimelineItem, ToolEvent } from "@/lib/types";
import { createChat, getActiveChatId, listChats, mutateChat, newChatId, notifyDataChanged, setActiveChatId, useChats } from "@/lib/client/store";
import { authHeaders } from "@/lib/client/api";

/**
 * A structured admission refusal: the turn did not start because funding said
 * not yet. `defer` means waiting (and revenue) can fix it — which is exactly
 * what the sponsored break in the chat UI is for; `deny` will not resolve by
 * trying again, so it renders as an ordinary error instead.
 */
export interface FundingHold {
  code: string;
  message: string;
  disposition: "defer" | "deny";
  estimatedCostUsd?: number;
  retryAfterSec?: number;
  /** The admission snapshot's coverage split, so the UI can say honestly what
   * kind of revenue exists (house placeholder earns no real money). */
  funding?: { confirmedRevenueUsd: number; houseRevenueUsd: number };
}

/**
 * The agent conversation hook. Conversation state lives in the shared store
 * (src/lib/client/store.ts) so Home, Library and Chat all read the same list;
 * this hook only adds the streaming transport and its transient flags.
 */
export function useAgentChat(modelId: string, prefs?: { thinking?: ThinkingIntensity; skills?: string[]; access?: AccessMode }) {
  const { chats, activeId, ready } = useChats();
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [fundingHold, setFundingHold] = useState<FundingHold | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef(0);
  // Read the latest composer choices at send time without making `send` a new
  // function on every keystroke of the thinking/skills controls.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // There is always a conversation to type into.
  useEffect(() => {
    if (!ready) return;
    const list = listChats();
    if (!list.length) {
      createChat(modelId);
      return;
    }
    if (!list.some((c) => c.id === getActiveChatId())) setActiveChatId(list[0].id);
  }, [ready, modelId]);

  const active = chats.find((c) => c.id === activeId) ?? chats[0];

  const newChat = useCallback(() => {
    const list = listChats();
    const current = list.find((c) => c.id === getActiveChatId());
    if (current && current.messages.length === 0) return; // reuse the empty one
    createChat(modelId);
    setError(null);
    setNeedsSetup(false);
    setFundingHold(null);
  }, [modelId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  // The elapsed clock is real time on the current turn: it ticks while the
  // agent works and then holds the final duration until the next turn starts.
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => setElapsedSec(Math.round((Date.now() - startedAtRef.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [streaming]);

  const send = useCallback(
    async (text: string, attachments?: Attachment[]) => {
      const trimmed = text.trim();
      // A message may be nothing but attached files — that is a legitimate turn.
      if ((!trimmed && !attachments?.length) || streaming) return;
      const current = listChats().find((c) => c.id === getActiveChatId()) ?? listChats()[0];
      if (!current) return;

      setError(null);
      setNeedsSetup(false);
      setFundingHold(null);
      startedAtRef.current = Date.now();
      setElapsedSec(0);

      const userMsg: ChatMessage = {
        id: newChatId(),
        role: "user",
        content: trimmed,
        ...(attachments?.length ? { attachments } : {}),
      };
      const assistantMsg: ChatMessage = { id: newChatId(), role: "assistant", content: "", toolEvents: [], ads: [] };
      const chatId = current.id;
      const isFirst = current.messages.length === 0;

      mutateChat(chatId, (c) => ({
        ...c,
        title: isFirst ? (trimmed || attachments?.[0]?.name || "New conversation").slice(0, 44) : c.title,
        updatedAt: Date.now(),
        modelId,
        messages: [...c.messages, userMsg, assistantMsg],
      }));
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      const assistant = { ...assistantMsg };
      const tools: ToolEvent[] = [];
      const ads: SponsoredAd[] = [];
      // The turn as it actually unfolded: text chunks, tool steps and ad cards
      // in stream order, so the transcript can render an ad exactly where it
      // was served — between tool steps, the way Freebuff intersperses them —
      // instead of collecting every card at the end.
      const timeline: TimelineItem[] = [];
      let content = "";
      let lastError: string | null = null;

      const appendText = (text: string) => {
        const last = timeline[timeline.length - 1];
        if (last?.kind === "text") last.text += text;
        else timeline.push({ kind: "text", text });
      };
      const upsertTool = (event: ToolEvent) => {
        const i = timeline.findIndex((t) => t.kind === "tool" && t.event.callId === event.callId);
        if (i >= 0) timeline[i] = { kind: "tool", event };
        else timeline.push({ kind: "tool", event });
      };

      const flush = () => {
        const snapshot: ChatMessage = { ...assistant, content, toolEvents: [...tools], ads: [...ads], timeline: timeline.map((t) => ({ ...t })) };
        mutateChat(chatId, (c) => ({ ...c, updatedAt: Date.now(), messages: c.messages.map((m) => (m.id === assistantMsg.id ? snapshot : m)) }));
      };

      try {
        const history = [...current.messages.filter((m) => m.role !== "assistant" || m.content || (m.toolEvents ?? []).length), userMsg];
        const res = await fetch("/api/chat", {
          method: "POST",
          // `/api/chat` is an API-password surface, not an admin one.
          headers: { "content-type": "application/json", ...authHeaders("api") },
          body: JSON.stringify({
            model: modelId,
            thinking: prefsRef.current?.thinking,
            skills: prefsRef.current?.skills,
            access: prefsRef.current?.access ?? "full",
            messages: history.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              toolEvents: m.toolEvents,
              // Attachment ids only — the bytes are already on the server from
              // the upload, so a long conversation is not re-uploading files.
              ...(m.attachments?.length ? { attachments: m.attachments } : {}),
            })),
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as {
            error?: string;
            code?: string;
            disposition?: string;
            estimatedCostUsd?: number;
            retryAfterSec?: number;
            funding?: { confirmedRevenueUsd?: number; houseRevenueUsd?: number };
          };
          // A structured admission refusal is not an error to bury: it is the
          // one failure the user can act on in-place, by letting the sponsored
          // break earn the shortfall. Handled below the composer instead.
          if (j.code === "premium-locked" || j.disposition === "defer") {
            setFundingHold({
              code: j.code ?? "funding-hold",
              message: j.error ?? "This request needs more ad revenue behind it first.",
              disposition: j.disposition === "deny" ? "deny" : "defer",
              estimatedCostUsd: j.estimatedCostUsd,
              retryAfterSec: j.retryAfterSec,
              funding: {
                confirmedRevenueUsd: j.funding?.confirmedRevenueUsd ?? 0,
                houseRevenueUsd: j.funding?.houseRevenueUsd ?? 0,
              },
            });
            return;
          }
          // A 401 is the one failure the user can fix themselves, so it says how
          // rather than surfacing the bare word "Unauthorized".
          throw new Error(
            res.status === 401
              ? "Unauthorized — this browser has no (or the wrong) API password. Enter it in Settings → Privacy."
              : j.error || `Request failed (${res.status})`,
          );
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 2);
            if (!raw.startsWith("data:")) continue;
            const payload = raw.slice(5).trim();
            if (payload === "[DONE]") continue;
            let ev: {
              type: string;
              text?: string;
              event?: ToolEvent;
              ad?: SponsoredAd;
              usage?: { promptTokens: number; completionTokens: number };
              costUsd?: number;
              message?: string;
              needsSetup?: boolean;
            };
            try {
              ev = JSON.parse(payload);
            } catch {
              continue;
            }
            if (ev.type === "delta" && ev.text) {
              content += ev.text;
              appendText(ev.text);
              flush();
            } else if (ev.type === "tool" && ev.event) {
              const existing = tools.findIndex((t) => t.callId === ev.event!.callId);
              if (existing >= 0) tools[existing] = ev.event;
              else tools.push(ev.event);
              upsertTool(ev.event);
              flush();
            } else if (ev.type === "ad" && ev.ad) {
              ads.push(ev.ad);
              timeline.push({ kind: "ad", ad: ev.ad });
              flush();
              // The impression just credited revenue. Tell every mounted view
              // so the funding readout moves as the agent works, not only
              // once the turn is over.
              notifyDataChanged();
            } else if (ev.type === "usage" && ev.usage) {
              assistant.usage = ev.usage;
              assistant.costUsd = ev.costUsd;
              assistant.model = modelId;
              flush();
              // Same for spend: this call was just metered to the ledger.
              notifyDataChanged();
            } else if (ev.type === "error") {
              lastError = ev.message ?? "Unknown error";
              setNeedsSetup(!!ev.needsSetup);
            }
          }
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      } finally {
        if (lastError) {
          assistant.error = lastError;
          setError(lastError);
        }
        const finalSnapshot: ChatMessage = { ...assistant, content, toolEvents: [...tools], ads: [...ads], timeline: timeline.map((t) => ({ ...t })) };
        mutateChat(chatId, (c) => ({ ...c, updatedAt: Date.now(), messages: c.messages.map((m) => (m.id === assistantMsg.id ? finalSnapshot : m)) }));
        // Settle the readouts once the turn ends, so nothing is left stale.
        notifyDataChanged();
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [streaming, modelId],
  );

  /**
   * Re-send the turn the admission gate refused: drop the held pair (the user
   * message and its empty assistant placeholder) and send it again through the
   * normal path. The transcript keeps no scar of the refused attempt.
   */
  const retryLast = useCallback(async () => {
    if (streaming) return;
    const current = listChats().find((c) => c.id === getActiveChatId());
    if (!current) return;
    const msgs = [...current.messages];
    // Trailing empty assistant placeholder from the refused turn, then the user
    // message that preceded it.
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant" && !last.content && !(last.toolEvents ?? []).length) msgs.pop();
    const prev = msgs[msgs.length - 1];
    if (prev?.role !== "user") return;
    msgs.pop();
    mutateChat(current.id, (c) => ({ ...c, messages: msgs }));
    await send(prev.content, prev.attachments);
  }, [streaming, send]);

  return { chats, active, activeId, setActiveId: setActiveChatId, newChat, send, stop, retryLast, streaming, error, needsSetup, fundingHold, ready, elapsedSec };
}
