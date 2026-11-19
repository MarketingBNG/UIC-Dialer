import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractLead, nextInPool } from "../src/leads/assign.js";
import { numberKey } from "../src/privacy/clientNumbers.js";
import { PUBLIC_URL, setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
  const email = uniqueEmail("ladmin");
  await t.db.user.create({ data: { email, role: "ADMIN" } });
  admin = await t.sessionFor(email);
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

type H = Record<string, string>;
const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const inject = (method: "GET" | "POST" | "PATCH", url: string, headers: H, payload?: object) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

async function newSource(body: Record<string, unknown> = {}) {
  const res = await inject("POST", "/api/lead-sources", admin, { name: `Src ${randomUUID().slice(0, 8)}`, ...body });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string; name: string; webhookUrl: string; tokenHint: string };
}
const post = (token: string, payload: object, how: "bearer" | "header" | "query" = "bearer") =>
  t.app.inject({
    method: "POST",
    url: `/v1/leads/inbound${how === "query" ? `?token=${token}` : ""}`,
    headers: how === "bearer" ? { authorization: `Bearer ${token}` } : how === "header" ? { "x-uic-lead-token": token } : {},
    payload,
  });

describe("lead sources", () => {
  it("creates with a one-time token, lists without it, rotates, audits", async () => {
    const s = await newSource({ fieldMap: { phone: "data.mobile" } });
    expect(s.token).toMatch(/^uicl_/);
    expect(s.tokenHint).toBe(s.token.slice(-4));
    expect(s.webhookUrl).toBe(`${PUBLIC_URL}/v1/leads/inbound`);
    const list = (await inject("GET", "/api/lead-sources", admin)).json().items.find((x: { id: string }) => x.id === s.id);
    expect(list.token).toBeUndefined();
    expect(list).toMatchObject({ fieldMap: { phone: "data.mobile" }, stats: { last7d: 0, lastAt: null }, repPool: [] });
    const rotated = (await inject("POST", `/api/lead-sources/${s.id}/rotate`, admin)).json();
    expect(rotated.token).not.toBe(s.token);
    expect((await post(s.token, { phone: randomMobile() })).statusCode).toBe(401);
    expect((await inject("POST", "/api/lead-sources", admin, { name: s.name })).statusCode).toBe(409);
    expect(await t.db.auditLog.count({ where: { action: "LEAD_SOURCE_CHANGE", detail: { path: ["sourceId"], equals: s.id } } })).toBe(1);
  });
});

