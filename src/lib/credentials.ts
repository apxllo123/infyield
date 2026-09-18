import fs from "node:fs";
import path from "node:path";
import type { ProviderKind } from "./types";
import { dataDir } from "./store";

/**
 * Infyield's own provider credentials.
 *
 * The product's economic model is that the person using the agent is a *guest*:
 * Infyield provides the AI, Infyield pays the provider, and text ads shown
 * between agent turns fund that bill. That only holds if the credential is
 * Infyield's. So credentials live here — server-side, read from the process
 * environment — and the client never supplies, sees, or holds one.
 *
 * What this module deliberately does NOT do:
 *
 *  - It never reads a credential from a request. There is no code path from an
 *    HTTP body to a provider key. A caller can ask for a *model*; it cannot
 *    supply the thing that pays for it.
 *  - It never returns the key to anything that renders. `providerStatus()` is
 *    what the UI and the health endpoint are given, and it reports whether a
 *    credential exists and where it came from — never its value, never a
 *    prefix or a masked tail either, since even a masked tail is derived from
 *    the secret.
 *  - It never puts a key in an error string. Upstream errors are passed through
 *    `scrubSecrets()` before they can reach a log or a user, because provider
 *    SDK error messages sometimes echo the Authorization header back.
 *
 * Missing credentials fail closed: `requireCredential()` throws a
 * `ProviderNotConfiguredError`, the chat route turns it into "AI provider is
 * not configured.", and no model call is attempted. A missing key must never
 * become a fake successful response.
 */

/**
 * Where each provider's credential is expected, in priority order.
 *
 * `OPENROUTER_API_KEY` is the one that matters: a single OpenRouter credential
 * serves the entire catalog (including every direct-provider model, since
 * OpenRouter routes to them), which is what lets the free tier and the
 * everyday tier be one configuration value.
 */
const ENV_VARS: Record<ProviderKind, string[]> = {
  openrouter: ["OPENROUTER_API_KEY", "INFYIELD_OPENROUTER_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_API_KEY"],
  // A custom endpoint is never credentialled from the environment: its key
  // would have to live somewhere arbitrary. Custom models must point at a
  // provider whose credential Infyield already owns.
  custom: [],
};

export const PROVIDER_NOT_CONFIGURED = "AI provider is not configured.";

export class ProviderNotConfiguredError extends Error {
  readonly code = "provider-not-configured";
  constructor(
    message: string,
    /** The exact variables an operator must set, so the error is actionable. */
    readonly envVars: string[],
  ) {
    super(message);
    this.name = "ProviderNotConfiguredError";
  }
}

/**
 * Optional file-based provisioning, for the packaged app.
 *
 * A double-clicked `.app` does not inherit a shell profile, so a desktop
 * install has no way to receive `OPENROUTER_API_KEY` from the environment. Two
 * server-side files fill that gap, and both are read on the server only:
 * `.env.local` next to the running server's cwd (which is also what `next dev`
 * loads), and `provider.env` inside the app's own data directory.
 *
 * Only the two variables this module cares about are read; the files are never
 * parsed for anything else and their contents are never returned.
 */
function envFileCandidates(): string[] {
  const out: string[] = [];
  const explicit = (process.env.INFYIELD_ENV_FILE ?? "").trim();
  if (explicit) out.push(explicit);
  out.push(path.join(process.cwd(), ".env.local"));
  try {
    out.push(path.join(dataDir(), "provider.env"));
  } catch {
    // A data dir we cannot address is not a reason to fail: env vars still work.
  }
  return out;
}

interface FileCache {
  at: number;
  vars: Record<string, string>;
}

let fileCache: FileCache | null = null;
const FILE_TTL_MS = 5000;

/**
 * Read the provisioning files, cached briefly.
 *
 * Cached because this sits on the request path of every model call, and
 * re-reading two files per turn to find a value that changes approximately
 * never is waste. The TTL is short so that placing a credential and retrying
 * works without restarting the app.
 */
