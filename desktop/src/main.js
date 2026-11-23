// UIC Dialer for Windows. A thin, locked-down window around the hosted dashboard (so dashboard updates need no
// reinstall) that adds what a browser can't do cleanly:
//  1. tel: links go to Windows, where Phone Link dials on the rep's paired Android phone and carries the audio
//     over Bluetooth. The phone's own dialer places the call, so its recorder and our upload keep working.
//  2. Google sign-in runs in the system browser (Google blocks sign-in inside embedded windows). The server sends
//     a one-time code back through the uicdialer:// link, which only this app can redeem (S256 verifier).
//  3. It stays up: reloads by itself when the server restarts or the network drops, and lives in the tray.
// The link and sign-in rules are in rules.js, tested by test/rules.test.js.
"use strict";

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, powerSaveBlocker, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const rules = require("./rules.js");

const APP_URL = rules.resolveAppUrl(process.env.UIC_URL);
// Logo for the window and tray; the .exe and installer get build/icon.ico from electron-builder.
const APP_ICON = path.join(__dirname, "..", "build", "icon.png");
const SCHEME = rules.SCHEME;
const APP_ID = "com.usaindiacfo.uicdialer";
/** Started by "Start with Windows": come up in the tray without a window. */
const startHidden = process.argv.includes("--hidden");

let win = null;
let tray = null;
let quitting = false;
/** Browser sign-ins started from this app and not yet finished (see rules.addFlow). */
let flows = [];
/** Failed page loads in a row; sets the retry wait, reset by a good load. */
let failures = 0;
let retryTimer = null;

// Startup timing: ms since launch for each step, one line per launch in logs/startup.log (last 50 kept).
const launchedAt = Date.now();
const marks = {};
let timingWritten = false;
function mark(name) {
  if (!(name in marks)) marks[name] = Date.now() - launchedAt;
}
function writeStartupTiming() {
  if (timingWritten) return;
  timingWritten = true;
  try {
    const file = path.join(app.getPath("logs"), "startup.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = `${new Date().toISOString()} v${app.getVersion()}${startHidden ? " hidden" : ""} ${Object.entries(marks).map(([k, v]) => `${k}=${v}ms`).join(" ")}`;
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    fs.writeFileSync(file, [...old.slice(-49), line].join("\n") + "\n");
  } catch {
    /* timing is best-effort */
  }
}

// ---- small helpers ------------------------------------------------------

/** One line per event in %APPDATA%/UIC Dialer/logs/shell.log. Never codes or tokens. */
function log(what) {
  try {
    const dir = app.getPath("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "shell.log"), `${new Date().toISOString()} v${app.getVersion()} ${what}\n`);
  } catch {
    /* a log that can't be written never stops the app */
  }
}

const windowStateFile = () => path.join(app.getPath("userData"), "window.json");

function loadWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"));
    return rules.validWindowState(saved, screen.getAllDisplays().map((d) => d.workArea));
  } catch {
    return null;
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const maximised = win.isMaximized();
    const b = maximised ? win.getNormalBounds() : win.getBounds();
    fs.mkdirSync(path.dirname(windowStateFile()), { recursive: true });
    fs.writeFileSync(windowStateFile(), JSON.stringify({ ...b, maximised }));
  } catch {
    /* next time it opens at the default size */
  }
}

// ---- links and sign-in --------------------------------------------------

function startSignIn() {
  const flow = rules.newFlow();
  flows = rules.addFlow(flows, flow);
  const url = new URL("/auth/google", APP_URL);
  url.searchParams.set("desktop", flow.challenge);
  log("sign-in started");
  void shell.openExternal(url.href);
}

function finishSignIn(link) {
  const match = rules.matchCallback(link, flows);
  if (match.ignored) {
    log(`sign-in callback ignored: ${match.ignored}`);
    return;
  }
  // The server's code is single-use: forget the flow before redeeming it.
  flows = flows.filter((f) => f !== match.flow);
  const exchange = new URL("/auth/desktop/exchange", APP_URL);
  exchange.searchParams.set("code", match.code);
  exchange.searchParams.set("verifier", match.flow.verifier);
  log("sign-in callback received");
  showWindow();
  // A pending reload would abort the exchange after the server has used up the single-use code.
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  // Loaded in the window so the session cookie lands in the window's own cookie jar. The server redirects to
  // "/" on success or "/?error=…", which the sign-in page explains.
  // The header proves the request comes from this app; the server refuses the exchange without it.
  void win.loadURL(exchange.href, { extraHeaders: "X-UIC-Desktop: 1\n" });
}

