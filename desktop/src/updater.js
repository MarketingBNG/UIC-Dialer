// Auto-update from GitHub Releases (CI publishes each desktop/ change as a release; see .github/workflows/ci.yml).
// Downloads in the background and installs when the app quits, or straight away from the tray's
// "Restart to update". Only in the installed app: a source run (electron .) has nothing to update.
"use strict";

const { app, Notification } = require("electron");

const CHECK_EVERY_MS = 4 * 3600 * 1000;
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
const FIRST_CHECK_MS = 30 * 1000;
/** Installs by itself if the update has waited this long with the window hidden (reps rarely quit a tray app). */
const IDLE_INSTALL_AFTER_MS = 6 * 3600 * 1000;

/**
 * @param {{ log: (s: string) => void, onChange: () => void, isIdle: () => boolean }} hooks
 * @returns {{ state: () => { status: string, version?: string }, installNow: () => void }}
 */
function startUpdater({ log, onChange, isIdle }) {
  let status = "idle"; // idle | checking | downloading | ready | error
  let version;
  const state = () => ({ status, version });
  if (!app.isPackaged) return { state, installNow: () => {} };

  // Loaded only in the installed app, after startup, so it costs nothing on the launch path.
  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true; // we ship the full installer, not the web one
  autoUpdater.logger = { info: () => {}, warn: (m) => log(`update: ${m}`), error: (m) => log(`update error: ${m}`), debug: () => {} };

  let timer = null;
  let readyAt = 0;
  const set = (s, v) => {
    status = s;
    if (v) version = v;
    onChange();
  };
  const schedule = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(check, ms);
    timer.unref?.();
  };
  const check = () => {
    if (status === "ready") {
      // Downloaded but not installed yet: install while nobody is using the app.
      if (Date.now() - readyAt > IDLE_INSTALL_AFTER_MS && isIdle()) installNow();
      else schedule(CHECK_EVERY_MS / 4);
      return;
    }
    autoUpdater.checkForUpdates().catch((e) => {
      log(`update check failed: ${e?.message ?? e}`);
      set("error");
      schedule(RETRY_AFTER_FAILURE_MS);
    });
  };

  autoUpdater.on("checking-for-update", () => set("checking"));
  autoUpdater.on("update-not-available", () => {
    set("idle");
    schedule(CHECK_EVERY_MS);
  });
  autoUpdater.on("update-available", (info) => {
    log(`update available: ${info.version}`);
    set("downloading", info.version);
  });
  autoUpdater.on("error", (e) => {
    log(`update error: ${e?.message ?? e}`);
    set("error");
    schedule(RETRY_AFTER_FAILURE_MS);
  });
  autoUpdater.on("update-downloaded", (info) => {
    log(`update downloaded: ${info.version}`);
    readyAt = Date.now();
    set("ready", info.version);
    if (Notification.isSupported()) {
      new Notification({ title: "UIC Dialer update ready", body: `Version ${info.version} installs when you restart UIC Dialer (tray menu → Restart to update).` }).show();
    }
    schedule(CHECK_EVERY_MS / 4);
  });

  function installNow() {
    if (status !== "ready") return;
    log(`installing update ${version}`);
    // Silent install, then start again (electron-updater passes --updated; see singleInstance in main.js).
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }

  schedule(FIRST_CHECK_MS);
  return { state, installNow };
}

module.exports = { startUpdater };