function fileVars(): Record<string, string> {
  if (fileCache && Date.now() - fileCache.at < FILE_TTL_MS) return fileCache.vars;
  const vars: Record<string, string> = {};
  for (const candidate of envFileCandidates()) {
    let text = "";
    try {
      if (!fs.existsSync(candidate)) continue;
      text = fs.readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const name = line.slice(0, eq).trim().replace(/^export\s+/, "");
      let value = line.slice(eq + 1).trim();
      // Tolerate the quoting people actually write in .env files.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!name || !value) continue;
      // First file wins, and process.env still wins over all of them.
      vars[name] ??= value;
      // Record which file supplied it, for status reporting only.
      vars[`__source__${name}`] ??= path.basename(candidate);
    }
  }
  fileCache = { at: Date.now(), vars };
  return vars;
}

/** Test seam: forget cached file values so a suite can change them mid-run. */
export function resetCredentialCache(): void {
  fileCache = null;
}

export interface Credential {
  provider: ProviderKind;
  key: string;
  /** Where it came from, for status reporting. Never the value itself. */
  source: "environment" | "env-file";
}

/** The file `provisionCredential` writes, and `serverCredential` reads. */
export function credentialFilePath(): string {
  return path.join(dataDir(), "provider.env");
}

export interface ProvisionResult {
  ok: boolean;
  /** The variable written, so the caller can say exactly what it set. */
  envVar: string;
  file: string;
  error?: string;
}

/**
 * Provision the deployment's credential from inside the app.
 *
 * A double-clicked `.app` inherits no shell profile, so "export an environment
 * variable" is not something the person running it can do. This is the supported
 * way in: the credential is written to `provider.env` in the app's own data
 * directory — server-side, `chmod 600` — which is the same file
 * `serverCredential()` reads. Nothing is returned to a client except whether it
 * worked, and no code path lets a *request* nominate the value: the only caller
 * is the OpenRouter connect flow, where the operator authorises their own
 * account and OpenRouter issues the token.
 *
 * The file is merged rather than overwritten so that provisioning one provider
 * cannot silently drop another's credential.
 */
export function provisionCredential(provider: ProviderKind, value: string): ProvisionResult {
  const varName = (ENV_VARS[provider] ?? [])[0];
  const file = credentialFilePath();
  const key = (value ?? "").trim();
  if (!varName) return { ok: false, envVar: "", file, error: `Infyield cannot store a credential for ${provider}.` };
  if (!key) return { ok: false, envVar: varName, file, error: "The credential was empty." };

  let lines: string[] = [];
  try {
    if (fs.existsSync(file)) lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
  } catch (err) {
    return { ok: false, envVar: varName, file, error: `Could not read ${path.basename(file)}: ${(err as Error).message}` };
  }

  const kept = lines.filter((line) => {
    const name = line.slice(0, Math.max(0, line.indexOf("="))).trim().replace(/^export\s+/, "");
    return name !== varName;
  });
  kept.push(`${varName}=${key}`);

  try {
    fs.writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
    // The mode option only applies when the file is created, so an existing file
    // with looser permissions has to be tightened explicitly.
    fs.chmodSync(file, 0o600);
  } catch (err) {
    return { ok: false, envVar: varName, file, error: `Could not write ${path.basename(file)}: ${(err as Error).message}` };
  }

  // Forget the cache so the next model call sees the new value without a restart.
  fileCache = null;
  return { ok: true, envVar: varName, file };
}