describe("POST /v1/leads/inbound", () => {
  it("401 for a bad or inactive token; token by header or X-header (never the query); 400 without a phone", async () => {
    expect((await post("uicl_nope", { phone: randomMobile() })).statusCode).toBe(401);
    const rep = await t.db.user.create({ data: { email: uniqueEmail("lrep") } });
    const s = await newSource({ repPool: [rep.id] });
    for (const how of ["bearer", "header"] as const) {
      const res = await post(s.token, { phone: randomMobile(), name: "Web Lead" }, how);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, status: "ASSIGNED", assignedTo: { id: rep.id } });
    }
    // A token in the URL would land in request and proxy logs: refused.
    expect((await post(s.token, { phone: randomMobile() }, "query")).statusCode).toBe(401);
    const bad = await post(s.token, { name: "No phone", id: "x1" });
    expect(bad.statusCode).toBe(400);
    expect(await t.db.leadEvent.count({ where: { sourceId: s.id, status: "INVALID" } })).toBe(1);
    expect((await post(s.token, { name: "No phone", id: "x1" })).statusCode).toBe(400);
    // A retry of the same lead with a usable phone is not stuck on the earlier rejection.
    const fixed = await post(s.token, { name: "Now with phone", id: "x1", phone: randomMobile() });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json()).toMatchObject({ ok: true, status: "ASSIGNED" });
    expect(await t.db.leadEvent.count({ where: { sourceId: s.id, status: "INVALID" } })).toBe(0);
    const text = await t.app.inject({ method: "POST", url: "/v1/leads/inbound", headers: { authorization: `Bearer ${s.token}`, "content-type": "text/plain" }, payload: "phone=1" });
    expect(text.statusCode).toBe(415);
    await inject("PATCH", `/api/lead-sources/${s.id}`, admin, { active: false });
    expect((await post(s.token, { phone: randomMobile() })).statusCode).toBe(401);
  });

  it("round-robins a pool of 3 over 4 concurrent leads (A,B,C,A)", async () => {
    const reps = await Promise.all([1, 2, 3].map(() => t.db.user.create({ data: { email: uniqueEmail("lrr") } })));
    const s = await newSource({ repPool: reps.map((r) => r.id) });
    const res = await Promise.all([1, 2, 3, 4].map(() => post(s.token, { phone: randomMobile() })));
    const got = res.map((r) => r.json().assignedTo.id as string);
    const counts = new Map<string, number>();
    for (const id of got) counts.set(id, (counts.get(id) ?? 0) + 1);
    const sorted = reps.map((r) => r.id).sort();
    expect(counts.get(sorted[0]!)).toBe(2);
    expect(counts.get(sorted[1]!)).toBe(1);
    expect(counts.get(sorted[2]!)).toBe(1);
    // Each rep got a NEW_LEAD task with clientId lead:<eventId>.
    for (const r of res) {
      const task = await t.db.followUpTask.findUniqueOrThrow({ where: { clientId: `lead:${r.json().leadId}` } });
      expect(task).toMatchObject({ kind: "NEW_LEAD", userId: r.json().assignedTo.id, leadEventId: r.json().leadId });
    }
  });

  it("keeps an existing owner; DNC means no assignment; externalId repeats are idempotent", async () => {
    const pooled = await t.db.user.create({ data: { email: uniqueEmail("lpool") } });
    const s = await newSource({ repPool: [pooled.id] });
    const owner = await t.db.user.create({ data: { email: uniqueEmail("lowner"), name: "Owner" } });
    const phone = randomMobile();
    const c = await t.db.contact.create({ data: { phoneE164: `+91${phone}`, ownerId: owner.id, name: "Known" } });
    const kept = await post(s.token, { mobile: phone, full_name: "Someone Else", message: "Need ITR help" });
    expect(kept.json()).toMatchObject({ status: "EXISTING_OWNER", contactId: c.id, assignedTo: { id: owner.id, name: "Owner" } });
    const after = await t.db.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toMatchObject({ ownerId: owner.id, name: "Known", source: s.name });
    // The lead's message became a note by the owner.
    expect(await t.db.activity.count({ where: { clientId: `lead-note:${kept.json().leadId}`, userId: owner.id, type: "NOTE" } })).toBe(1);

    const blocked = randomMobile();
    await t.db.dncNumber.create({ data: { key: numberKey(blocked), raw: blocked } });
    const dnc = await post(s.token, { phone: blocked, name: "Blocked" });
    expect(dnc.json()).toMatchObject({ status: "DNC", assignedTo: null });
    const dncContact = await t.db.contact.findUniqueOrThrow({ where: { phoneE164: `+91${blocked}` } });
    expect(dncContact.ownerId).toBeNull();
    expect(await t.db.followUpTask.count({ where: { leadEventId: dnc.json().leadId } })).toBe(0);

    const ext = `fb-${randomUUID()}`;
    const one = await post(s.token, { leadgen_id: ext, phone: randomMobile() });
    const two = await post(s.token, { leadgen_id: ext, phone: randomMobile() });
    expect(two.statusCode).toBe(200);
    expect(two.json()).toEqual(one.json());
    expect(await t.db.leadEvent.count({ where: { sourceId: s.id, externalId: ext } })).toBe(1);
  });

  it("NEW_LEAD shows only with ?v=2, and a call closes it", async () => {
    const email = uniqueEmail("lv2");
    const rep = await t.loginDevice(email);
    const s = await newSource({ repPool: [rep.user.id] });
    const phone = randomMobile();
    const lead = (await post(s.token, { phone, name: "Asha" })).json();
    const v1 = (await inject("GET", "/v1/followups/today", rep.headers)).json();
    expect(v1.items.some((i: { kind: string }) => i.kind === "NEW_LEAD")).toBe(false);
    const v2 = (await inject("GET", "/v1/followups/today?v=2", rep.headers)).json();
    const item = v2.items.find((i: { taskId: string }) => i.taskId);
    expect(item).toMatchObject({ kind: "NEW_LEAD", name: "Asha", source: s.name, overdue: true, contactId: lead.contactId });
    expect(v2.counts.overdue).toBeGreaterThan(v1.counts.overdue);
    const dash = (await inject("GET", "/api/followups/today?v=2", rep.headers)).json();
    expect(dash.items.map((i: { key: string }) => i.key)).toContain(item.key);

    await inject("POST", "/v1/activities", rep.headers, {
      clientId: randomUUID(),
      phone,
      type: "CALL",
      outcome: "INTERESTED",
      occurredAt: new Date(Date.now() + 1000).toISOString(),
    });
    const task = await t.db.followUpTask.findUniqueOrThrow({ where: { clientId: `lead:${lead.leadId}` } });
    expect(task.state).toBe("DONE");
  });

  it("lists lead events for admins", async () => {
    const s = await newSource();
    await post(s.token, { phone: randomMobile() });
    const res = await inject("GET", `/api/lead-events?sourceId=${s.id}`, admin);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({ source: { id: s.id }, status: expect.any(String) });
  });
});