/** Acts on a link from the page. Returns true when the window may follow it itself. */
function route(url) {
  switch (rules.routeFor(url, APP_URL)) {
    case "window":
      return true;
    case "tel":
      void shell.openExternal(`tel:${rules.telNumber(url)}`);
      return false;
    case "signin":
      startSignIn();
      return false;
    case "external":
      void shell.openExternal(url);
      return false;
    default:
      return false;
  }
}

// ---- staying up ---------------------------------------------------------

/** Tries the page again after a growing wait (the server may be restarting during a deploy). */
function scheduleRetry(reason, url) {
  if (!win || quitting || retryTimer) return;
  const wait = rules.retryDelayMs(failures);
  failures += 1;
  log(`load problem: ${reason}; retrying in ${wait / 1000}s`);
  const target = rules.sameOrigin(url, APP_URL) && !url.includes("/auth/") ? url : APP_URL.href;
  // A friendly "can't reach" page with a countdown and Retry now, instead of Chromium's error or a blank page.
  void win
    .loadFile(path.join(__dirname, "offline.html"), { query: { reason, wait: String(wait), target } })
    .then(() => {
      // A failed first load never paints, so "ready-to-show" never fires: show the offline page instead.
      if (!startHidden && win && !win.isDestroyed() && !win.isVisible()) {
        win.show();
        mark("shown");
      }
    })
    .catch(() => {});
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!win || win.isDestroyed()) return;
    // Back to the page that failed when it's ours, so the rep lands where they were.
    void win.loadURL(target);
  }, wait);
}

