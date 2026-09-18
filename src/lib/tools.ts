import type { ToolResult, ToolSpec } from "./types";
import { resolveSafe, assertRootExists } from "./paths";
import { getSettings } from "./settings";
import { readJson, withFileLock, writeJson } from "./store";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

// Workspace tools available to the agent. Commands are restricted to the
// configured workspace root directory.
export const TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a text file from the workspace. Optionally read a specific line range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path from workspace root" },
        offset: { type: "number", description: "1-indexed start line (optional)" },
        limit: { type: "number", description: "Max lines to read (optional)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the workspace with full content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path from workspace root" },
        content: { type: "string", description: "Complete file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact substring in a file with new text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path from workspace root" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["path", "oldString", "newString"],
    },
  },
  {
    name: "list_dir",
    description: "List files and folders in a directory of the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path (use '.' for root)" } },
      required: ["path"],
    },
  },
  {
    name: "search",
    description: "Regex text search across workspace files. Returns file paths, line numbers and matching lines.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        glob: { type: "string", description: "Optional filename filter like *.ts" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace and return stdout/stderr plus the exit code. The working directory persists across calls within a conversation: `cd subdir` moves you there for every later call (absolute paths must stay inside the workspace). Use longer timeouts for builds and test suites.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: {
          type: "string",
          description: "Optional directory to run in (relative to the workspace root, or to the current working directory). `cd` inside `command` is the other way to move around.",
        },
        timeoutSec: {
          type: "number",
          description: "Seconds to allow before the command is killed (default 60, max 600).",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "run_tests",
    description:
      "Run the workspace's own test command. Detects the project type (npm/pnpm/yarn/bun, Python, Rust, Go) and runs its test suite; falls back to the TypeScript type check when there is no test script. Prefer this over guessing a command.",
    parameters: {
      type: "object",
      properties: {
        timeoutSec: { type: "number", description: "Seconds to allow (default 300, max 600)." },
      },
    },
  },
];

/**
 * Which test command this workspace actually uses.
 *
 * Detection rather than configuration: the agent should not have to discover the
 * package manager by trial and error, and guessing wrong produces a confusing
 * failure instead of a test result. `reason` is reported back so the transcript
 * shows why a given command was chosen.
 */
export function detectTestCommand(root: string): { command: string; reason: string } | null {
  const has = (p: string) => fs.existsSync(path.join(root, p));

  if (has("package.json")) {
    const manager = has("pnpm-lock.yaml")
      ? "pnpm"
      : has("yarn.lock")
        ? "yarn"
        : has("bun.lockb") || has("bun.lock")
          ? "bun"
          : "npm";
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {}) as Record<string, string>;
    } catch {
      // A malformed package.json is worth reporting as such further down.
    }
    if (scripts.test) return { command: `${manager} test`, reason: `${manager} \`test\` script` };
    if (scripts.typecheck) return { command: `${manager} run typecheck`, reason: `${manager} \`typecheck\` script (no test script)` };
    if (has("tsconfig.json")) {
      return { command: "npx --no-install tsc --noEmit", reason: "TypeScript project with no test script" };
    }
    return null;
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("tox.ini") || has("tests")) {
    return { command: "python3 -m pytest -q", reason: "pytest project" };
  }
  if (has("Cargo.toml")) return { command: "cargo test", reason: "Rust crate" };
  if (has("go.mod")) return { command: "go test ./...", reason: "Go module" };
  return null;
}

const MAX_OUTPUT = 8000;
const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;

