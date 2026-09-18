"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessMode, ThinkingIntensity } from "@/lib/types";
import type { UiModel, UiSkill } from "@/lib/client/api";
import { api, errorMessage } from "@/lib/client/api";
import { compactNumber } from "@/lib/client/format";
import ModelPicker from "./ModelPicker";
import { IconCheck, IconFolder, IconPaperclip } from "./icons";

/**
 * The composer footer: one compact strip under the message box carrying the
 * choices that shape a turn.
 *
 * Everything here is a real control backed by real state — the model comes from
 * the catalog, the thinking level is sent to the provider (and the control is
 * disabled on models that would reject it), skills genuinely narrow the tool set
 * the agent is served, attachments are uploaded and inlined, and the ring is the
 * measured context against the model's real window size. Nothing is decorative.
 */

const THINKING_LEVELS: { id: ThinkingIntensity; label: string; blurb: string }[] = [
  { id: "off", label: "Off", blurb: "Answer directly. Cheapest and fastest." },
  { id: "low", label: "Low", blurb: "A little deliberation on hard steps." },
  { id: "medium", label: "Medium", blurb: "Balanced — the default." },
  { id: "high", label: "High", blurb: "Think hardest. Slowest and priciest per turn." },
];

const ACCESS_MODES: { id: AccessMode; label: string; blurb: string }[] = [
  { id: "full", label: "Full access", blurb: "The agent may read, write, edit and run commands in the project folder — the working default." },
  { id: "readonly", label: "Read-only", blurb: "Inspect and explain only: the write, edit and run tools are removed server-side for this turn." },
];

function baseName(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/**
 * The project switcher: which folder the agent works in.
 *
 * "Choose folder…" asks the server for the native folder sheet — parented to
 * the app's own window so it is always visible, any folder is directly
 * selectable (Desktop included), the confirm button reads "Select folder", and
 * it can be used as often as you like. In a plain browser tab there is no
 * native dialog and browsers refuse to reveal absolute paths anyway, so the
 * menu says so and offers the typed path instead.
 */
function ProjectMenu() {
  const [root, setRoot] = useState<string>("");
  const [recent, setRecent] = useState<string[]>([]);
  const [manual, setManual] = useState(false);
  const [path, setPath] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const w = await api.workspace();
      setRoot(w.root);
      setRecent(w.recentWorkspaces ?? []);
    } catch {
      /* the menu still opens; it just has nothing to list yet */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = async (p: string) => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.setWorkspaceRoot(p);
      if (r.ok) {
        setManual(false);
        setPath("");
        await load();
        return true;
      }
      setErr(r.error ?? "That folder could not be set.");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
    return false;
  };

  const pick = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.pickWorkspace();
      if (r.ok) {
        await load();
        return true;
      }
      if (r.dialog === false) {
        // No native dialog here (a plain browser): the typed path is the way.
        setManual(true);
        if (r.error) setErr(r.error);
      }
      // A cancel means the user changed their mind — show nothing.
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
    return false;
  };

  return (
    <Menu
      label="Project"
      summary={root ? baseName(root) : "Choose…"}
      title={root || "Pick the folder the agent works in"}
    >
      {(close) => (
        <>
          <div className="eyebrow px-3 pb-2 pt-2.5">Project folder</div>
          {root && (
            <div className="mono truncate px-3 pb-2 text-[11px] text-[var(--text-3)]" title={root}>
              {root}
            </div>
          )}
          {recent.filter((p) => p !== root).length > 0 && (
            <div className="max-h-40 overflow-y-auto px-1.5 pb-1">
              {recent
                .filter((p) => p !== root)
                .map((p) => (
                  <button
                    key={p}
                    role="menuitem"
                    onClick={() => {
                      void set(p).then((ok) => ok && close());
                    }}
                    className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-2 text-left transition-colors hover:bg-[rgba(255,255,255,0.045)]"
                  >
                    <IconFolder size={13} className="shrink-0 text-[var(--text-3)]" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] text-[var(--text-1)]">{baseName(p)}</span>
                      <span className="mono t-micro block truncate">{p}</span>
                    </span>
                  </button>
                ))}
            </div>
          )}
          <div className="border-t border-[var(--border-1)] p-1.5">
            {!manual ? (
              <button
                role="menuitem"
                onClick={() => void pick().then((ok) => ok && close())}
                disabled={busy}
                className="btn btn-glass w-full justify-center"
              >
                <IconFolder size={13} />
                {busy ? "Waiting for the folder dialog…" : "Choose folder…"}
              </button>
            ) : (
              <div className="space-y-1.5">
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && path.trim()) void set(path.trim());
                  }}
                  placeholder="/Users/you/Projects/my-app"
                  className="mono w-full rounded-[var(--r-sm)] border border-[var(--border-2)] bg-[rgba(0,0,0,0.3)] px-2.5 py-2 text-[12px] text-[var(--text-1)] placeholder-[var(--text-4)] focus:border-[var(--mint)] focus:outline-none"
                />
                <button
                  role="menuitem"
                  onClick={() => path.trim() && void set(path.trim()).then((ok) => ok && close())}
                  disabled={busy || !path.trim()}
                  className="btn btn-glass w-full justify-center"
                >
                  Set project folder
                </button>
              </div>
            )}
            {err && <p className="t-micro px-2 pb-1 pt-1.5 leading-relaxed text-[#ff9b9b]">{err}</p>}
            <p className="t-micro px-2 pb-1.5 pt-1.5 leading-relaxed">
              The agent reads, edits and runs commands here. Every turn — including its shell working directory — is
              contained to this folder.
            </p>
          </div>
        </>
      )}
    </Menu>
  );
}

