import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getSettings, setWorkspaceRoot } from "@/lib/settings";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Noise that would swamp a project listing without telling you anything. */
const HIDDEN = new Set(["node_modules", ".git", ".next", ".next-release", ".data", ".DS_Store", "dist", "build", ".turbo", ".cache"]);
const MAX_ENTRIES = 240;

interface ElectronDialog {
  showOpenDialog: (
    window: unknown,
    options: Record<string, unknown>,
  ) => Promise<{ canceled?: boolean; filePaths?: string[] }>;
  showOpenDialogNoParent: (options: Record<string, unknown>) => Promise<{ canceled?: boolean; filePaths?: string[] }>;
  getAllWindows: () => unknown[];
}

/**
 * The Electron dialog API, when this server is the one embedded in the desktop
 * app: the packaged app requires this Next server from Electron's *main*
 * process, so `require("electron")` here resolves to the real module. In a
 * plain dev server it resolves to the npm package's path string instead —
 * detectable, and the reason the route degrades to a typed path rather than
 * pretending a dialog opened.
 */
function electronDialog(): ElectronDialog | null {
  try {
    const electron = require("electron") as unknown;
    if (!electron || typeof electron !== "object") return null;
    const mod = electron as {
      dialog?: { showOpenDialog?: unknown };
      BrowserWindow?: { getAllWindows?: unknown };
    };
    const dialog = mod.dialog;
    const windows = mod.BrowserWindow;
    if (
      dialog &&
      typeof dialog.showOpenDialog === "function" &&
      windows &&
      typeof windows.getAllWindows === "function"
    ) {
      return {
        getAllWindows: () => (windows.getAllWindows as () => unknown[])(),
        showOpenDialog: (window, options) =>
          (dialog.showOpenDialog as (w: unknown, o: Record<string, unknown>) => Promise<{ canceled?: boolean; filePaths?: string[] }>)(window, options),
        showOpenDialogNoParent: (options) =>
          (dialog.showOpenDialog as (o: Record<string, unknown>) => Promise<{ canceled?: boolean; filePaths?: string[] }>)(options),
      };
    }
  } catch {
    // Not running inside Electron — the typed-path fallback applies.
  }
  return null;
}

/**
 * The agent's workspace: a read-only listing of the real folder it can read and
 * edit (what Library and Home surface), plus the project-switcher state.
 *
 * POST changes the root. Two ways in:
 *   `{ action: "pick" }`      — opens the OS folder sheet, parented to the app's
 *                               window so it is always on top of it. Any folder
 *                               is directly selectable (Desktop included), the
 *                               confirm button reads "Select folder", and it can
 *                               be used as often as the operator likes.
 *   `{ action: "set", path }` — sets the root to a typed path (the plain-browser
 *                               fallback, where no native dialog exists).
 *
 * Both record the folder in `recentWorkspaces`, and neither can aim the agent
 * at an app bundle — the agent must never edit the app it runs inside.
 */
export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const s = getSettings();
  const root = s.workspaceRoot;

  try {
    if (!fs.statSync(root).isDirectory()) {
      return Response.json({ root, exists: false, entries: [], recentWorkspaces: s.recentWorkspaces ?? [], error: "The workspace root is not a folder." });
    }
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => !HIDDEN.has(d.name) && !d.name.startsWith("."))
      .slice(0, MAX_ENTRIES)
      .map((d) => {
        let sizeBytes = 0;
        let modifiedAt = 0;
        try {
          const st = fs.statSync(path.join(root, d.name));
          sizeBytes = st.size;
          modifiedAt = st.mtimeMs;
        } catch {
          /* unreadable entry: list it with unknown stats rather than failing */
        }
        const isDir = d.isDirectory();
        return {
          name: d.name,
          kind: isDir ? ("dir" as const) : ("file" as const),
          sizeBytes,
          modifiedAt,
          ext: isDir ? "" : path.extname(d.name).replace(/^\./, ""),
        };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);

    return Response.json({ root, exists: true, entries, recentWorkspaces: s.recentWorkspaces ?? [] });
  } catch {
    return Response.json({
      root,
      exists: false,
      entries: [],
      recentWorkspaces: s.recentWorkspaces ?? [],
      error: "That workspace folder doesn’t exist yet — choose a project folder.",
    });
  }
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  let body: { action?: string; path?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (body.action === "pick") {
    const dialog = electronDialog();
    if (!dialog) {
      // No Electron here (a plain dev server): the UI shows the typed-path
      // input, which is the honest degradation rather than a dead button.
      return Response.json({ ok: false, dialog: false, error: "The native folder picker needs the desktop app — type the folder path instead." });
    }
    // Parentless, NOT a window sheet: on this macOS, a sheet attached to the
    // window resolves `canceled` instantly and never renders. The plain panel
    // works, and the app is foreground by definition — the user just clicked
    // the button in it — so it presents above the window.
    const picked = await dialog.showOpenDialogNoParent({
      title: "Choose the project folder Infyield works in",
      buttonLabel: "Select folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: getSettings().workspaceRoot,
    });
    const chosen = picked.filePaths?.[0];
    if (picked.canceled || !chosen) return Response.json({ ok: false, dialog: true, canceled: true });
    const result = setWorkspaceRoot(chosen);
    return Response.json({ ...result, dialog: true });
  }

  if (body.action === "set") {
    const result = setWorkspaceRoot(String(body.path ?? ""));
    return Response.json(result);
  }

  return Response.json({ ok: false, error: "Unknown action — use `pick` or `set`." }, { status: 400 });
}
