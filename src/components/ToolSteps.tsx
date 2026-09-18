"use client";

import { useState } from "react";
import type { ToolEvent } from "@/lib/types";
import { IconArrowRight, IconBolt, IconFile, IconFolder, IconSearch, IconSparkle } from "./icons";

const VERB: Record<string, string> = {
  read_file: "Read",
  write_file: "Wrote",
  edit_file: "Edited",
  list_dir: "Listed",
  search: "Searched",
  run_command: "Ran",
};

function StepIcon({ name }: { name: string }) {
  if (name === "list_dir") return <IconFolder size={13} />;
  if (name === "search") return <IconSearch size={13} />;
  if (name === "run_command") return <IconBolt size={13} />;
  if (name === "write_file" || name === "edit_file") return <IconSparkle size={13} />;
  return <IconFile size={13} />;
}

function summary(ev: ToolEvent): string {
  const a = ev.args as Record<string, unknown>;
  const s = (a.path ?? a.pattern ?? a.command ?? "") as string;
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

/**
 * One tool step as an always-visible one-liner — icon, verb, subject — with the
 * real output one click away. This is the row the live timeline uses, so work
 * reads in order: step, step, ad card, step, then the answer.
 */
export function StepRow({ event }: { event: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const running = event.status === "running";
  return (
    <div className="my-1.5">
      <button
        onClick={() => event.output && setOpen((o) => !o)}
        className={`group flex w-full items-center gap-2.5 rounded-[var(--r-sm)] px-1.5 py-1 text-left transition-colors ${event.output ? "hover:bg-[rgba(255,255,255,0.04)]" : ""}`}
        disabled={!event.output}
      >
        <span
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${
            event.status === "done"
              ? "border-[var(--border-2)] text-[var(--text-3)]"
              : event.status === "error"
                ? "border-[rgba(255,110,110,0.3)] text-[#ff9b9b]"
                : "border-[rgba(240,179,74,0.35)] text-[var(--amber)]"
          }`}
        >
          {running ? <span className="dot-live" /> : <StepIcon name={event.name} />}
        </span>
        <span className="shrink-0 text-[12.5px] text-[var(--text-1)]">{VERB[event.name] ?? event.name}</span>
        <span className="mono min-w-0 truncate text-[11.5px] text-[var(--text-3)]">{summary(event)}</span>
        {event.output && (
          <span className={`ml-auto shrink-0 text-[10px] text-[var(--text-4)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}>
            <IconArrowRight size={11} className={open ? "rotate-90" : ""} />
          </span>
        )}
      </button>
      {open && event.output && (
        <pre className="edge-fade-b mono mt-1.5 ml-8 max-h-52 overflow-auto whitespace-pre-wrap rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.34)] p-3 text-[11.5px] leading-relaxed text-[var(--text-2)]">
          {event.output}
        </pre>
      )}
    </div>
  );
}

/**
 * The agent's work, as a timeline. Collapsed it is one calm line; expanded it
 * is the full audit trail with each tool's real output on demand.
 */
export default function ToolSteps({ events }: { events: ToolEvent[] }) {
  const [open, setOpen] = useState(false);
  const [openOutputs, setOpenOutputs] = useState<Set<number>>(new Set());
  if (!events.length) return null;

  const toggleOutput = (i: number) =>
    setOpenOutputs((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const running = events.some((e) => e.status === "running");

  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="group inline-flex items-center gap-2.5 rounded-full border border-[var(--border-1)] bg-[rgba(255,255,255,0.03)] py-1.5 pl-2.5 pr-3 transition-colors hover:border-[var(--border-2)] hover:bg-[rgba(255,255,255,0.055)]"
      >
        <span className={running ? "dot-live" : "h-1.5 w-1.5 rounded-full bg-[var(--mint)]"} />
        <span className="text-[12.5px] text-[var(--text-2)]">
          Worked · {events.length} step{events.length === 1 ? "" : "s"}
        </span>
        <span className={`text-[11px] text-[var(--text-4)] transition-transform duration-300 ${open ? "rotate-90" : ""}`}>
          <IconArrowRight size={12} className={open ? "rotate-90" : ""} />
        </span>
      </button>

      {open && (
        <div className="fade mt-3 space-y-2.5 border-l border-[var(--border-1)] pl-4">
          {events.map((ev, i) => (
            <div key={ev.callId + i}>
              <button onClick={() => toggleOutput(i)} className="flex w-full items-center gap-2.5 text-left">
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full border ${
                    ev.status === "done"
                      ? "border-[var(--border-2)] text-[var(--text-3)]"
                      : ev.status === "error"
                        ? "border-[rgba(255,110,110,0.3)] text-[#ff9b9b]"
                        : "border-[rgba(240,179,74,0.3)] text-[var(--amber)]"
                  }`}
                >
                  <StepIcon name={ev.name} />
                </span>
                <span className="shrink-0 text-[13px] text-[var(--text-1)]">{VERB[ev.name] ?? ev.name}</span>
                <span className="mono truncate text-[12px] text-[var(--text-3)]">{summary(ev)}</span>
              </button>
              {openOutputs.has(i) && ev.output && (
                <pre className="edge-fade-b mono mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-[var(--r-sm)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.34)] p-3.5 text-[11.5px] leading-relaxed text-[var(--text-2)]">
                  {ev.output}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
