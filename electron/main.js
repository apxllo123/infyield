// Infyield desktop shell.
//
// Two hard rules, both learned the hard way:
//  1. The Next server runs IN-PROCESS (`require`d, never spawned). A spawned
//     server becomes a launchd-registered child that macOS draws as its own
//     bouncing, generic Dock tile ("exec") and can outlive the app.
//  2. The window is created immediately and shows a splash, then navigates to
//     the server once it answers. Booting the server before creating the window
//     makes macOS show the app as unresponsive (the bouncing launch tile).
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");

const PREFERRED_PORT = 3777;
let activePort = PREFERRED_PORT;
let win = null;
let serverReady = false;

// Deterministic app name so userData resolves to Application Support/Infyield.
app.setName("Infyield");
process.title = "Infyield";

// Next's standalone server sets process.title to "next-server (vX)" when it
// boots. On macOS the process title is what LaunchServices/Dock report for the
// app, so without restoring it the app shows up mislabelled instead of as
// "Infyield". Re-assert the name after the server starts.
function restoreAppName() {
  process.title = "Infyield";
  app.setName("Infyield");
}

// Runtime data (keys, ledger, campaigns, settings) lives in Application
// Support so the .app bundle stays read-only.
const DATA_DIR = path.join(app.getPath("userData"), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  const legacyDir = path.join(path.dirname(app.getPath("userData")), "agentfuel", "data");
  if (fs.existsSync(legacyDir) && fs.readdirSync(DATA_DIR).length === 0) {
    fs.cpSync(legacyDir, DATA_DIR, { recursive: true });
  }
} catch {}

const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0c0c0e;color:#e7e7ea;
    font:14px/1.5 ui-sans-serif,-apple-system,sans-serif;
    display:flex;align-items:center;justify-content:center;
    -webkit-user-select:none;user-select:none}
  .box{text-align:center}
  .brand{font-size:22px;font-weight:600;letter-spacing:-.02em}
  .sub{margin-top:8px;color:#8b8b93}
  .bar{margin:18px auto 0;width:180px;height:3px;border-radius:99px;background:#232327;overflow:hidden}
  .bar i{display:block;height:100%;width:40%;border-radius:99px;background:#5eead4;
    animation:s 1.1s ease-in-out infinite}
  @keyframes s{0%{transform:translateX(-110%)}100%{transform:translateX(310%)}}
</style></head><body><div class="box">
  <div class="brand">Infyield</div>
  <div class="sub">Starting local engine…</div>
  <div class="bar"><i></i></div>
</div></body></html>`)}`;

function isPortFree(port) {
  const tryBind = (host) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, host);
    });
  // Both IP stacks: a server bound to `::` coexists with ours on 127.0.0.1 on
  // the same port number, and macOS resolves `localhost` to ::1 first — which
  // silently hands the app's own tab to whatever else is listening.
  return (async () => (await tryBind("127.0.0.1")) && (await tryBind("::1")))();
}

async function pickPort() {
  for (let p = PREFERRED_PORT; p < PREFERRED_PORT + 12; p++) {
    if (await isPortFree(p)) return p;
  }
  return PREFERRED_PORT;
}

/** Boot the bundled standalone Next server inside this process. */
async function startServer() {
  const serverPath = path.join(__dirname, "..", "server", "server.js");
  activePort = await pickPort();
  process.env.PORT = String(activePort);
  process.env.HOSTNAME = "127.0.0.1";
  process.env.NODE_ENV = "production";
  process.env.INFYIELD_DATA_DIR = DATA_DIR;
  try {
    require(serverPath); // listens on process.env.PORT, in-process
    restoreAppName();
  } catch (err) {
    process.stderr.write(`[infyield] server failed to start in-process: ${err}\n`);
    throw err;
  }
}

function baseUrl() {
  return `http://127.0.0.1:${activePort}`;
}

/**
 * Whether a URL is this app's own origin.
 *
 * Compared as a parsed origin, not as a string prefix: `startsWith(baseUrl())`
 * accepted `http://127.0.0.1:3777@evil.example/`, whose *host* is `evil.example`
 * and whose userinfo merely looks like ours — so it would have been loaded into
 * the app window instead of being handed to the browser.
 */
function isAppUrl(url) {
  try {
    return new URL(url).origin === baseUrl();
  } catch {
    return false;
  }
}

/**
 * Hand a URL to the OS, but only if it is a web page.
 *
 * `shell.openExternal` gives the string to whatever handler claims it, and these
 * URLs come from ad creatives the deployment did not author. `file:`, `javascript:`
 * and custom schemes must never reach the shell, so anything that is not http(s)
 * is dropped rather than opened.
 */
function openExternally(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  shell.openExternal(url);
}

function waitForServer(retries = 120) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get(`${baseUrl()}/api/bootstrap`, (res) => {
        res.resume();
        serverReady = true;
        resolve();
      });
      req.on("error", () => {
        if (n <= 0) reject(new Error("server did not answer"));
        else setTimeout(() => attempt(n - 1), 250);
      });
    };
    attempt(retries);
  });
}

function showBootError(message) {
  if (!win) return;
  const safe = String(message).replace(/[<>&]/g, "");
  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><body style="margin:0;height:100%;background:#0c0c0e;color:#eee;font:14px/1.6 ui-sans-serif,-apple-system,sans-serif;padding:48px">
<h2 style="margin:0 0 10px">Infyield could not start</h2>
<p style="color:#a1a1aa;max-width:560px">${safe}</p>
<p style="color:#71717a">Quit and relaunch the app. If this persists, reinstall it to ~/Applications.</p>
</body></html>`)}`,
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0c0c0e",
    title: "Infyield",
    show: true,
    titleBarStyle: "hiddenInset",
    // Vertically centred in the 46px title-bar band that --nav-top reserves
    // (globals.css). The three buttons span roughly x 18–72, y 17–29.
    // `sandbox` and no `nodeIntegration` keep the renderer unable to reach Node
    // even if a served page were to execute something it should not. The
    // folder picker needs no bridge: the server asks the main process for the
    // native dialog directly (see /api/workspace `pick`).
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Ad links and the OpenRouter connect flow open in the real browser; only our
    // own origin is allowed into this window.
    if (isAppUrl(url)) return { action: "allow" };
    openExternally(url);
    return { action: "deny" };
  });

  // A renderer-initiated navigation to somewhere else would replace the app with
  // a web page inside a window that trusts this origin. Send it to the browser
  // instead, so the app is never showing anything but itself.
  win.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });

  win.loadURL(SPLASH);
}

const template = [
  { label: app.name, submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
    ],
  },
  { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }] },
];

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Another instance owns the app: leave immediately, before any window or
  // server exists, so no second Dock tile or stray server can appear.
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    // Window first (instant, responsive), then the engine.
    createWindow();
    startServer()
      .then(() => waitForServer())
      .then(() => {
        restoreAppName(); // the server may have retitled us while listening
        if (win && !win.isDestroyed()) win.loadURL(baseUrl());
      })
      .catch((err) => {
        showBootError(
          `The embedded server did not start: ${err && err.message ? err.message : err}. ` +
            "A local port may be blocked.",
        );
      });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        if (serverReady) win.loadURL(baseUrl());
      }
    });
  });

  // In-process server dies with the app — nothing to clean up, no orphans.
  app.on("window-all-closed", () => app.quit());
}