/** Remove a provisioned credential, so "disconnect" actually disconnects. */
export function revokeCredential(provider: ProviderKind): ProvisionResult {
  const varName = (ENV_VARS[provider] ?? [])[0];
  const file = credentialFilePath();
  if (!varName) return { ok: false, envVar: "", file, error: `Infyield cannot hold a credential for ${provider}.` };
  try {
    if (!fs.existsSync(file)) return { ok: true, envVar: varName, file };
    const kept = fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => {
        const name = line.slice(0, Math.max(0, line.indexOf("="))).trim().replace(/^export\s+/, "");
        return line.trim() && name !== varName;
      });
    fs.writeFileSync(file, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (err) {
    return { ok: false, envVar: varName, file, error: `Could not update ${path.basename(file)}: ${(err as Error).message}` };
  }
  fileCache = null;
  return { ok: true, envVar: varName, file };
}

/**
 * The credential for one provider, or null.
 *
 * `process.env` is checked first and always wins: an operator who exports a
 * variable means it, and a stale file must not shadow it.
 */
export function serverCredential(provider: ProviderKind): Credential | null {
  const names = ENV_VARS[provider] ?? [];
  if (!names.length) return null;
  for (const name of names) {
    const fromEnv = (process.env[name] ?? "").trim();
    if (fromEnv) return { provider, key: fromEnv, source: "environment" };
  }
  const file = fileVars();
  for (const name of names) {
    const value = (file[name] ?? "").trim();
    if (value) return { provider, key: value, source: "env-file" };
  }
  return null;
}

/** The same thing, but a missing credential is an error rather than a null. */
export function requireCredential(provider: ProviderKind): Credential {
  const cred = serverCredential(provider);
  if (cred) return cred;
  const names = ENV_VARS[provider] ?? [];
  throw new ProviderNotConfiguredError(
    names.length
      ? `${PROVIDER_NOT_CONFIGURED} Infyield needs its own ${provider} credential: set ${names.join(" or ")} in the server environment.`
      : `${PROVIDER_NOT_CONFIGURED} Infyield has no credential for a custom endpoint.`,
    names,
  );
}

export interface ProviderStatus {
  provider: ProviderKind;
  configured: boolean;
  /** Where the credential came from. Never the credential. */
  source: Credential["source"] | null;
  /** Variables that would satisfy this provider, for an actionable message. */
  envVars: string[];
}

export function providerStatus(provider: ProviderKind): ProviderStatus {
  const cred = serverCredential(provider);
  return {
    provider,
    configured: !!cred,
    source: cred?.source ?? null,
    envVars: ENV_VARS[provider] ?? [],
  };
}

/**
 * Every provider Infyield can serve from, and whether it has a credential.
 *
 * This is the shape the health endpoint and the Connections page render. It is
 * safe by construction: `ProviderStatus` has no field that can hold a secret.
 */
export function allProviderStatus(): ProviderStatus[] {
  return (Object.keys(ENV_VARS) as ProviderKind[]).map(providerStatus);
}

/** True when at least one provider credential exists, i.e. the agent can run. */
export function providerConfigured(): boolean {
  return allProviderStatus().some((s) => s.configured);
}

/**
 * Whether Infyield — not the caller — is paying for the model calls.
 *
 * This is the question the reserve-tier gate hangs on, and in a server-credential
 * build the answer is simply "yes, when a credential exists". It is a function
 * rather than a constant so the gate and the health surface cannot drift apart.
 */
export function usingServerCredential(): boolean {
  return providerConfigured();
}

/**
 * Remove anything credential-shaped from arbitrary text.
 *
 * Provider SDKs and proxies sometimes quote the request (including the
 * Authorization header) back inside an error message, and those messages end up
 * in toasts, SSE error events and server logs. Redacting by shape rather than by
 * comparing against known secrets means a *newly* configured credential is
 * covered too, without this module having to be told about it.
 */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  // Known secrets, longest first so a short key cannot partially survive.
  const known = (Object.keys(ENV_VARS) as ProviderKind[])
    .flatMap((p) => ENV_VARS[p].map((name) => (process.env[name] ?? "").trim()))
    .filter((v) => v.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const secret of known) out = out.split(secret).join("[redacted]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/gi, "Bearer [redacted]");
  // OpenRouter keys are `sk-or-v1-…`; OpenAI `sk-…`; Anthropic `sk-ant-…`.
  out = out.replace(/\b(sk-[A-Za-z0-9._\-]{6,})/g, "[redacted]");
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]");
  return out;
}
