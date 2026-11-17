// UIC Dialer for Windows. A thin, locked-down window around the hosted dashboard (so dashboard updates need no
// reinstall) that adds two things a browser can't do cleanly:
//  1. tel: links go to Windows, where Phone Link dials on the rep's paired Android phone and carries the audio
//     over Bluetooth. The phone's own dialer places the call, so its recorder and our upload keep working.
//  2. Google sign-in runs in the system browser (Google blocks sign-in inside embedded windows). The server sends
//     a one-time code back through the uicdialer:// link, which only this app can redeem (S256 verifier).
"use strict";

const { app, BrowserWindow, Menu, Tray, nativeImage, session, shell } = require("electron");
const crypto = require("node:crypto");

const APP_URL = new URL(process.env.UIC_URL || "https://calls.usaindiacfo.us");
const SCHEME = "uicdialer";

let win = null;
let tray = null;
let quitting = false;
/** Verifier for the sign-in currently open in the browser (one at a time). */
let signInVerifier = null;

const sameOrigin = (url) => {
  try {
    return new URL(url).origin === APP_URL.origin;
  } catch {
    return false;
  }
};

/** Phone numbers only: digits and one leading +. Anything else is dropped. */
function openTel(url) {
  const number = decodeURIComponent(url.slice(4)).replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  if (/^\+?\d{3,20}$/.test(number)) void shell.openExternal(`tel:${number}`);
}

function startSignIn() {
  signInVerifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(signInVerifier).digest("base64url");
  const url = new URL("/auth/google", APP_URL);
  url.searchParams.set("desktop", challenge);
  void shell.openExternal(url.href);
}

function finishSignIn(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return;
  }
  const code = url.searchParams.get("code");
  if (url.protocol !== `${SCHEME}:` || url.hostname !== "auth" || !code || !signInVerifier) return;
  const exchange = new URL("/auth/desktop/exchange", APP_URL);
  exchange.searchParams.set("code", code);
  exchange.searchParams.set("verifier", signInVerifier);
  signInVerifier = null;
  showWindow();
  void win.loadURL(exchange.href);
}

/** Decides where a link from the page goes. Returns true when the window may follow it itself. */
function route(url) {
  if (url.startsWith("tel:")) {
    openTel(url);
    return false;
  }
  if (sameOrigin(url)) {
    if (new URL(url).pathname === "/auth/google") {
      startSignIn();
      return false;
    }
    return true;
  }
  if (/^(https|mailto):/i.test(url)) void shell.openExternal(url);
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 520,
    title: "UIC Dialer",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
    },
  });
  // Lets the dashboard know it runs inside the desktop app.
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} UICDialer/${app.getVersion()}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (route(url)) void win.loadURL(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!route(url)) e.preventDefault();
  });
  win.webContents.on("will-redirect", (e, url) => {
    if (sameOrigin(url)) return;
    e.preventDefault();
    if (/^https:/i.test(url)) void shell.openExternal(url);
  });
  win.on("close", (e) => {
    // Closing keeps the app in the tray so a call outcome prompt isn't lost; Quit is in the tray menu.
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  void win.loadURL(APP_URL.href);
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function createTray() {
  // The installed exe's icon (Electron's default until a branded build/icon.ico is added).
  const icon = await app.getFileIcon(process.execPath, { size: "small" }).catch(() => nativeImage.createEmpty());
  tray = new Tray(icon);
  tray.setToolTip("UIC Dialer");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open UIC Dialer", click: showWindow },
      { label: "Reload", click: () => win?.webContents.reload() },
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
  tray.on("click", showWindow);
}


if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${SCHEME}://`));
    if (link) finishSignIn(link);
    else showWindow();
  });

  // In development (electron .) Windows needs the script path to relaunch us for uicdialer:// links.
  if (process.defaultApp) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [require("node:path").resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient(SCHEME);

  app.whenReady().then(() => {
    // The dashboard needs no camera, mic, location or notifications from Electron.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    Menu.setApplicationMenu(null);
    createWindow();
    void createTray();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    /* stay in the tray */
  });
}
