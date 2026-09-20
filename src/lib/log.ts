/**
 * Structured operational log — one JSON line per event.
 *
 * Infyield had no log stream at all. A failure was visible only as a field in a
 * single HTTP response, a sentence in `settings.json`, or a row in the usage
 * ledger — none of which an operator watching the running app can see happen. So
 * a refused ad pixel, a refused OAuth callback, and a failed model turn all
 * looked the same from the console: nothing.
 *
 * Every event here is one line, tagged with a constant event name, so lines can
 * be grouped and queried with the usual tooling (jq, `grep`, a log shipper). No
 * dynamic value is ever interpolated into the event name — the name is the
 * template, and everything variable is a field. A field-only payload keeps one
 * event's lines clustering together instead of fragmenting per request.
 *
 * Never pass a secret, a credential, an API key, message content, or anything
 * else that could carry personal data. The callers are responsible for choosing
 * fields; this module only serialises them.
 */

export type LogLevel = "info" | "warn" | "error";

/**
 * Emit one event. `event` is a constant dotted name (`chat.stream.failed`), and
 * `fields` carries every varying value — ids, counts, outcomes, reasons.
 *
 * `info` goes to stdout and `warn`/`error` to stderr, matching how the Electron
 * shell already reports a boot failure on stderr.
 */
export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const base = { at: new Date().toISOString(), level, event, service: "infyield" };
  let line: string;
  try {
    line = JSON.stringify({ ...base, ...fields });
  } catch {
    // A field that cannot be serialised (a circular object, a BigInt) must not
    // take the request down with it — fall back to the event identity alone.
    line = JSON.stringify(base);
  }
  (level === "info" ? process.stdout : process.stderr).write(`${line}\n`);
}

/** Extract the queryable parts of an unknown thrown value. */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack ? { errorStack: error.stack } : {}),
    };
  }
  return { errorMessage: String(error) };
}

/** Log a failure with the error's identity preserved, for catch blocks. */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  logEvent("error", event, { ...fields, ...errorFields(error) });
}
