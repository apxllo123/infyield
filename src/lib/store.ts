import fs from "fs";
import path from "path";

// Tiny JSON file store. Desktop (.app) runs set INFYIELD_DATA_DIR so the
// bundle stays read-only; server/dev runs default to ./.data (gitignored).
// AGENTFUEL_DATA_DIR is the pre-rename name, still honored for old bundles.
const DATA_DIR =
  process.env.INFYIELD_DATA_DIR || process.env.AGENTFUEL_DATA_DIR || path.join(process.cwd(), ".data");

export function dataDir(): string {
  ensureDir();
  return DATA_DIR;
}

/** Absolute path inside the data dir, created on demand. */
export function dataPath(...parts: string[]): string {
  const p = path.join(DATA_DIR, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
  ensureDir();
  const p = path.join(DATA_DIR, file);
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write a JSON file, owner-only.
 *
 * These files are not just app state. `settings.json` holds the Stripe secret
 * key and both access passwords, and the credential file beside it holds a
 * provider key that can spend money — so the default `0644` was the difference
 * between "the secrets are on this machine" and "the secrets are readable by
 * every account on this machine".
 *
 * The `mode` option only applies when the file is *created*, so an existing file
 * (or one written by an earlier build) is tightened explicitly afterwards.
 */
export function writeJson(file: string, value: unknown): void {
  ensureDir();
  const p = path.join(DATA_DIR, file);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, p);
  fs.chmodSync(p, 0o600);
}

/**
 * An in-process mutex, one per file.
 *
 * ## What this does and does not fix
 *
 * A plain `readJson` → mutate → `writeJson` sequence **cannot** lose an update on
 * its own: the event loop is single-threaded and the store is synchronous, so no
 * other request can run a statement in the middle of that sequence. Adding a lock
 * around such a sequence would suggest a hazard that isn't there.
 *
 * The hazard is a critical section that spans an `await`. The impression path is
 * exactly that: it has to reach the ad network's pixel before it may book, so
 * "has this impression been booked?" is answered in one task and "book it" lands
 * in another, and two concurrent acknowledgements of the same impression can both
 * pass the first question. This lock is what makes that decision — check, await,
 * write — atomic with respect to other callers touching the same file.
 *
 * ## Rules
 *
 * - Take it at the outermost boundary only. The synchronous `readJson`/
 *   `writeJson` calls inside a locked section do **not** take it, and must not:
 *   this is not a reentrant lock, and re-entering the same file deadlocks.
 * - It is per *process*. Two servers sharing one data dir (a dev server and a
 *   packaged app, say) are still unguarded against each other — that would need
 *   a real file lock, which is deliberately out of scope here.
 */
const fileLocks = new Map<string, Promise<void>>();

export function withFileLock<T>(file: string, critical: () => T | Promise<T>): Promise<T> {
  const key = path.join(DATA_DIR, file);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  // Queued on the previous holder whether it succeeded or threw, so one failed
  // critical section cannot wedge every later caller on that file.
  const run = previous.then(critical, critical);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  fileLocks.set(key, tail);
  void tail.then(() => {
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  });
  return run;
}
