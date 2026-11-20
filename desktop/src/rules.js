// Pure rules for the shell, kept free of Electron so test/rules.test.js can check them directly.
"use strict";

const crypto = require("node:crypto");

const DEFAULT_APP_URL = "https://calls.usaindiacfo.us";
const SCHEME = "uicdialer";
/** Sign-ins kept waiting at once: each click starts one, and people often finish in an older browser tab. */
const MAX_FLOWS = 5;
/** A sign-in not finished in this time is forgotten (the server's code lives two minutes after Google). */
const FLOW_TTL_MS = 15 * 60_000;

/** The server address: UIC_URL wins; anything not https (except localhost for development) falls back. */
function resolveAppUrl(fromEnv) {
  if (!fromEnv) return new URL(DEFAULT_APP_URL);
  try {
    const url = new URL(fromEnv);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "https:" || (local && url.protocol === "http:")) return url;
  } catch {
    /* fall through */
  }
  console.error(`[shell] refusing UIC_URL=${fromEnv}: not an https URL. Using ${DEFAULT_APP_URL}.`);
  return new URL(DEFAULT_APP_URL);
}

const sameOrigin = (url, appUrl) => {
  try {
    return new URL(url).origin === appUrl.origin;
  } catch {
    return false;
  }
};

/** Web permissions the page may use: only desktop notifications (reminders), and only for the app's own origin. */
function allowPermission(permission, url, appUrl) {
  return permission === "notifications" && sameOrigin(url, appUrl);
}

/** A reminder notification was clicked: the page moves to an app URL with ?from=reminder, and we raise the window. */
function isReminderOpen(url, appUrl) {
  if (!sameOrigin(url, appUrl)) return false;
  return new URL(url).searchParams.get("from") === "reminder";
}

/** Digits and one leading +; null when it isn't a plausible phone number. */
function telNumber(url) {
  if (typeof url !== "string" || !/^tel:/i.test(url)) return null;
  let raw;
  try {
    raw = decodeURIComponent(url.slice(4));
  } catch {
    return null;
  }
  const number = raw.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return /^\+?\d{3,20}$/.test(number) ? number : null;
}

/**
 * Where a link from the page goes:
 *  - "window": the app's own page, the window follows it
 *  - "signin": the app's Google sign-in, done in the browser instead
 *  - "tel": a phone number for Phone Link
 *  - "external": https/mailto, opened in the browser
 *  - "block": anything else
 */
function routeFor(url, appUrl) {
  if (/^tel:/i.test(url)) return telNumber(url) ? "tel" : "block";
  if (sameOrigin(url, appUrl)) return new URL(url).pathname === "/auth/google" ? "signin" : "window";
  if (/^(https:|mailto:)/i.test(url)) return "external";
  return "block";
}

function newFlow(now = Date.now()) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, startedAt: now };
}

/** Keeps the newest MAX_FLOWS unexpired flows, with `flow` added last. */
function addFlow(flows, flow, now = Date.now()) {
  return [...flows.filter((f) => now - f.startedAt < FLOW_TTL_MS), flow].slice(-MAX_FLOWS);
}

/**
 * Reads a uicdialer://auth callback. Returns { code, flow } to redeem, or { ignored } when this app didn't
 * start it (any program can open a uicdialer:// link, so those are never acted on).
 */
function matchCallback(link, flows, now = Date.now()) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return { ignored: "not a URL" };
  }
  if (url.protocol !== `${SCHEME}:` || url.hostname !== "auth") return { ignored: "not a sign-in link" };
  const code = url.searchParams.get("code");
  if (!code) return { ignored: "no code" };
  const live = flows.filter((f) => now - f.startedAt < FLOW_TTL_MS);
  if (!live.length) return { ignored: "no sign-in in progress" };
  const state = url.searchParams.get("state");
  // Older servers send no state: try the newest sign-in.
  const flow = state ? live.find((f) => f.challenge === state) : live.at(-1);
  return flow ? { code, flow } : { ignored: "sign-in not started here" };
}

/** Wait before retrying a failed page load: 5s, 10s, 20s, 40s, then every 60s. */
const retryDelayMs = (failures) => Math.min(5 * 2 ** failures, 60) * 1000;

/** Window bounds from disk, or null when they're missing, malformed or off every screen. */
function validWindowState(state, displays) {
  if (!state || typeof state !== "object") return null;
  const { width, height, x, y } = state;
  if (![width, height].every((n) => Number.isInteger(n) && n >= 300 && n <= 10000)) return null;
  const out = { width, height, maximised: state.maximised === true };
  if (Number.isInteger(x) && Number.isInteger(y)) {
    // Only if part of the title bar would be on a connected screen (a monitor may have been unplugged).
    const visible = displays.some((d) => x + 100 > d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height);
    if (visible) Object.assign(out, { x, y });
  }
  return out;
}

module.exports = {
  DEFAULT_APP_URL,
  SCHEME,
  MAX_FLOWS,
  FLOW_TTL_MS,
  resolveAppUrl,
  sameOrigin,
  allowPermission,
  isReminderOpen,
  telNumber,
  routeFor,
  newFlow,
  addFlow,
  matchCallback,
  retryDelayMs,
  validWindowState,
};