// ---- window -------------------------------------------------------------

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    width: state?.width ?? 1200,
    height: state?.height ?? 820,
    x: state?.x,
    y: state?.y,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: "UIC Dialer",
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      // Lives in the tray: keep timers (follow-up reminders, live updates) running at full speed while hidden.
      backgroundThrottling: false,
    },
  });
  mark("window");
  if (state?.maximised) win.maximize();
  // Taskbar icon and pinned shortcut under our name and logo (otherwise Windows shows electron.exe's icon).
  if (process.platform === "win32") {
    win.setAppDetails({ appId: APP_ID, // Installed: the .exe carries icon.ico (Windows can't read icons inside app.asar).
      appIconPath: app.isPackaged ? process.execPath : path.join(__dirname, "..", "build", "icon.ico"), appIconIndex: 0, relaunchDisplayName: "UIC Dialer" });
  }
  const wc = win.webContents;

  // Drop the Electron token (no need to advertise it) but keep ours: the dashboard looks for "UICDialer/"
  // to open calls through this app.
  wc.setUserAgent(`${wc.getUserAgent().replace(` Electron/${process.versions.electron}`, "").replace(` ${app.getName()}/${app.getVersion()}`, "")} UICDialer/${app.getVersion()}`);

  // Show once painted, so there's no white flash; "Start with Windows" keeps it in the tray.
  win.once("ready-to-show", () => {
    mark("painted");
    if (!startHidden) {
      win?.show();
      mark("shown");
    }
  });
  wc.once("did-finish-load", () => {
    mark("loaded");
    writeStartupTiming();
  });

  // Ctrl + / Ctrl - / Ctrl 0 zoom, including the "=" key and the numpad (the default binding needs Shift).
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return;
    const step = input.code === "Equal" || input.code === "NumpadAdd" ? 0.5 : input.code === "Minus" || input.code === "NumpadSubtract" ? -0.5 : null;
    if (step !== null) wc.setZoomLevel(wc.getZoomLevel() + step);
    else if (input.code === "Digit0" || input.code === "Numpad0") wc.setZoomLevel(0);
    else if (input.key === "F5" || (input.code === "KeyR" && !input.shift)) wc.reload();
    else return;
    event.preventDefault();
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (route(url)) void win.loadURL(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (!route(url)) return e.preventDefault();
    // "Retry now" on the offline page: this load replaces the scheduled one.
    if (retryTimer && wc.getURL().startsWith("file:")) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  });
  // A server redirect elsewhere fires will-redirect, not will-navigate.
  wc.on("will-redirect", (e, url) => {
    if (rules.sameOrigin(url, APP_URL)) return;
    e.preventDefault();
    if (/^https:/i.test(url)) void shell.openExternal(url);
  });

  // Network down, server restarting (a 502 from the proxy loads "successfully"), or the page crashed.
  wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted, e.g. by a redirect */) return;
    scheduleRetry(`${description} (${code})`, url);
  });
  wc.on("did-navigate", (_e, url, status) => {
    if (!rules.sameOrigin(url, APP_URL)) return;
    if (status >= 500) scheduleRetry(`server answered ${status}`, url);
    else if (status > 0 && status < 400) failures = 0;
    if (url.includes("/?error=")) log(`sign-in failed: ${new URL(url).searchParams.get("error")}`);
  });
  // A clicked reminder notification opens Today with ?from=reminder: bring the window up even from the tray.
  wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
    if (isMainFrame && rules.isReminderOpen(url, APP_URL)) showWindow();
  });
  wc.on("render-process-gone", (_e, details) => {
    if (quitting || details.reason === "clean-exit") return;
    scheduleRetry(`page stopped (${details.reason})`, APP_URL.href);
  });
  win.on("unresponsive", () => {
    void dialog
      .showMessageBox(win, {
        type: "warning",
        title: "UIC Dialer is not responding",
        message: "The page has stopped responding.",
        detail: "Reload it, or wait for it to recover. Calls and outcomes already saved are safe.",
        buttons: ["Reload", "Wait"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) wc.forcefullyCrashRenderer();
      });
  });

  win.on("close", (e) => {
    saveWindowState();
    // Closing keeps the app in the tray so a call outcome prompt isn't lost; Quit is in the tray menu.
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // Windows shutdown or sign-out skips before-quit.
  win.on("session-end", () => {
    quitting = true;
  });
  win.on("closed", () => {
    win = null;
  });

  // DNS and TLS done while the window is still being set up.
  wc.session.preconnect({ url: APP_URL.href, numSockets: 2 });
  void win.loadURL(APP_URL.href);
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---- tray ---------------------------------------------------------------

async function createTray() {
  const icon = nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("UIC Dialer");
  tray.on("click", showWindow);
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open UIC Dialer", click: showWindow },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { type: "separator" },
      { label: "Reload", click: () => win?.webContents.reload() },
      // Reachable even when the window shows an error, which is when it's needed.
      { label: "Sign in using your browser…", click: startSignIn },
      { label: "Open logs folder", click: () => void shell.openPath(app.getPath("logs")) },
      { type: "separator" },
      {
        label: "Start with Windows",
        type: "checkbox",
        // Windows matches the Run entry on path AND args, so ask with the same args it was saved with.
        checked: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin,
        // --hidden: starts in the tray, so it's ready for calls without a window popping up at login.
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] });
          refreshTray();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ---- startup ------------------------------------------------------------

/**
 * One copy only: a second launch (a desktop shortcut, or Windows delivering a uicdialer:// link) hands its
 * arguments to this one. After an update the new copy may start while the old one still holds the lock, so
 * --updated retries briefly.
 */
async function singleInstance() {
  const updated = process.argv.includes("--updated");
  for (let i = 0; ; i++) {
    if (app.requestSingleInstanceLock()) return true;
    if (!updated || i >= 20) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function main() {
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${SCHEME}://`));
    if (link) finishSignIn(link);
    else showWindow();
  });

  // In development (electron .) Windows needs the script path to relaunch us for uicdialer:// links.
  if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient(SCHEME);

  app.whenReady().then(() => {
    mark("ready");
    // Don't let Windows suspend the app in the tray (reminders and live updates keep working).
    powerSaveBlocker.start("prevent-app-suspension");
    // Taskbar grouping and notifications under "UIC Dialer", not "electron.app.Electron".
    app.setAppUserModelId(APP_ID);
    // The dashboard needs no camera, mic or location; only notifications (follow-up reminders), and only for the
    // app's own origin (rules.allowPermission). Both handlers: most web APIs check first and only ask if the check says no.
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) =>
      cb(rules.allowPermission(perm, details?.requestingUrl || wc?.getURL() || "", APP_URL)),
    );
    session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => rules.allowPermission(perm, origin || wc?.getURL() || "", APP_URL));
    Menu.setApplicationMenu(null);
    createWindow();
    void createTray();
    log(`started${startHidden ? " (hidden)" : ""} → ${APP_URL.origin}`);
  });
  app.on("before-quit", () => {
    quitting = true;
    saveWindowState();
  });
  app.on("window-all-closed", () => {
    /* stay in the tray */
  });
}

void singleInstance().then((ok) => (ok ? main() : app.quit()));