function Divider() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-[var(--border-2)]" />;
}

/** Small popover used by the thinking and skills menus. */
function Menu({
  label,
  summary,
  tone = "neutral",
  disabled = false,
  title,
  children,
}: {
  label: string;
  summary: string;
  tone?: "neutral" | "accent";
  disabled?: boolean;
  title?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative no-drag">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] transition-colors disabled:opacity-45 ${
          tone === "accent"
            ? "text-[var(--mint)] hover:bg-[rgba(255,255,255,0.06)]"
            : "text-[var(--text-3)] hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--text-1)]"
        }`}
      >
        <span aria-hidden className="t-micro hidden uppercase tracking-[0.14em] opacity-70 sm:inline">{label}</span>
        <span className="whitespace-nowrap">{summary}</span>
        <span aria-hidden className="text-[9px] opacity-70">▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className="glass-strong sheen absolute bottom-full left-0 z-30 mb-2.5 w-[288px] rounded-[var(--r-lg)] p-1.5"
          style={{ boxShadow: "var(--shadow-pop)" }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function Option({
  active,
  title,
  blurb,
  right,
  onClick,
}: {
  active: boolean;
  title: string;
  blurb: string;
  right?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={`flex w-full items-start gap-2.5 rounded-[var(--r-sm)] px-2.5 py-2 text-left transition-colors ${
        active ? "bg-[rgba(255,255,255,0.08)]" : "hover:bg-[rgba(255,255,255,0.045)]"
      }`}
    >
      <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${active ? "border-[var(--mint)] text-[var(--mint)]" : "border-[var(--border-2)]"}`}>
        {active && <IconCheck size={10} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[12.5px] text-[var(--text-1)]">{title}</span>
          {right}
        </span>
        <span className="t-micro mt-0.5 block leading-relaxed">{blurb}</span>
      </span>
    </button>
  );
}

/**
 * Context ring: how full the model's window is, measured rather than guessed.
 *
 * The figure is the last provider-reported usage (prompt + completion tokens,
 * which together are what sat in context), falling back to a character estimate
 * for a conversation that has not had a metered call yet. It fills as a
 * conversation grows and turns amber then red as the window fills, so a long
 * session visibly approaches its limit instead of silently truncating.
 */
