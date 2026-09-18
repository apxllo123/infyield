"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SponsoredAd } from "@/lib/types";
import { IconArrowUpRight } from "./icons";
import { AdIcon } from "./AdCard";

/**
 * The rotating ad pinned above the composer — Infyield's version of the
 * Freebuff CLI's dock banner (SingleAdBanner): one slot, a new auction every
 * 60 seconds, one impression per creative actually shown.
 *
 * This slot is why the product still earns on turns that never touch a tool:
 * inline cards only open at breaks in real work, so a one-line answer serves
 * nothing between steps — but the dock is always here, rotating, exactly like
 * the Freebuff landing/dock inventory. The 60s period is Freebuff's own
 * AD_ROTATION_INTERVAL_MS; the server's frequency floor sits underneath.
 */
const ROTATE_MS = 60_000;

export default function DockAd({ sessionId }: { sessionId?: string | null }) {
  const [ad, setAd] = useState<SponsoredAd | null>(null);
  const firedRef = useRef<string | null>(null);

  const impression = useCallback((creative: SponsoredAd) => {
    if (firedRef.current === creative.impUrl) return;
    firedRef.current = creative.impUrl;
    // One id per logical impression; a refetch of the same creative (after a
    // remount) remounts nothing here, and the server dedupes regardless.
    const eventId = (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()));
    fetch(creative.impUrl, { method: "POST", headers: { "x-infyield-event-id": eventId } }).catch(() => {});
  }, []);

  const rotate = useCallback(async () => {
    try {
      const res = await fetch("/api/ads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [], sessionId: sessionId ?? undefined }),
      });
      const body = (await res.json()) as { ads?: SponsoredAd[] };
      const next = body.ads?.[0] ?? null;
      setAd(next);
    } catch {
      // Offline or no fill: the slot goes quiet rather than showing a broken card.
      setAd(null);
    }
  }, [sessionId]);

  useEffect(() => {
    void rotate();
    const id = setInterval(() => void rotate(), ROTATE_MS);
    return () => clearInterval(id);
  }, [rotate]);

  useEffect(() => {
    if (ad) impression(ad);
  }, [ad, impression]);

  if (!ad) return null;

  const domain = ad.domain || ad.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  const onClick = () => {
    fetch(ad.clickUrl, { method: "POST", headers: { "x-infyield-event-id": `click-${firedRef.current}` } })
      .then((r) => r.json())
      .then((j: { url?: string }) => window.open(j.url || ad.url, "_blank", "noopener,noreferrer"))
      .catch(() => window.open(ad.url, "_blank", "noopener,noreferrer"));
  };

  return (
    <div
      onClick={onClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      aria-label={`Sponsored: ${ad.title}`}
      className="group flex cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-full border border-[var(--border-1)] bg-[rgba(255,255,255,0.025)] py-1.5 pl-3.5 pr-3 transition-colors hover:border-[var(--border-2)] hover:bg-[rgba(255,255,255,0.05)]"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <AdIcon ad={ad} size={24} />
        <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--text-1)]">{ad.title}</span>
        <span className="t-micro shrink-0 uppercase tracking-[0.14em] opacity-80">Ad</span>
        <span className="t-meta hidden min-w-0 truncate opacity-90 sm:inline">{ad.adText}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-3)] transition-colors group-hover:text-[var(--mint)]">
        <span className="underline decoration-[var(--border-2)] underline-offset-2 group-hover:decoration-[var(--mint)]">{domain}</span>
        <IconArrowUpRight size={11} />
      </span>
    </div>
  );
}
