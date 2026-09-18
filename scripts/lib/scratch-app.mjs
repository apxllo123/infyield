/**
 * Isolation for the verification suites.
 *
 * The suites under scripts/ are destructive on purpose: they inflate a
 * campaign's CPM, serve impressions and clicks, mint real invoices, record
 * payouts, register probe keys and models, and repoint the workspace root. That
 * is exactly what makes them worth running — they exercise the real HTTP
 * surface, not a mock of it — but it also means the instance they run against
 * must never be one somebody is using.
 *
 * They used to default to http://127.0.0.1:3777, which is the port the desktop
 * app serves on. So the documented one-liner silently ran all of that against
 * whatever app happened to be listening, and the restore block only covered the
 * happy path: a hang, a timeout or a Ctrl-C left the inflated rates, the
 * deactivated campaigns and a fake invoice behind on a real ledger.
 *
 * The rule here is that the safe thing is the default and the destructive thing
 * has to be asked for by name. Without INFYIELD_ALLOW_LIVE=1 a suite boots its
 * own packaged server on its own port with its own scratch data dir, and deletes
 * both afterwards. With it, the caller has said out loud that they mean an
 * existing instance — and the suite prints that back so a log makes it obvious.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * A suite must never start nested inside a verification instance.
 *
 * Scratch servers inherit INFYIELD_IN_VERIFICATION (set on the spawn env below),
 * and so does everything their agent turns execute — including `run_tests`,
 * which detects the workspace's own test command. Point that workspace at this
 * checkout and the detected command is `npm test`: the suite chain itself. One
 * section-E turn then re-entered the suites, whose section-E turns re-entered
 * the suites, and the machine filled with a new `npm test` every few seconds
 * until the tree was killed by hand. A nested start now refuses immediately,
 * and the refusal text is what the agent turn reports — the tool still ran,
 * still captured an exit status, and proved its point without recursing.
 */
if (process.env.INFYIELD_IN_VERIFICATION === "1") {
  console.error(
    "Refusing to run: a verification suite is starting inside another verification instance " +
      "(INFYIELD_IN_VERIFICATION=1). run_tests in a scratch server must not re-enter the suites.",
  );
  process.exit(1);
}

const DEFAULT_SERVER = "release/Infyield-darwin-arm64/Infyield.app/Contents/Resources/app/server/server.js";

/**
 * A port nothing else is listening on.
 *
 * Fixed ports were a real hazard, and it bit: the suite's scratch instance asked
 * for 3778, the desktop app was already bound there (it picks its own port when
 * 3777 is taken), and the boot probe got a perfectly healthy 200 — from the
 * *stranger*. `start()` returned success, and every destructive thing section A
 * does (inflate a CPM, serve impressions, mint invoices, mark them paid) ran
 * against that instance instead. On this machine that instance was the
 * operator's live install.
 *
 * Asking the OS for an unused port is the only way to know the port is ours to
 * take, so isolation no longer depends on nobody else wanting 3778.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Is something already listening here? Used to refuse a port we do not own. */
export function portTaken(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err) => resolve(err.code === "EADDRINUSE"));
    srv.listen(Number(port), "127.0.0.1", () => srv.close(() => resolve(false)));
  });
}

export function waitForExit(child, graceMs = 3000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Work out what to run against.
 *
 * A scratch run never shares a port with anything: if the requested port is
 * already bound, the suite takes a free one instead of talking to whatever is
 * there. An explicit INFYIELD_PORT is still refused rather than silently
 * swapped, because a caller who named a port wants to know it was busy.
 *
 * @param {number} defaultPort port to prefer for the scratch instance
 * @param {object} [env] environment (injectable for testing)
 */
export async function resolveTarget(defaultPort, env = process.env) {
  const live = env.INFYIELD_ALLOW_LIVE === "1";
  const explicit = (env.INFYIELD_BASE || "").trim().replace(/\/+$/, "");
  const requested = Number(env.INFYIELD_PORT || defaultPort);
  const serverPath = env.INFYIELD_SERVER || path.join(process.cwd(), DEFAULT_SERVER);

  if (live) {
    const port = requested;
    return { live, explicit, base: explicit || `http://127.0.0.1:${port}`, port, serverPath };
  }

  // Own instance: never inherit a port somebody else is holding.
  let port = requested;
  if (await portTaken(port)) {
    if (env.INFYIELD_PORT) {
      throw new Error(
        `INFYIELD_PORT=${env.INFYIELD_PORT} is already in use. Refusing to run: that port belongs to another process (probably an app you care about).`,
      );
    }
    port = await freePort();
  }
  return { live, explicit, base: `http://127.0.0.1:${port}`, port, serverPath };
}

/**
 * A packaged app on a scratch data dir, torn down on stop().
 *
 * Everything a suite mutates — ledger, campaigns, invoices, payouts, keys,
 * custom models, settings, uploads, workspace — lands in the temp data dir, so a
 * crash cannot leave anything behind on a real install.
 */
export function createScratchApp({ base, port, serverPath, prefix = "infyield-verify-", env = {} }) {
  let child = null;
  let dataDir = null;

  async function start() {
    if (!fs.existsSync(serverPath)) {
      throw new Error(`No packaged server at ${serverPath}\nBuild it first: ./scripts/build-app.sh`);
    }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const log = fs.createWriteStream(path.join(dataDir, "server.log"));
    child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        INFYIELD_DATA_DIR: dataDir,
        // Marks every process this server spawns, so a suite (or anything else
        // that should not nest) can refuse when it finds itself inside one.
        INFYIELD_IN_VERIFICATION: "1",
        // Per-instance overrides, applied last so a suite can point one
        // instance at a mock provider or set its own funding policy. A suite
        // that aims the inference base URL at a mock also gets `mode: simulated`
        // reported by the server itself, which is what keeps a mocked figure
        // from being presented as production.
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    for (let i = 0; i < 80; i++) {
      // The child dying is the one outcome a probe cannot detect: if it failed to
      // bind (EADDRINUSE) the probe still gets a cheerful 200 from whatever else
      // is on that port, and the suite would then run against a stranger. So
      // check the child itself before believing any HTTP response.
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`${base}/api/bootstrap`);
        if (res.ok) {
          if (child.exitCode !== null) break;
          return;
        }
      } catch {
        /* not up yet */
      }
    }
    throw new Error(
      `scratch app never came up on ${base}; see ${dataDir}/server.log` +
        (child.exitCode !== null ? ` (the server exited with code ${child.exitCode} — was ${base} already taken?)` : ""),
    );
  }

  async function stop() {
    if (child) {
      child.kill("SIGTERM");
      await waitForExit(child);
      child = null;
    }
    if (dataDir) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
      } catch (err) {
        // A directory the OS is still flushing is not worth failing a suite over,
        // but it should not vanish silently either.
        console.log(`  · scratch dir left behind at ${dataDir} (${err?.code ?? err})`);
      }
      dataDir = null;
    }
  }

  return { start, stop, get dataDir() { return dataDir; } };
}

/** The banner every suite prints, so a log says which mode it ran in. */
export function announceTarget(label, target) {
  console.log(`${label} against ${target.base}\n`);
  if (target.live) {
    console.log("  ! LIVE MODE (INFYIELD_ALLOW_LIVE=1) — this run writes to the instance above.");
    console.log("  ! It invoices campaigns, serves impressions, records payouts and changes settings.\n");
  } else {
    console.log(`  · own instance: port ${target.port}, scratch data dir, deleted on exit\n`);
  }
}
