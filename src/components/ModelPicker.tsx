"use client";

import { useEffect, useRef, useState } from "react";
import type { UiModel } from "@/lib/client/api";
import { compactNumber } from "@/lib/client/format";
import { IconCheck, IconSparkle } from "./icons";

export type PickerModel = UiModel;

export default function ModelPicker({
  modelId,
  onChange,
  models,
  bare = false,
}: {
  modelId: string;
  onChange: (id: string) => void;
  models: PickerModel[];
  /** Quiet inline presentation for the composer footer, where the picker sits
   * in a strip of small controls rather than as a standalone glass button. */
  bare?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === modelId) ?? models[0];

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);

  return (
    <div ref={ref} className="relative no-drag">
      <button
        onClick={() => setOpen((o) => !o)}
        className={
          bare
            ? "flex max-w-[210px] items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-[var(--text-3)] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--text-1)]"
            : "btn btn-glass btn-sm max-w-[240px] gap-2.5"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <IconSparkle size={bare ? 12 : 14} className="shrink-0 text-[var(--mint)]" />
        <span className="truncate">{current ? current.label : "Loading…"}</span>
        {current?.unmetered && !bare && <span className="chip chip-mint h-[18px] px-1.5 text-[10px]">unmetered</span>}
        {current?.premium && bare && (
          <span className={`chip h-[17px] px-1.5 text-[10px] ${current.unlocked ? "chip-amber" : "chip-muted"}`}>
            {current.unlocked ? "reserve" : "locked"}
          </span>
        )}
        <span aria-hidden className={bare ? "text-[9px] opacity-70" : "text-[var(--text-4)]"}>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          className="glass-strong sheen absolute bottom-full right-0 z-30 mb-2.5 max-h-[60vh] w-[352px] overflow-y-auto rounded-[var(--r-lg)] p-1.5"
          style={{ boxShadow: "var(--shadow-pop)" }}
        >
          <div className="eyebrow px-3 pb-2 pt-2.5">Catalog</div>
          {models.map((m) => {
            const active = m.id === modelId;
            return (
              <button
                key={m.id}
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`flex w-full items-start gap-3 rounded-[var(--r-sm)] px-3 py-2.5 text-left transition-colors ${
                  active ? "bg-[rgba(255,255,255,0.08)]" : "hover:bg-[rgba(255,255,255,0.045)]"
                } ${m.available ? "" : "opacity-55"}`}
              >
                <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border ${m.available ? "border-[var(--border-2)] text-[var(--mint)]" : "border-[var(--border-1)] text-[var(--text-4)]"}`}>
                  {active ? <IconCheck size={12} /> : <IconSparkle size={12} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13.5px] text-[var(--text-1)]">{m.label}</span>
                    {m.unmetered && <span className="chip chip-mint h-[18px] px-1.5 text-[10px]">unmetered</span>}
                    {!m.available && <span className="chip chip-muted h-[18px] px-1.5 text-[10px]">no key</span>}
                    {m.premium && (
                      <span className={`chip h-[18px] px-1.5 text-[10px] ${m.unlocked ? "chip-amber" : "chip-muted"}`}>
                        {m.unlocked ? "reserve" : `needs $${m.requiresBalanceUsd.toFixed(2)}`}
                      </span>
                    )}
                  </span>
                  <span className="t-micro mt-1 block truncate">
                    {m.via ?? "needs a key"} · {compactNumber(m.contextWindow)} ctx
                    {m.priceIn || m.priceOut ? ` · $${m.priceIn.toFixed(2)}/$${m.priceOut.toFixed(2)} per 1M` : ""}
                  </span>
                  {/*
                    Used to name the shortfall and send you to Economy → Earn.
                    That page is out of the navigation now, so the line states
                    the condition without quoting the balance at you.
                  */}
                  {m.premium && !m.unlocked && (
                    <span className="t-micro mt-1 block text-[var(--amber)]">
                      Needs ad revenue banked behind a connected key to unlock
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          <div className="mt-1 border-t border-[var(--border-1)] px-3 py-2.5">
            <p className="t-micro leading-relaxed">
              The deployment&apos;s own credential serves the whole catalog. Add models in Explore → Add model.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