describe("helpers", () => {
  it("nextInPool wraps around", () => {
    expect(nextInPool(["b", "a", "c"], null)).toBe("a");
    expect(nextInPool(["b", "a", "c"], "a")).toBe("b");
    expect(nextInPool(["b", "a", "c"], "c")).toBe("a");
    expect(nextInPool([], "c")).toBeNull();
  });
  it("extractLead reads field-map dot paths and default keys (case-insensitive)", () => {
    expect(extractLead({ data: { mob: "98765 43210" }, SENDER_NAME: "Ravi", QUERY_MESSAGE: "Need GST", UNIQUE_QUERY_ID: 77 }, { phone: "data.mob" })).toMatchObject({
      phone: "98765 43210",
      name: "Ravi",
      note: "Need GST",
      externalId: "77",
    });
  });
});

describe("lead source rep pools", () => {
  it("only active agents and managers may be in a pool", async () => {
    const adminUser = await t.db.user.create({ data: { email: uniqueEmail("lpadm"), role: "ADMIN" } });
    const gone = await t.db.user.create({ data: { email: uniqueEmail("lpgone"), active: false } });
    const rep = await t.db.user.create({ data: { email: uniqueEmail("lprep") } });
    const mgr = await t.db.user.create({ data: { email: uniqueEmail("lpmgr"), role: "MANAGER" } });
    for (const bad of [adminUser.id, gone.id]) {
      const res = await inject("POST", "/api/lead-sources", admin, { name: `Src ${randomUUID().slice(0, 8)}`, repPool: [rep.id, bad] });
      expect(res.statusCode).toBe(400);
    }
    const s = await newSource({ repPool: [rep.id, mgr.id] });
    expect((await inject("PATCH", `/api/lead-sources/${s.id}`, admin, { repPool: [adminUser.id] })).statusCode).toBe(400);
  });

  it("an explicit pool whose reps all left gives NO_REP instead of falling back to everyone", async () => {
    const rep = await t.db.user.create({ data: { email: uniqueEmail("lpleft") } });
    const s = await newSource({ repPool: [rep.id] });
    await t.db.user.update({ where: { id: rep.id }, data: { active: false } });
    const res = await post(s.token, { phone: randomMobile() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "NO_REP", assignedTo: null });
  });

  it("two simultaneous leads for the same new number without an id both succeed on one contact", async () => {
    const rep = await t.db.user.create({ data: { email: uniqueEmail("lpdup") } });
    const s = await newSource({ repPool: [rep.id] });
    const phone = randomMobile();
    const res = await Promise.all([1, 2, 3].map(() => post(s.token, { phone, name: "Twice" })));
    for (const r of res) expect(r.statusCode).toBe(200);
    expect(new Set(res.map((r) => r.json().contactId)).size).toBe(1);
    expect(await t.db.leadEvent.count({ where: { sourceId: s.id } })).toBe(3);
  });
});