function trunc(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n… (truncated, ${s.length} chars total)` : s;
}

/* --------------------------- working-directory memory ---------------------- */

/**
 * Where each conversation's shell is standing, relative to the workspace root.
 *
 * One-shot `exec` per tool call knows nothing between calls, so a `cd` died
 * with its process and every later command silently ran from the root again —
 * which is exactly how an agent ends up "dumb", rebuilding ./wrong/dir or
 * re-reading a path it already left. The cwd is persisted per session
 * (disk-backed: route bundles share no module memory) and threaded through
 * every run_command, so `cd packages/app && npm test` really does leave the
 * next `ls` inside packages/app.
 */
const CWD_FILE = "shellcwd.json";

function sessionKey(sessionId?: string | null): string {
  return (sessionId ?? "").trim() || "__default__";
}

function loadCwds(): Record<string, string> {
  return readJson<Record<string, string>>(CWD_FILE, {});
}

function currentCwd(root: string, sessionId?: string | null): string {
  const rel = loadCwds()[sessionKey(sessionId)];
  // A stored cwd may name a folder that has since been deleted or moved; fall
  // back to the root rather than failing every later command.
  if (rel && rel !== "." && fs.existsSync(path.join(root, rel))) return rel;
  return ".";
}

function rememberCwd(sessionId: string | null | undefined, rel: string): void {
  const key = sessionKey(sessionId);
  withFileLock(CWD_FILE, () => {
    const m = loadCwds();
    if (rel === ".") delete m[key];
    else m[key] = rel;
    const keys = Object.keys(m);
    if (keys.length > 500) delete m[keys[0]];
    writeJson(CWD_FILE, m);
  });
}

/**
 * Split a leading `cd <target>` off a command chain.
 *
 * Handles `cd x`, `cd x && rest` and `cd x; rest` — the forms a shell one-liner
 * actually uses. `cd` with no target means the workspace root. Returns the new
 * directory (absolute) and the remainder to execute, or null when the command
 * does not start with a cd.
 */
function splitLeadingCd(root: string, command: string, fromAbs: string): { abs: string; rest: string } | null {
  const trimmed = command.trim();
  // `cd x`, `cd x && rest`, `cd x; rest`, bare `cd` — but not `cdx` or a cd
  // buried later in the chain (that one runs inside its own subshell anyway).
  const m = /^cd(?:\s+(?:"([^"]*)"|'([^']*)'|(\S+)))?\s*(?:&&|\|\||;|$)/.exec(trimmed);
  if (!m) return null;
  const rawTarget = m[1] ?? m[2] ?? m[3] ?? "";
  const base = rawTarget.startsWith("/") ? root : fromAbs;
  const abs = rawTarget ? path.resolve(base, rawTarget) : root;
  resolveSafe(root, path.relative(root, abs) || "."); // containment check; throws on escape
  const rest = trimmed.slice(m[0].length).trim();
  return { abs, rest };
}

/**
 * Run one shell command in the workspace and report its output *and* its exit
 * status. The status matters: a failing build that printed nothing was being
 * reported as "(no output)", which reads like success.
 */
function runShell(root: string, command: string, timeoutSec: number, cwdAbs?: string): Promise<string> {
  // The operator's configured default, so a slow project can raise the ceiling
  // once instead of the model having to pass a timeout on every call.
  const fallback = getSettings().commandTimeoutSec || DEFAULT_TIMEOUT_SEC;
  const seconds = Math.min(MAX_TIMEOUT_SEC, Math.max(1, timeoutSec || fallback));
  return new Promise<string>((resolve) => {
    exec(command, { cwd: cwdAbs ?? root, timeout: seconds * 1000, maxBuffer: 8_000_000 }, (err, stdout, stderr) => {
      let out = "";
      if (stdout) out += stdout;
      if (stderr) out += (out ? "\n" : "") + stderr;
      if (err) {
        const timedOut = (err as { killed?: boolean }).killed;
        out += (out ? "\n" : "") + (timedOut ? `timed out after ${seconds}s` : `exit code: ${err.code ?? "?"}`);
      }
      resolve(trunc(out.trim() || "(no output)"));
    });
  });
}

export interface ToolContext {
  /** Groups the shell's working directory per conversation, so `cd` persists. */
  sessionId?: string | null;
}

export async function executeTool(root: string, name: string, args: Record<string, unknown>, ctx: ToolContext = {}): Promise<ToolResult> {
  const callId = "";
  try {
    assertRootExists(root);
    let output = "";
    switch (name) {
      case "read_file": {
        const abs = resolveSafe(root, String(args.path ?? ""));
        if (!fs.existsSync(abs)) throw new Error(`File not found: ${args.path}`);
        const raw = fs.readFileSync(abs, "utf8");
        const lines = raw.split("\n");
        const offset = Math.max(1, Number(args.offset ?? 1));
        const limit = Math.max(1, Math.min(2000, Number(args.limit ?? 2000)));
        const slice = lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${offset + i}| ${l}`);
        output = trunc(slice.join("\n") || "(empty file)");
        break;
      }
      case "write_file": {
        const abs = resolveSafe(root, String(args.path ?? ""));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args.content ?? ""), "utf8");
        output = `Wrote ${abs} (${String(args.content ?? "").length} bytes)`;
        break;
      }
      case "edit_file": {
        const abs = resolveSafe(root, String(args.path ?? ""));
        const raw = fs.readFileSync(abs, "utf8");
        const oldS = String(args.oldString ?? "");
        if (!raw.includes(oldS)) throw new Error("oldString not found in file (must match exactly).");
        // The replacement is a *replacer function*, not a string. A string
        // replacement is a replacement *pattern*: `$&`, ``$` ``, `$'` and `$$`
        // are expanded, so writing `$$` into a shell script or `$1` into a
        // regex silently mangled the file and still reported success. A
        // function's return value is inserted literally.
        const next = raw.replace(oldS, () => String(args.newString ?? ""));
        fs.writeFileSync(abs, next, "utf8");
        output = `Edited ${abs}`;
        break;
      }
      case "list_dir": {
        const abs = resolveSafe(root, String(args.path ?? "."));
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name + "/");
        const files = entries.filter((e) => e.isFile()).map((e) => e.name);
        output = trunc([...dirs.sort(), ...files.sort()].join("\n") || "(empty)");
        break;
      }
      case "search": {
        const pattern = String(args.pattern ?? "");
        const re = new RegExp(pattern, "i");
        const globRe = args.glob ? new RegExp("^" + String(args.glob).replace(/\./g, "\\.").replace(/\*/g, ".*") + "$") : null;
        const results: string[] = [];
        const walk = (dir: string) => {
          if (results.length > 80) return;
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if ([".git", "node_modules", ".next", ".data"].includes(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) {
              if (globRe && !globRe.test(e.name)) continue;
              let text: string;
              try {
                if (fs.statSync(p).size > 512_000) continue;
                text = fs.readFileSync(p, "utf8");
              } catch {
                continue;
              }
              text.split("\n").forEach((line, i) => {
                if (results.length < 80 && re.test(line)) results.push(`${path.relative(root, p)}:${i + 1}: ${line.trim().slice(0, 200)}`);
              });
            }
          }
        };
        walk(root);
        output = results.length ? trunc(results.join("\n")) : "No matches.";
        break;
      }
      case "run_command": {
        const command = String(args.command ?? "").trim();
        if (!command) throw new Error("run_command needs a command to run.");
        const startRel = String(args.cwd ?? "").trim() || currentCwd(root, ctx.sessionId);
        const startAbs = path.resolve(root, resolveSafe(root, startRel));
        const cd = splitLeadingCd(root, command, startAbs);
        let cwdAbs = startAbs;
        let toRun = command;
        if (cd) {
          // A leading `cd` is real navigation, not a throwaway subshell: it
          // becomes where every later command in this conversation stands.
          cwdAbs = cd.abs;
          rememberCwd(ctx.sessionId, path.relative(root, cwdAbs) || ".");
          if (!cd.rest) {
            output = `(now in ${path.relative(root, cwdAbs) || "/"})`;
            break;
          }
          toRun = cd.rest;
        }
        const result = await runShell(root, toRun, Number(args.timeoutSec) || 0, cwdAbs);
        const where = path.relative(root, cwdAbs) || "/";
        output = trunc(`$ ${toRun}\n(in ${where})\n\n${result}`);
        break;
      }
      case "run_tests": {
        const detected = detectTestCommand(root);
        if (!detected) {
          output = "No test command detected: no package.json test script, no pytest/pyproject, no Cargo.toml and no go.mod in the workspace root. Ask the user which command runs the tests.";
          break;
        }
        const seconds = Number(args.timeoutSec) || 300;
        const result = await runShell(root, detected.command, seconds);
        output = trunc(`$ ${detected.command}\n(detected: ${detected.reason})\n\n${result}`);
        break;
      }
      default:
        return { callId, ok: false, output: `Unknown tool: ${name}` };
    }
    return { callId, ok: true, output };
  } catch (e) {
    return { callId, ok: false, output: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
