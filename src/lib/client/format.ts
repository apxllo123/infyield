/**
 * Presentation helpers. Money is always rendered at the same precision so
 * figures line up column-wise wherever they appear.
 */

export function usd(n: number | null | undefined, digits = 4): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(digits)}`;
}

export function usdSigned(n: number, digits = 4): string {
  return `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(digits)}`;
}

export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function bytes(n: number): string {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A one-line, human summary of a conversation for list rows. */
export function chatSummary(messages: { role: string; content: string }[]): string {
  const first = messages.find((m) => m.role === "user" && m.content.trim());
  if (!first) return "No messages yet";
  const text = first.content.replace(/\s+/g, " ").trim();
  return text.length > 96 ? `${text.slice(0, 96)}…` : text;
}

export function providerLabel(p: string): string {
  switch (p) {
    case "openrouter":
      return "OpenRouter";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google AI";
    default:
      return "Custom endpoint";
  }
}
