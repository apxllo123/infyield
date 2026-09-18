import fs from "node:fs";
import os from "node:os";
import type { AppSettings, AdsSettings, PaymentsSettings } from "./types";
import { readJson, writeJson } from "./store";
import { bundleWorkspaceFallback, isAppBundle } from "./shell";

const FILE = "settings.json";

/**
 * Where the agent is allowed to read, edit and run commands.
 *
 * In a dev checkout that is simply the repo. Inside the packaged .app the
 * process cwd is the app's own bundle (`…/Infyield.app/Contents/Resources/app/server`),
 * and pointing the agent there is genuinely harmful — it would let the agent
 * edit the very app it is running in, and it makes Library show the bundle's
 * `server.js`/`package.json` instead of the user's project. Those installs get
 * a real folder in the home directory instead.
 */
function inBundle(p: string): boolean {
  return isAppBundle(p);
}

function defaultWorkspaceRoot(): string {
  const override = process.env.INFYIELD_WORKSPACE?.trim();
  if (override) return override;
  const cwd = process.cwd();
  if (!inBundle(cwd)) return cwd;
  const home = bundleWorkspaceFallback(os.homedir());
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch {
    // Fall back to the home directory itself rather than an unusable path.
    return os.homedir();
  }
  return home;
}

export const DEFAULT_ADS: AdsSettings = {
  network: "house",
  ethicalAdsPublisherId: "",
  carbonPlacementId: "",
  cpmUsd: 2,
  clickBonusUsd: 0.5,
  cadenceSteps: 3,
  maxAdsPerResponse: 3,
  enabled: true, // Freebuff mode: ads are always on and cannot be disabled
};

export const DEFAULT_PAYMENTS: PaymentsSettings = {
  provider: "none",
  linkUrl: "",
  stripeSecretKey: "",
  successUrl: "",
  cancelUrl: "",
  // Only ever set from the environment: pointing a live install at a mock
  // Stripe would let it record payments nobody made.
  stripeBaseUrl: process.env.INFYIELD_STRIPE_BASE_URL?.trim() || "",
};

export const DEFAULT_SETTINGS: AppSettings = {
  workspaceRoot: defaultWorkspaceRoot(),
  recentWorkspaces: [],
  apiPassword: "",
  adminPassword: "",
  ads: DEFAULT_ADS,
  payoutAccount: "",
  useNetworkAds: true,
  earnTargetUsd: 0,
  thinking: "medium",
  defaultSkills: [],
  commandTimeoutSec: 60,
  payments: DEFAULT_PAYMENTS,
};

let cache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (!cache) {
    const saved = readJson<Partial<AppSettings>>(FILE, {});
    cache = {
      ...DEFAULT_SETTINGS,
      ...saved,
      ads: { ...DEFAULT_ADS, ...(saved.ads ?? {}) },
      payments: { ...DEFAULT_PAYMENTS, ...(saved.payments ?? {}) },
    };
    // Migrate installs that already stored the bundle path as their workspace:
    // the agent must never be pointed at the app's own files.
    if (inBundle(cache.workspaceRoot)) {
      cache = { ...cache, workspaceRoot: defaultWorkspaceRoot() };
      writeJson(FILE, cache);
    }
  }
  return cache;
}

export function saveSettings(next: AppSettings): void {
  cache = next;
  writeJson(FILE, next);
}

const MAX_RECENT_WORKSPACES = 6;

/**
 * Point the agent at a folder, recording it in the switcher's history.
 *
 * The one rule worth restating: the app's own bundle is not a project. A path
 * into `Something.app/Contents` is refused here the same way a stored one is
 * migrated on read — the agent must never be handed its own files to edit.
 */
export function setWorkspaceRoot(dir: string): { ok: boolean; root?: string; error?: string } {
  const root = dir.trim();
  if (!root) return { ok: false, error: "Choose a folder first." };
  if (inBundle(root)) return { ok: false, error: "That folder is inside an app bundle — pick your actual project folder." };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return { ok: false, error: "That folder does not exist." };
  }
  if (!stat.isDirectory()) return { ok: false, error: "That path is a file, not a folder." };

  const s = getSettings();
  const recents = [root, ...(s.recentWorkspaces ?? []).filter((p) => p !== root)].slice(0, MAX_RECENT_WORKSPACES);
  saveSettings({ ...s, workspaceRoot: root, recentWorkspaces: recents });
  return { ok: true, root };
}