function ContextRing({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.max(0, Math.min(1, used / total)) : 0;
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const tone = pct >= 0.9 ? "#ff9b9b" : pct >= 0.7 ? "var(--amber)" : "var(--mint)";
  return (
    <span
      className="flex shrink-0 items-center gap-1.5"
      title={`Context: ${used.toLocaleString()} of ${compactNumber(total)} tokens (${Math.round(pct * 100)}%)`}
    >
      <svg width={17} height={17} viewBox="0 0 18 18" aria-hidden className="shrink-0">
        <circle cx={9} cy={9} r={radius} fill="none" stroke="rgba(255,255,255,0.13)" strokeWidth={2} />
        <circle
          cx={9}
          cy={9}
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${pct * circumference} ${circumference}`}
          transform="rotate(-90 9 9)"
          style={{ transition: "stroke-dasharray 700ms cubic-bezier(0.22,0.61,0.36,1), stroke 300ms ease" }}
        />
      </svg>
      <span className="num hidden text-[11.5px] text-[var(--text-3)] xl:inline">
        {compactNumber(used)}/{compactNumber(total)}
      </span>
    </span>
  );
}

export default function ComposerBar({
  modelId,
  models,
  onModel,
  thinking,
  onThinking,
  skills,
  activeSkills,
  onToggleSkill,
  access,
  onAccess,
  onAttach,
  attachments,
  onRemoveAttachment,
  onPasteHint,
  contextUsed,
  contextWindow,
  elapsedSec,
  streaming,
}: {
  modelId: string;
  models: UiModel[];
  onModel: (id: string) => void;
  thinking: ThinkingIntensity;
  onThinking: (t: ThinkingIntensity) => void;
  skills: UiSkill[];
  activeSkills: string[];
  onToggleSkill: (id: string) => void;
  access: AccessMode;
  onAccess: (a: AccessMode) => void;
  onAttach: (files: File[]) => void;
  attachments: { id: string; name: string; sizeBytes: number }[];
  onRemoveAttachment: (id: string) => void;
  onPasteHint: boolean;
  contextUsed: number;
  contextWindow: number;
  elapsedSec: number;
  streaming: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const model = models.find((m) => m.id === modelId);
  const canThink = !!model?.reasoning;
  const thinkingLabel = THINKING_LEVELS.find((t) => t.id === thinking)?.label ?? "Medium";
  const minutes = Math.floor(elapsedSec / 60);
  const seconds = elapsedSec % 60;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-[var(--border-1)] px-1 pt-2">
      <ProjectMenu />

      <Divider />

      <ModelPicker modelId={modelId} onChange={onModel} models={models} bare />

      <Divider />

      <Menu
        label="Access"
        summary={ACCESS_MODES.find((a) => a.id === access)?.label ?? "Full access"}
        tone={access === "readonly" ? "accent" : "neutral"}
        title="How much of the machine the agent may touch this turn"
      >
        {(close) => (
          <>
            <div className="eyebrow px-3 pb-2 pt-2.5">Tool access</div>
            {ACCESS_MODES.map((a) => (
              <Option
                key={a.id}
                active={a.id === access}
                title={a.label}
                blurb={a.blurb}
                onClick={() => {
                  onAccess(a.id);
                  close();
                }}
              />
            ))}
            <div className="mt-1 border-t border-[var(--border-1)] px-3 py-2">
              <p className="t-micro leading-relaxed">
                Enforced on the server at tool-execution time, not just in the prompt — a read-only turn has no write or
                run tools to call even if the model tries.
              </p>
            </div>
          </>
        )}
      </Menu>

      <Divider />

      <Menu
        label="Thinking"
        summary={thinkingLabel}
        tone={thinking === "high" ? "accent" : "neutral"}
        disabled={!canThink}
        title={
          canThink
            ? "How much deliberation the model is allowed per step"
            : `${model?.label ?? "This model"} does not accept a reasoning setting`
        }
      >
        {(close) => (
          <>
            <div className="eyebrow px-3 pb-2 pt-2.5">Thinking intensity</div>
            {THINKING_LEVELS.map((t) => (
              <Option
                key={t.id}
                active={t.id === thinking}
                title={t.label}
                blurb={t.blurb}
                onClick={() => {
                  onThinking(t.id);
                  close();
                }}
              />
            ))}
            <div className="mt-1 border-t border-[var(--border-1)] px-3 py-2">
              <p className="t-micro leading-relaxed">
                Sent as <span className="mono">reasoning.effort</span> to OpenRouter. Higher levels spend more per turn and are billed the same way.
              </p>
            </div>
          </>
        )}
      </Menu>

      <Divider />

      <Menu
        label="Skills"
        summary={activeSkills.length ? `${activeSkills.length} on` : "None"}
        tone={activeSkills.length ? "accent" : "neutral"}
        title="Ways of working: each one changes the workflow and the tools the agent may use"
      >
        {() => (
          <>
            <div className="eyebrow px-3 pb-2 pt-2.5">Skills</div>
            {skills.map((s) => (
              <Option
                key={s.id}
                active={activeSkills.includes(s.id)}
                title={s.name}
                blurb={s.blurb}
                right={s.readOnly ? <span className="chip chip-muted h-[17px] px-1.5 text-[10px]">read-only</span> : undefined}
                onClick={() => onToggleSkill(s.id)}
              />
            ))}
            <div className="mt-1 border-t border-[var(--border-1)] px-3 py-2">
              <p className="t-micro leading-relaxed">
                A read-only skill has no write or run tools at all — the allowlist is enforced on the server, not just requested in the prompt.
              </p>
            </div>
          </>
        )}
      </Menu>

      <Divider />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="no-drag flex items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-[var(--text-3)] transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-[var(--text-1)]"
        title="Attach files — images are sent to the model, text files are inlined"
      >
        <IconPaperclip size={13} />
        <span className="hidden sm:inline">Attach</span>
        {attachments.length > 0 && <span className="chip chip-mint h-[17px] px-1.5 text-[10px]">{attachments.length}</span>}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onAttach(files);
          e.target.value = "";
        }}
      />

      <span className="flex-1" />

      {elapsedSec > 0 && (
        <span className="num shrink-0 text-[11.5px] text-[var(--text-3)]" title={streaming ? "Time on this turn" : "Time on the last turn"}>
          {minutes}:{String(seconds).padStart(2, "0")}
        </span>
      )}

      <ContextRing used={contextUsed} total={contextWindow} />

      {/*
        An "Earn $x.xx" chip with a link to the ledger used to sit at the end of
        this row — the same credits indicator Freebuff removes from its message
        footer. The context ring stays; the price of the call does not.
      */}

      {onPasteHint && <span className="t-micro w-full">Paste or drop a file anywhere in the box to attach it.</span>}
    </div>
  );
}
