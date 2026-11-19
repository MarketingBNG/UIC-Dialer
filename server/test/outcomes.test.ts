import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_OUTCOME_IDS } from "../src/activity/outcomes.js";
import { numberKey } from "../src/privacy/clientNumbers.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
  const email = uniqueEmail("oadmin");
  await t.db.user.create({ data: { email, role: "ADMIN" } });
  admin = await t.sessionFor(email);
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const HOUR = 3600_000;
const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
type H = Record<string, string>;
const inject = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, headers: H, payload?: object) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

async function newOutcome(body: Record<string, unknown>) {
  const res = await inject("POST", "/api/outcomes", admin, { color: "#123456", baseOutcome: "INTERESTED", rule: "NONE", ...body, label: body["label"] ?? `O ${randomUUID().slice(0, 6)}` });
  expect(res.statusCode).toBe(201);
  return res.json();
}
const activity = (headers: H, phone: string, body: Record<string, unknown>) =>
  inject("POST", "/v1/activities", headers, { clientId: randomUUID(), phone, type: "CALL", occurredAt: new Date().toISOString(), ...body });

/** A list with one item for this contact, assigned to the rep. */
async function listWith(contactId: string, repId: string) {
  const list = await t.db.callList.create({ data: { name: "L", assignees: { create: [{ userId: repId }] } } });
  return t.db.callListItem.create({ data: { listId: list.id, contactId, position: 0 } });
}

describe("outcome definitions", () => {
  it("seeds the four defaults with fixed ids", async () => {
    const res = await inject("GET", "/api/outcomes", admin);
    const ids = res.json().items.map((o: { id: string }) => o.id);
    for (const id of Object.values(DEFAULT_OUTCOME_IDS)) expect(ids).toContain(id);
    const cb = res.json().items.find((o: { id: string }) => o.id === DEFAULT_OUTCOME_IDS.CALL_BACK);
    expect(cb).toMatchObject({ key: "call_back", label: "Call back", baseOutcome: "CALL_BACK", rule: "ASK_CALLBACK", color: "#D97706" });
  });

  it("admin CRUD with validation; agents get 403; inactive ones hide", async () => {
    expect((await inject("POST", "/api/outcomes", admin, { label: "Bad", color: "#123456", baseOutcome: "CALL_BACK", rule: "NONE" })).statusCode).toBe(400);
    expect((await inject("POST", "/api/outcomes", admin, { label: "Bad", color: "#123456", baseOutcome: "NO_ANSWER", rule: "RETRY" })).statusCode).toBe(400);
    expect((await inject("POST", "/api/outcomes", admin, { label: "Bad", color: "red", baseOutcome: "NO_ANSWER", rule: "NONE" })).statusCode).toBe(400);
    const o = await newOutcome({ label: "Meeting set", rule: "ASK_MEETING" });
    expect(o).toMatchObject({ label: "Meeting set", rule: "ASK_MEETING", active: true, retryHours: null, addToDnc: false, key: null });
    const patched = await inject("PATCH", `/api/outcomes/${o.id}`, admin, { active: false, color: "#abcdef" });
    expect(patched.json()).toMatchObject({ active: false, color: "#ABCDEF" });
    expect((await inject("GET", "/api/outcomes", admin)).json().items.map((x: { id: string }) => x.id)).not.toContain(o.id);
    expect((await inject("GET", "/api/outcomes?all=1", admin)).json().items.map((x: { id: string }) => x.id)).toContain(o.id);
    expect(await t.db.auditLog.count({ where: { action: "OUTCOME_CHANGE", detail: { path: ["outcomeId"], equals: o.id } } })).toBe(1);

    const agentEmail = uniqueEmail("oagent");
    const phone = await t.loginDevice(agentEmail);
    expect((await inject("POST", "/api/outcomes", phone.headers, { label: "X", color: "#123456", baseOutcome: "INTERESTED", rule: "NONE" })).statusCode).toBe(403);
    const dev = await inject("GET", "/v1/outcomes", phone.headers);
    expect(dev.statusCode).toBe(200);
    expect(dev.json().items.every((x: { active: boolean }) => x.active)).toBe(true);
    // Order: sortOrder = index * 10.
    const a = await newOutcome({});
    const b = await newOutcome({});
    const ordered = await inject("PUT", "/api/outcomes/order", admin, { ids: [b.id, a.id] });
    const items = ordered.json().items;
    expect(items.find((x: { id: string }) => x.id === b.id).sortOrder).toBe(0);
    expect(items.find((x: { id: string }) => x.id === a.id).sortOrder).toBe(10);
  });
});

