"use client";

import { useEffect, useRef, useState } from "react";
import type { SponsoredAd } from "@/lib/types";
import type { FundingHold } from "@/hooks/useAgentChat";
import AdCard from "@/components/AdCard";
import { IconArrowRight } from "./icons";

/**
 * The earn step of the funding loop, shown where the refused reply would have
 * been: the gate held the turn, so a sponsored card is served right here and
 * the request can be retried once it has had a chance to earn.
 *
 * Two honesty rules it inherits from the rest of the product:
 *  - No invented numbers. The card shows the gate's own message and, when the
 *    inventory is house placeholder (nobody will ever pay for it), it says that
 *    a premium unlock cannot come from viewing these — instead of implying that
 *    a few impressions will move a collectible-revenue floor.
 *  - No automatic loop. Retrying is a button, not a timer that resubmits paid
 *    requests on the user's behalf; the server's admission gate stays the only
 *    thing that decides when a turn may run.
 */
export default function SponsorBreak({ hold, onRetry }: { hold: FundingHold; onRetry: () => void }) {
  const [ad, setAd] = useState<SponsoredAd | null>(null);
  const [seenMs, setSeenMs] = useState<number | null>(null);
  const impressionDoneRef = useRef(false);

  // One auction for this break, on mount. The card's own impression effect
  // books the view; there is no impression without a rendered card.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/ads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })
      .then((r) => r.json())
      .then((j: { ads?: SponsoredAd[] }) => {
        if (!cancelled) setAd(j.ads?.[0] ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Give the impression a beat to book before the retry unlocks — long enough
  // for the pixel to have fired, short enough not to feel like a lock.
  useEffect(() => {
    if (!ad || impressionDoneRef.current) return;
    impressionDoneRef.current = true;
    const t = setTimeout(() => setSeenMs(4_000), 4_000);
    return () => clearTimeout(t);
  }, [ad]);

  const houseOnly = (hold.funding?.confirmedRevenueUsd ?? 0) <= 0 && (hold.funding?.houseRevenueUsd ?? 0) > 0;

  return (
    <div className="rise rounded-[var(--r-md)] border border-[var(--border-2)] bg-[rgba(255,255,255,0.03)] p-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold text-[var(--text-1)]">A short sponsored break</span>
        <span className="t-micro uppercase tracking-[0.14em] opacity-80">funding hold</span>
      </div>
      <p className="t-meta mt-1.5">{hold.message}</p>
      {houseOnly && (
        <p className="t-micro mt-2 text-[var(--text-3)]">
          This deployment is running house inventory right now — placeholder cards keep the ledger moving but nobody
          pays for them, so they cannot fund a premium unlock.
        </p>
      )}
      {ad && <AdCard ad={ad} />}
      <div className="mt-1 flex items-center justify-end gap-3">
        {hold.retryAfterSec ? (
          <span className="t-micro text-[var(--text-3)]">the gate suggests waiting ~{hold.retryAfterSec}s</span>
        ) : null}
        <button className="btn btn-glass btn-sm" onClick={onRetry} disabled={seenMs === null}>
          Viewed — retry the request
          <IconArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}
