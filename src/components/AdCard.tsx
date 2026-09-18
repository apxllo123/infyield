"use client";

import { useEffect, useRef, useState } from "react";
import type { SponsoredAd } from "@/lib/types";
import { IconArrowUpRight } from "./icons";

function impressionToken(impUrl: string): string {
  try {
    return new URL(impUrl, "http://local.invalid").searchParams.get("i") ?? impUrl;
  } catch {
    return impUrl;
  }
}

/** Stable across remounts of the same creative, so a retry is the same event. */
function impressionEventId(impUrl: string): string {
  return impressionToken(impUrl) || (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random()));
}

function clickEventId(impUrl: string): string {
  return `click-${impressionEventId(impUrl)}`;
}

/**
 * The advertiser's mark, as a square tile: the network's image icon when one
 * came with the creative, an emoji for house inventory, and — so a card is
 * never anonymous — the domain's first letter as the fallback. This is the
 * "icon of the thing" native ads carry; without it a text card reads as spam.
 */
export function AdIcon({ ad, size = 38 }: { ad: SponsoredAd; size?: number }) {
  const [imgState, setImgState] = useState<"loading" | "ok" | "failed">("loading");
  const domain = ad.domain || ad.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  const icon = (ad.icon ?? "").trim();
  if (icon.startsWith("http")) {
    // A network icon (Carbon ships one per creative). Letter fallback while it
    // loads or if it fails, so the layout never has a hole — and hidden again
    // once the image is painted, so a transparent logo has nothing behind it.
    return (
      <span
        className="relative grid shrink-0 place-items-center overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[rgba(255,255,255,0.05)]"
        style={{ width: size, height: size }}
        aria-hidden
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a remote ad icon; next/image would proxy it through our own server */}
        <img
          src={icon}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-contain"
          onLoad={() => setImgState("ok")}
          onError={() => setImgState("failed")}
        />
        {imgState !== "ok" && (
          <span className="absolute text-[13px] font-semibold text-[var(--text-3)]">{(domain || "S")[0].toUpperCase()}</span>
        )}
      </span>
    );
  }
  const emoji = icon && icon.length <= 8 ? icon : "";
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[linear-gradient(160deg,rgba(255,255,255,0.07),rgba(255,255,255,0.015))]"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      aria-hidden
    >
      {emoji || (domain || "S")[0].toUpperCase()}
    </span>
  );
}

/**
 * The inline sponsored card, laid out the way the Freebuff CLI lays out its
 * inline ads (common/ads/inline-ad-layout.ts): row one is the icon, the bold
 * headline and the `Ad` disclosure hard against its right edge — never below
 * the fold — and row two is the description with the domain label and the ↗
 * suffix on the right. Two rows, one border, nothing decorative: the card is
 * exactly as tall as the two lines it needs, because it sits *between* tool
 * steps in the transcript rather than after the reply.
 *
 * Counts one impression per rendered creative (deduped, so a re-render never
 * double-bills), and routes clicks through the tracked endpoint.
 */
export default function AdCard({ ad }: { ad: SponsoredAd }) {
  const firedRef = useRef<string | null>(null);

  useEffect(() => {
    if (firedRef.current === ad.impUrl) return;
    firedRef.current = ad.impUrl;
    fetch(ad.impUrl, { method: "POST", headers: { "x-infyield-event-id": impressionEventId(ad.impUrl) } }).catch(() => {});
  }, [ad.impUrl]);

  const onClick = () => {
    fetch(ad.clickUrl, { method: "POST", headers: { "x-infyield-event-id": clickEventId(ad.impUrl) } })
      .then((r) => r.json())
      .then((j: { url?: string }) => {
        const url = j.url || ad.url;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      })
      .catch(() => window.open(ad.url, "_blank", "noopener,noreferrer"));
  };

  const domain = ad.domain || ad.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
  const cta = ad.cta || "Learn more";

  return (
    <div
      onClick={onClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      aria-label={`Sponsored: ${ad.title}`}
      className="group my-3 cursor-pointer overflow-hidden rounded-[var(--r-md)] border border-[var(--border-1)] bg-[rgba(255,255,255,0.028)] transition-colors hover:border-[var(--border-2)] hover:bg-[rgba(255,255,255,0.05)]"
    >
      {/* Row one: the thing's icon, the headline, and the disclosure that must
          never drop off the row. */}
      <div className="flex items-center gap-3 px-3.5 pb-0.5 pt-2.5">
        <AdIcon ad={ad} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[var(--text-1)]">{ad.title}</span>
        <span className="t-micro shrink-0 uppercase tracking-[0.14em] opacity-80">Ad</span>
      </div>
      {/* Row two: copy, with the domain and the arrow riding the right edge. */}
      <div className="flex items-center justify-between gap-3 pl-[62px] pr-3.5 pb-2.5 pt-0.5">
        <span className="t-meta min-w-0 truncate">{ad.adText}</span>
        <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-[var(--text-3)] transition-colors group-hover:text-[var(--mint)]" title={cta}>
          <span className="underline decoration-[var(--border-2)] underline-offset-2 group-hover:decoration-[var(--mint)]">{domain}</span>
          <IconArrowUpRight size={12} />
        </span>
      </div>
    </div>
  );
}
