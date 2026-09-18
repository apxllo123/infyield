"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessMode, Chat, ThinkingIntensity } from "@/lib/types";
import { errorMessage } from "./api";

/**
 * One client-side store for the things more than one page cares about:
 * conversations, the preferred model, and the motion preference. Keys are
 * unchanged from earlier builds so existing chats survive.
 */

const CHATS_KEY = "infyield.chats.v1";
const LEGACY_CHATS_KEY = "agentfuel.chats.v1";
const ACTIVE_KEY = "infyield.activechat.v1";
const MODEL_KEY = "infyield.model.v1";
const MOTION_KEY = "infyield.motion.v1";
const CHAT_LIMIT = 40;

/* ============================ conversations ============================== */

let chats: Chat[] = [];
let activeId = "";
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function readStorage(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(CHATS_KEY) ?? localStorage.getItem(LEGACY_CHATS_KEY) ?? "[]";
    const parsed = JSON.parse(raw) as Chat[];
    chats = Array.isArray(parsed) ? parsed : [];
  } catch {
    chats = [];
  }
  try {
    activeId = localStorage.getItem(ACTIVE_KEY) ?? "";
  } catch {
    activeId = "";
  }
  hydrated = true;
}

function persist(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, CHAT_LIMIT)));
    localStorage.setItem(ACTIVE_KEY, activeId);
  } catch {
    /* storage full or blocked — the session still works in memory */
  }
}

function ensure(): void {
  if (!hydrated) readStorage();
}

export function listChats(): Chat[] {
  ensure();
  return chats;
}

export function getActiveChatId(): string {
  ensure();
  return activeId;
}

export function setActiveChatId(id: string): void {
  ensure();
  activeId = id;
  persist();
  emit();
}