describe("activities with outcomes", () => {
  it("stores the base outcome for an outcomeId, and maps an old-style outcome to the default id", async () => {
    const rep = await t.loginDevice(uniqueEmail("orep"));
    const o = await newOutcome({ label: "Hot lead", baseOutcome: "INTERESTED" });
    const phone = randomMobile();
    const res = await activity(rep.headers, phone, { outcomeId: o.id, outcome: "NO_ANSWER" });
    expect(res.statusCode).toBe(200);
    expect(res.json().activity).toMatchObject({ outcome: "INTERESTED", outcomeId: o.id, outcomeLabel: "Hot lead", outcomeColor: "#123456" });
    expect(res.json().contact.status).toBe("INTERESTED");

    const old = await activity(rep.headers, phone, { outcome: "NOT_INTERESTED" });
    expect(old.json().activity).toMatchObject({ outcome: "NOT_INTERESTED", outcomeId: DEFAULT_OUTCOME_IDS.NOT_INTERESTED, outcomeLabel: "Not interested" });
    // Old apps keep their old CALL_BACK message.
    const cb = await activity(rep.headers, phone, { outcome: "CALL_BACK" });
    expect(cb.statusCode).toBe(400);
    expect(cb.json().error).toBe("CALL_BACK needs followUpAt");
    expect((await activity(rep.headers, phone, { outcomeId: randomUUID() })).json().error).toBe("Unknown outcome");
    expect((await activity(rep.headers, phone, { type: "NOTE", outcomeId: o.id })).statusCode).toBe(400);
  });

  it("ASK_* without a date is 400 OUTCOME_NEEDS_DATE; with one it sets the follow-up", async () => {
    const rep = await t.loginDevice(uniqueEmail("orep"));
    const o = await newOutcome({ rule: "ASK_FOLLOW_UP" });
    const phone = randomMobile();
    const bad = await activity(rep.headers, phone, { outcomeId: o.id });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("OUTCOME_NEEDS_DATE");
    // Nothing was created for the rejected item.
    expect(await t.db.contact.count({ where: { phoneE164: `+91${phone}` } })).toBe(0);
    const at = new Date(Date.now() + 48 * HOUR).toISOString();
    const ok = await activity(rep.headers, phone, { outcomeId: o.id, followUpAt: at });
    expect(ok.json().contact).toMatchObject({ status: "INTERESTED", nextFollowUpAt: at });
    // Batch reports the code per item.
    const batch = await inject("POST", "/v1/activities/batch", rep.headers, {
      items: [{ clientId: randomUUID(), phone, type: "CALL", occurredAt: new Date().toISOString(), outcomeId: o.id }],
    });
    expect(batch.json().results[0]).toMatchObject({ ok: false, status: 400, code: "OUTCOME_NEEDS_DATE" });
  });

  it("RETRY computes followUpAt and puts the list item back to PENDING", async () => {
    const rep = await t.loginDevice(uniqueEmail("orep"));
    const o = await newOutcome({ rule: "RETRY", retryHours: 3, baseOutcome: "NO_ANSWER" });
    const phone = randomMobile();
    const first = await activity(rep.headers, phone, { type: "WHATSAPP" });
    const contactId = first.json().contact.id;
    const item = await listWith(contactId, rep.user.id);
    const occurredAt = new Date(Date.now() - HOUR);
    const res = await activity(rep.headers, phone, {
      outcomeId: o.id,
      occurredAt: occurredAt.toISOString(),
      followUpAt: new Date(Date.now() + 99 * HOUR).toISOString(),
      callListItemId: item.id,
    });
    const want = new Date(occurredAt.getTime() + 3 * HOUR).toISOString();
    expect(res.json().activity.followUpAt).toBe(want);
    const after = await t.db.callListItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ state: "PENDING", attempts: 1, lastOutcomeId: o.id, lastOutcome: "NO_ANSWER", claimedById: null });
    expect(after.retryAt?.toISOString()).toBe(want);
  });

  it("REMOVE_FROM_LISTS + addToDnc creates DNC and removes open items", async () => {
    const rep = await t.loginDevice(uniqueEmail("orep"));
    const o = await newOutcome({ label: "Wrong number", rule: "REMOVE_FROM_LISTS", addToDnc: true, baseOutcome: "NOT_INTERESTED" });
    const phone = randomMobile();
    const contactId = (await activity(rep.headers, phone, { type: "WHATSAPP" })).json().contact.id;
    const a = await listWith(contactId, rep.user.id);
    const b = await listWith(contactId, rep.user.id);
    await activity(rep.headers, phone, { outcomeId: o.id, callListItemId: a.id });
    const items = await t.db.callListItem.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(items.map((i) => i.state)).toEqual(["REMOVED", "REMOVED"]);
    const dnc = await t.db.dncNumber.findUniqueOrThrow({ where: { key: numberKey(phone) } });
    expect(dnc).toMatchObject({ source: "OUTCOME", reason: "Outcome: Wrong number", createdById: rep.user.id });
  });

  it("CLOSE_LEAD removes the contact's other open items and marks this one DONE", async () => {
    const rep = await t.loginDevice(uniqueEmail("orep"));
    const o = await newOutcome({ rule: "CLOSE_LEAD" });
    const phone = randomMobile();
    const contactId = (await activity(rep.headers, phone, { type: "WHATSAPP" })).json().contact.id;
    const a = await listWith(contactId, rep.user.id);
    const b = await listWith(contactId, rep.user.id);
    const res = await activity(rep.headers, phone, { outcomeId: o.id, callListItemId: a.id, followUpAt: new Date(Date.now() + HOUR).toISOString() });
    expect(res.json().contact.nextFollowUpAt).toBeNull();
    expect((await t.db.callListItem.findUniqueOrThrow({ where: { id: a.id } })).state).toBe("DONE");
    expect((await t.db.callListItem.findUniqueOrThrow({ where: { id: b.id } })).state).toBe("REMOVED");
  });

  it("ignores a list item from a list the rep is not assigned to", async () => {
    const rep = await t.loginDevice(uniqueEmail("orep"));
    const other = await t.loginDevice(uniqueEmail("orep"));
    const phone = randomMobile();
    const contactId = (await activity(rep.headers, phone, { type: "WHATSAPP" })).json().contact.id;
    const item = await listWith(contactId, other.user.id);
    const res = await activity(rep.headers, phone, { outcome: "INTERESTED", callListItemId: item.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().activity.callListItemId).toBeNull();
    expect((await t.db.callListItem.findUniqueOrThrow({ where: { id: item.id } })).state).toBe("PENDING");
  });

  it("logs an SMS as WHATSAPP with channel SMS and a template; channel only for WHATSAPP", async () => {
    const rep = await t.loginDevice(uniqueEmail("orep"));
    const tpl = await t.db.messageTemplate.create({ data: { name: "Hi", body: "Hi {name}" } });
    const phone = randomMobile();
    const res = await activity(rep.headers, phone, { type: "WHATSAPP", channel: "SMS", templateId: tpl.id, note: "Hi there" });
    expect(res.json().activity).toMatchObject({ type: "WHATSAPP", channel: "SMS", templateId: tpl.id });
    const wa = await activity(rep.headers, phone, { type: "WHATSAPP" });
    expect(wa.json().activity.channel).toBe("WHATSAPP");
    expect((await activity(rep.headers, phone, { channel: "SMS" })).statusCode).toBe(400);
    // A deleted template does not lose a queued log.
    const gone = await activity(rep.headers, phone, { type: "WHATSAPP", templateId: randomUUID() });
    expect(gone.statusCode).toBe(200);
    expect(gone.json().activity.templateId).toBeNull();
  });
});
