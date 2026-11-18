"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const r = require("../src/rules.js");

const APP = new URL("https://calls.usaindiacfo.us");

test("app URL: https or localhost only", () => {
  assert.equal(r.resolveAppUrl(undefined).href, "https://calls.usaindiacfo.us/");
  assert.equal(r.resolveAppUrl("http://localhost:8000").origin, "http://localhost:8000");
  assert.equal(r.resolveAppUrl("https://staging.example.com").origin, "https://staging.example.com");
  assert.equal(r.resolveAppUrl("http://evil.example.com").origin, APP.origin);
  assert.equal(r.resolveAppUrl("not a url").origin, APP.origin);
});

test("tel numbers are cleaned or refused", () => {
  assert.equal(r.telNumber("tel:+91 98765-43210"), "+919876543210");
  assert.equal(r.telNumber("tel:%2B91%2098765"), "+9198765");
  assert.equal(r.telNumber("tel:98+765+43"), "9876543");
  assert.equal(r.telNumber("tel:12"), null);
  assert.equal(r.telNumber("tel:abc"), null);
  assert.equal(r.telNumber("tel:%E0%A4%A"), null);
  assert.equal(r.telNumber("https://x"), null);
});

test("routing", () => {
  assert.equal(r.routeFor("https://calls.usaindiacfo.us/dialer", APP), "window");
  assert.equal(r.routeFor("https://calls.usaindiacfo.us/auth/google", APP), "signin");
  assert.equal(r.routeFor("https://calls.usaindiacfo.us/auth/google?x=1", APP), "signin");
  assert.equal(r.routeFor("TEL:+911234567", APP), "tel");
  assert.equal(r.routeFor("tel:x", APP), "block");
  assert.equal(r.routeFor("https://wa.me/911234567", APP), "external");
  assert.equal(r.routeFor("mailto:a@b.c", APP), "external");
  assert.equal(r.routeFor("http://calls.usaindiacfo.us/", APP), "block");
  assert.equal(r.routeFor("file:///C:/Windows", APP), "block");
  assert.equal(r.routeFor("javascript:alert(1)", APP), "block");
  assert.equal(r.routeFor("https://calls.usaindiacfo.us.evil.com/", APP), "external");
});

test("flows: verifier matches its challenge; only the newest few are kept", () => {
  const f = r.newFlow(0);
  assert.equal(crypto.createHash("sha256").update(f.verifier).digest("base64url"), f.challenge);
  assert.match(f.challenge, /^[A-Za-z0-9_-]{43}$/);
  let flows = [];
  for (let i = 0; i < 7; i++) flows = r.addFlow(flows, r.newFlow(i), i);
  assert.equal(flows.length, r.MAX_FLOWS);
  assert.equal(flows[0].startedAt, 2);
  const later = r.FLOW_TTL_MS + 10;
  assert.deepEqual(r.addFlow(flows, r.newFlow(later), later).map((x) => x.startedAt), [later]);
});

test("callbacks: matched by state, older tabs still work, strangers ignored", () => {
  const a = r.newFlow(1000);
  const b = r.newFlow(2000);
  const flows = [a, b];
  const now = 3000;
  assert.equal(r.matchCallback(`uicdialer://auth?code=c1&state=${a.challenge}`, flows, now).flow, a);
  assert.equal(r.matchCallback(`uicdialer://auth?code=c1&state=${b.challenge}`, flows, now).flow, b);
  assert.equal(r.matchCallback("uicdialer://auth?code=c1", flows, now).flow, b);
  assert.equal(r.matchCallback("uicdialer://auth?code=c1", flows, now).code, "c1");
  assert.ok(r.matchCallback("uicdialer://auth?code=c1&state=nope", flows, now).ignored);
  assert.ok(r.matchCallback("uicdialer://auth?state=x", flows, now).ignored);
  assert.ok(r.matchCallback("uicdialer://other?code=c1", flows, now).ignored);
  assert.ok(r.matchCallback("https://auth?code=c1", flows, now).ignored);
  assert.ok(r.matchCallback("uicdialer://auth?code=c1", [], now).ignored);
  assert.ok(r.matchCallback("uicdialer://auth?code=c1", flows, 2000 + r.FLOW_TTL_MS).ignored);
});

test("retry waits back off to a minute", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(r.retryDelayMs), [5000, 10000, 20000, 40000, 60000, 60000]);
});

test("window state: sane sizes, position only when on a screen", () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  assert.deepEqual(r.validWindowState({ width: 1000, height: 700, x: 50, y: 40, maximised: true }, screens), {
    width: 1000,
    height: 700,
    x: 50,
    y: 40,
    maximised: true,
  });
  assert.deepEqual(r.validWindowState({ width: 1000, height: 700, x: 3000, y: 40 }, screens), { width: 1000, height: 700, maximised: false });
  assert.equal(r.validWindowState({ width: 10, height: 700 }, screens), null);
  assert.equal(r.validWindowState("junk", screens), null);
  assert.equal(r.validWindowState(null, screens), null);
});