export function newChatId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random()}`;
}

export function createChat(modelId: string): Chat {
  ensure();
  const chat: Chat = { id: newChatId(), title: "New conversation", createdAt: Date.now(), updatedAt: Date.now(), modelId, messages: [] };
  chats = [chat, ...chats].slice(0, CHAT_LIMIT);
  activeId = chat.id;
  persist();
  emit();
  return chat;
}

export function mutateChat(id: string, fn: (chat: Chat) => Chat): void {
  ensure();
  chats = chats.map((c) => (c.id === id ? fn(c) : c));
  persist();
  emit();
}

export function removeChat(id: string): void {
  ensure();
  chats = chats.filter((c) => c.id !== id);
  if (activeId === id) activeId = chats[0]?.id ?? "";
  persist();
  emit();
}

export function renameChat(id: string, title: string): void {
  mutateChat(id, (c) => ({ ...c, title: title.trim() || c.title, updatedAt: Date.now() }));
}

export function subscribeChats(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `ready` is false for the very first paint so pages can show skeletons
 * instead of an empty state that immediately fills in. */
export function useChats(): { chats: Chat[]; activeId: string; ready: boolean } {
  const [state, setState] = useState<{ chats: Chat[]; activeId: string; ready: boolean }>({ chats: [], activeId: "", ready: false });

  useEffect(() => {
    const sync = () => setState({ chats: listChats(), activeId: getActiveChatId(), ready: true });
    sync();
    return subscribeChats(sync);
  }, []);

  return state;
}

/* ============================== resources =============================== */

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/** Fetch-on-mount with a design-system error string (never a raw exception). */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadRef
      .current()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refresh };
}

/** Poll a resource while `active` — used by the connect flow, which completes
 * in a real browser tab outside the app. */
export function usePoll(refresh: () => void, active: boolean, ms = 2500): void {
  useEffect(() => {
    if (!active) return;
    const t = setInterval(refresh, ms);
    return () => clearInterval(t);
  }, [refresh, active, ms]);
}

/** Cross-page invalidation: a page that mutates money or keys announces it, and
 * every other mounted view (the nav's funding readout, Home) refetches. */
const DATA_EVENT = "infyield:data";

export function notifyDataChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DATA_EVENT));
}

export function useDataSignal(refresh: () => void): void {
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener(DATA_EVENT, handler);
    return () => window.removeEventListener(DATA_EVENT, handler);
  }, [refresh]);
}/* ============================ preferences =============================== */

const PREFS_KEY = "infyield.prefs.v1";

export interface ChatPrefs {
  thinking: ThinkingIntensity;
  skills: string[];
  access: AccessMode;
  setThinking: (t: ThinkingIntensity) => void;
  setSkills: (ids: string[]) => void;
  toggleSkill: (id: string) => void;
  setAccess: (a: AccessMode) => void;
}

interface StoredPrefs {
  thinking: ThinkingIntensity;
  skills: string[];
  access?: AccessMode;
}

function readPrefs(): StoredPrefs {
  if (typeof window === "undefined") return { thinking: "medium", skills: [] };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { thinking: "medium", skills: [] };
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
    return {
      thinking: (["off", "low", "medium", "high"] as ThinkingIntensity[]).includes(parsed.thinking as ThinkingIntensity)
        ? (parsed.thinking as ThinkingIntensity)
        : "medium",
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      access: parsed.access === "readonly" ? "readonly" : "full",
    };
  } catch {
    return { thinking: "medium", skills: [] };
  }
}

function writePrefs(p: StoredPrefs): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/**
 * Composer preferences: the thinking level and skill selection for the active
 * conversation.
 *
 * They live on the chat (so each conversation keeps the way it was being
 * worked on) and are mirrored to a global default (so a new conversation starts
 * the way the last one was set up, rather than resetting every time).
 */
export function useChatPrefs(chatId: string | undefined): ChatPrefs {
  const [fallback, setFallback] = useState<StoredPrefs>({ thinking: "medium", skills: [] });
  const { chats } = useChats();

  useEffect(() => setFallback(readPrefs()), []);

  const chat = chats.find((c) => c.id === chatId);
  const thinking = chat?.thinking ?? fallback.thinking;
  const skills = chat?.skills ?? fallback.skills;
  const access: AccessMode = chat?.access ?? fallback.access ?? "full";

  const apply = useCallback(
    (next: Partial<StoredPrefs>) => {
      const current = readPrefs();
      const merged = { ...current, ...next };
      writePrefs(merged);
      if (chatId) {
        mutateChat(chatId, (c) => ({ ...c, thinking: merged.thinking, skills: merged.skills, access: merged.access ?? "full" }));
      }
      setFallback(merged);
    },
    [chatId],
  );

  return {
    thinking,
    skills,
    access,
    setThinking: useCallback((t: ThinkingIntensity) => apply({ thinking: t }), [apply]),
    setSkills: useCallback((ids: string[]) => apply({ skills: ids }), [apply]),
    toggleSkill: useCallback(
      (id: string) => {
        const current = readPrefs().skills;
        apply({ skills: current.includes(id) ? current.filter((s) => s !== id) : [...current, id] });
      },
      [apply],
    ),
    setAccess: useCallback((a: AccessMode) => apply({ access: a }), [apply]),
  };
}

export function usePreferredModel(defaultId: string | null): { modelId: string; choose: (id: string) => void } {
  const [modelId, setModelId] = useState("");

  useEffect(() => {
    let stored = "";
    try {
      stored = localStorage.getItem(MODEL_KEY) ?? "";
    } catch {
      stored = "";
    }
    setModelId(stored);
  }, []);

  useEffect(() => {
    if (!modelId && defaultId) setModelId(defaultId);
  }, [defaultId, modelId]);

  const choose = useCallback((id: string) => {
    setModelId(id);
    try {
      localStorage.setItem(MODEL_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  return { modelId, choose };
}

export type MotionPref = "default" | "calm";

export function useMotionPref(): { motion: MotionPref; setMotion: (m: MotionPref) => void; systemReduced: boolean } {
  const [motion, setMotionState] = useState<MotionPref>("default");
  const [systemReduced, setSystemReduced] = useState(false);

  useEffect(() => {
    let stored: MotionPref = "default";
    try {
      stored = (localStorage.getItem(MOTION_KEY) as MotionPref | null) ?? "default";
    } catch {
      stored = "default";
    }
    setMotionState(stored);
    document.documentElement.dataset.motion = stored;
    setSystemReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  const setMotion = useCallback((m: MotionPref) => {
    setMotionState(m);
    document.documentElement.dataset.motion = m;
    try {
      localStorage.setItem(MOTION_KEY, m);
    } catch {
      /* ignore */
    }
  }, []);

  return { motion, setMotion, systemReduced };
}
