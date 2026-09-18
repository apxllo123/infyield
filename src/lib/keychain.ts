import { execFile } from "node:child_process";
import { getSettings } from "./settings";

/**
 * The macOS Keychain, for exactly one value: the Stripe secret key.
 *
 * Why: `settings.json` sits in `~/Library/Application Support/Infyield/data/`
 * with `0600` permissions, which protects it from other *users* — but the file
 * is still plaintext on disk. Any process running as this user (or anyone with
 * the disk) can read it. The Keychain adds a second perimeter: the value is
 * stored encrypted, is only decrypted for a process holding this keychain
 * access, and removing the file (or copying the data dir to another machine)
 * no longer captures the credential.
 *
 * Scratch/test discipline — this is the load-bearing gate of the whole module:
 * the Keychain belongs to the *user account*, not to a data directory. Two app
 * instances share it. The verification suites mark every server they spawn with
 * INFYIELD_IN_VERIFICATION=1 (see scripts/lib/scratch-app.mjs), so that marker
 * keeps every suite-instanced server off the real Keychain entirely (they keep
 * using the plaintext field, which is all their mock keys need). Only a real
 * install — Electron, dev server, plain `next start` — touches the Keychain,
 * and the first real key pasted into a real install migrates off disk.
 */

/**
 * The Keychain service name. Overridable by environment so the verification
 * probe can round-trip a sentinel under a test-only name without ever reading
 * or writing the entry a real key would live under.
 */
const SERVICE = process.env.INFYIELD_KEYCHAIN_SERVICE?.trim() || "Infyield Stripe secret key";
const ACCOUNT = "stripe.secret";

let supported: boolean | undefined;

/**
 * Whether this process should use the Keychain at all. Everything except a
 * verification-harness server: the suites set INFYIELD_IN_VERIFICATION=1.
 * The result is latched — the answer cannot change mid-process.
 */
function keychainSupported(): boolean {
  if (supported !== undefined) return supported;
  supported = process.env.INFYIELD_IN_VERIFICATION?.trim() !== "1";
  return supported;
}

function run(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      args,
      {
        timeout: 5000,
        encoding: "utf8",
        maxBuffer: 1024 * 256,
        ...(input === undefined ? {} : { input }),
      },
      (err: import("node:child_process").ExecFileException | null, stdout?: string, stderr?: string) => {
        // security writes errors to stderr and a non-zero code; node surfaces
        // both as the error object. Everything is reported, nothing thrown.
        const num = err && typeof err.code === "number" ? err.code : undefined;
        const code = err ? (num ?? 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

/** The stored key, or "" when absent — mirroring the plaintext field's shape. */
export async function keychainGet(): Promise<string> {
  if (!keychainSupported()) return "";
  const r = await run(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

export async function keychainSet(key: string): Promise<boolean> {
  if (!keychainSupported()) return false;
  // Upsert: update first (the common case — replacing a key), add on failure.
  const upd = await run(
    ["-U", "add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-l", "Infyield Stripe", "-w", key],
  );
  if (upd.code === 0) return true;
  const add = await run(["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-l", "Infyield Stripe", "-w", key]);
  return add.code === 0;
}

export async function keychainDelete(): Promise<boolean> {
  if (!keychainSupported()) return false;
  const r = await run(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
  return r.code === 0;
}

/**
 * Resolve the effective Stripe key for this install.
 *
 * Preference order:
 *   1. Keychain (real installs, once something is there) — the secure home.
 *   2. settings.json `payments.stripeSecretKey` — the legacy field. On a real
 *      install with a value present, it is migrated: written to the Keychain,
 *      erased from the file, and the file rewritten without the plaintext.
 *      Scratch instances (suite-run servers) keep reading the field as-is.
 *
 * `useKeychain` in the result tells the caller which store won, so the UI can
 * say truthfully where the key lives.
 */
export async function resolveStripeKey(): Promise<{ key: string; useKeychain: boolean }> {
  if (!keychainSupported()) {
    return { key: getSettings().payments?.stripeSecretKey ?? "", useKeychain: false };
  }
  const fromChain = await keychainGet();
  if (fromChain) return { key: fromChain, useKeychain: true };

  const legacy = getSettings().payments?.stripeSecretKey ?? "";
  if (legacy) {
    const ok = await keychainSet(legacy);
    if (ok) {
      // Erase the plaintext copy. savePaymentSettings owns the file shape; a
      // targeted rewrite here avoids a round-trip through its merge logic.
      const { saveSettings } = await import("./settings");
      const s = getSettings();
      if (s.payments) saveSettings({ ...s, payments: { ...s.payments, stripeSecretKey: "" } });
      return { key: legacy, useKeychain: true };
    }
    // Keychain refused (headless, unusual policy): fall back to disk rather
    // than losing the operator's key. Reported through useKeychain: false.
    return { key: legacy, useKeychain: false };
  }
  return { key: "", useKeychain: true };
}

export function keychainInUse(): boolean {
  return keychainSupported();
}

export const KEYCHAIN_SERVICE = SERVICE;
