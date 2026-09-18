"use client";

import { Fragment, type ReactNode } from "react";

/** Minimal, dependency-free markdown good enough for agent output. */
function inline(text: string, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith("`")) {
      parts.push(
        <code key={key} className="mono rounded-[6px] border border-[var(--border-1)] bg-[rgba(0,0,0,0.34)] px-1.5 py-0.5 text-[12.5px] text-[var(--text-1)]">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      parts.push(
        <strong key={key} className="font-semibold text-[var(--text-1)]">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("*")) {
      parts.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else {
      const label = tok.slice(1, tok.indexOf("]"));
      const href = tok.slice(tok.indexOf("](") + 2, -1);
      parts.push(
        <a key={key} href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--mint)] underline decoration-[rgba(53,224,161,0.4)] underline-offset-2 hover:decoration-[var(--mint)]">
          {label}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="mono edge-fade-b my-3.5 overflow-x-auto rounded-[var(--r-md)] border border-[var(--border-1)] bg-[rgba(0,0,0,0.34)] p-4 text-[12.5px] leading-relaxed text-[var(--text-2)]">
          {lang && <div className="eyebrow mb-2.5">{lang}</div>}
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      blocks.push(
        <div key={key++} className={`mb-1.5 mt-5 font-semibold tracking-[-0.015em] text-[var(--text-1)] ${level <= 2 ? "text-[16.5px]" : "text-[14.5px]"}`}>
          {inline(line.replace(/^#+\s/, ""), `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) items.push(lines[i++].slice(2));
      blocks.push(
        <ul key={key++} className="my-2.5 space-y-1.5 pl-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2.5">
              <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-[var(--text-4)]" />
              <span className="min-w-0">{inline(it, `li${key}-${j}`)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) items.push(lines[i++].replace(/^\d+\.\s/, ""));
      blocks.push(
        <ol key={key++} className="my-2.5 space-y-1.5">
          {items.map((it, j) => (
            <li key={j} className="flex gap-2.5">
              <span className="num mt-[1px] shrink-0 text-[13px] text-[var(--text-4)]">{j + 1}</span>
              <span className="min-w-0">{inline(it, `ol${key}-${j}`)}</span>
            </li>
          ))}
        </ol>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^[-*]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i])
    )
      buf.push(lines[i++]);
    blocks.push(
      <p key={key++} className="my-2.5 whitespace-pre-wrap">
        {inline(buf.join("\n"), `p${key}`)}
      </p>,
    );
  }

  return <div className="t-body-strong">{blocks.map((b, idx) => <Fragment key={idx}>{b}</Fragment>)}</div>;
}
