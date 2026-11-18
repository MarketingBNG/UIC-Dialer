import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHONE_ONLINE_MS, followUpsToday, phoneStatus } from "../src/activity/followups.js";
import { istDay } from "../src/activity/service.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const iso = (d: Date) => d.toISOString();
const HOUR = 3600_000;

type Headers = Record<string, string>;

async function missed(headers: Headers, items: Record<string, unknown>[]) {
  return t.app.inject({ method: "POST", url: "/v1/followups/missed", headers, payload: { items } });
}
const missedItem = (phone: string, at: Date, extra: Record<string, unknown> = {}) => ({
  clientId: `missed:${at.getTime()}:${phone}`,
  phone,
  occurredAt: iso(at),
  ...extra,
});
async function today(headers: Headers) {
  const res = await t.app.inject({ method: "GET", url: "/v1/followups/today", headers });
  expect(res.statusCode).toBe(200);
  return res.json();
}
async function registerCall(headers: Headers, phone: string, startedAt: Date, direction = "OUTGOING", durationS = 30) {
  await t.app.inject({
    method: "POST",
    url: "/v1/calls",
    headers,
    payload: { originalSha256: sha256(randomUUID()), phoneNumber: phone, direction, startedAt: iso(startedAt), durationS },
  });
}
async function activity(headers: Headers, phone: string, at: Date, body: Record<string, unknown> = {}) {
  return t.app.inject({
    method: "POST",
    url: "/v1/activities",
    headers,
    payload: { clientId: randomUUID(), phone, type: "CALL", occurredAt: iso(at), ...body },
  });
}

describe("POST /v1/followups/missed", () => {
  it("creates an OPEN task, is idempotent, and 409s another rep's clientId", async () => {
    const rep = await t.loginDevice(uniqueEmail("rep"));
    const phone = randomMobile();
    const item = missedItem(phone, new Date(Date.now() - HOUR), { callerName: "Ravi" });
    const res = await missed(rep.headers, [item, { clientId: "bad", phone: "12", occurredAt: iso(new Date()) }, { phone }]);
    expect(res.statusCode).toBe(200);
    const [ok, bad, invalid] = res.json().results;
    expect(ok).toMatchObject({ clientId: item.clientId, ok: true, state: "OPEN" });
    expect(bad).toMatchObject({ clientId: "bad", ok: false, status: 400, error: "Invalid phone number" });
    expect(invalid).toMatchObject({ ok: false, status: 400 });

    const again = (await missed(rep.headers, [item])).json().results[0];
    expect(again).toMatchObject({ ok: true, id: ok.id });
    expect(await t.db.followUpTask.count({ where: { clientId: item.clientId } })).toBe(1);

    const other = await t.loginDevice(uniqueEmail("rep"));
    expect((await missed(other.headers, [item])).json().results[0]).toMatchObject({ ok: false, status: 409 });

    const list = await today(rep.headers);
    expect(list.items).toContainEqual(
      expect.objectContaining({ key: `task:${ok.id}`, kind: "MISSED_CALL", taskId: ok.id, phoneE164: `+91${phone}`, name: "Ravi", overdue: true }),
    );
    // No contact is created for a missed call.
    expect(await t.db.contact.count({ where: { phoneE164: `+91${phone}` } })).toBe(0);
  });

  it("creates the task DONE when a later call already followed up", async () => {
    const rep = await t.loginDevice(uniqueEmail("rep"));
    const phone = randomMobile();
    const at = new Date(Date.now() - 2 * HOUR);
    await registerCall(rep.headers, phone, new Date(at.getTime() + HOUR));
    expect((await missed(rep.headers, [missedItem(phone, at)])).json().results[0]).toMatchObject({ ok: true, state: "DONE" });

    // An unanswered incoming call (0 s) is not a follow-up.
    const phone2 = randomMobile();
    await registerCall(rep.headers, phone2, new Date(at.getTime() + HOUR), "INCOMING", 0);
    expect((await missed(rep.headers, [missedItem(phone2, at)])).json().results[0]).toMatchObject({ state: "OPEN" });

    // A later WhatsApp counts too, and the task links to the existing contact.
    const phone3 = randomMobile();
    await activity(rep.headers, phone3, new Date(at.getTime() + HOUR), { type: "WHATSAPP" });
    const r3 = (await missed(rep.headers, [missedItem(phone3, at)])).json().results[0];
    expect(r3.state).toBe("DONE");
    const task = await t.db.followUpTask.findUniqueOrThrow({ where: { id: r3.id } });
    expect(task.contactId).not.toBeNull();
  });

  it("auto-closes open tasks on a later activity or call", async () => {
    const rep = await t.loginDevice(uniqueEmail("rep"));
    const phoneA = randomMobile();
    const phoneB = randomMobile();
    const at = new Date(Date.now() - 2 * HOUR);
    const [a, b] = (await missed(rep.headers, [missedItem(phoneA, at), missedItem(phoneB, at)])).json().results;
    expect([a.state, b.state]).toEqual(["OPEN", "OPEN"]);

    await activity(rep.headers, phoneA, new Date(), { outcome: "INTERESTED" });
    expect((await t.db.followUpTask.findUniqueOrThrow({ where: { id: a.id } })).state).toBe("DONE");

    // An earlier call does not close it; a later answered incoming one does.
    await registerCall(rep.headers, phoneB, new Date(at.getTime() - HOUR));
    expect((await t.db.followUpTask.findUniqueOrThrow({ where: { id: b.id } })).state).toBe("OPEN");
    await registerCall(rep.headers, phoneB, new Date(), "INCOMING", 45);
    const closed = await t.db.followUpTask.findUniqueOrThrow({ where: { id: b.id } });
    expect(closed.state).toBe("DONE");
    expect(closed.doneAt).not.toBeNull();
  });
});

describe("PATCH /followups/:taskId", () => {
  it("snoozes, completes and dismisses only the rep's own tasks", async () => {
    const email = uniqueEmail("rep");
    const rep = await t.loginDevice(email);
    const phone = randomMobile();
    const [r1, r2] = (
      await missed(rep.headers, [missedItem(phone, new Date(Date.now() - HOUR)), missedItem(phone, new Date(Date.now() - 2 * HOUR))])
    ).json().results;
    const patch = (headers: Headers, id: string, payload: Record<string, unknown>, prefix = "/v1") =>
      t.app.inject({ method: "PATCH", url: `${prefix}/followups/${id}`, headers, payload });

    expect((await patch(rep.headers, r1.id, { action: "snooze" })).statusCode).toBe(400);
    expect((await patch(rep.headers, r1.id, { action: "snooze", until: iso(new Date(Date.now() + 40 * 86400_000)) })).statusCode).toBe(400);
    const until = new Date(Date.now() + 2 * 86400_000);
    const snoozed = await patch(rep.headers, r1.id, { action: "snooze", until: iso(until) });
    expect(snoozed.statusCode).toBe(200);
    expect(snoozed.json()).toMatchObject({ key: `task:${r1.id}`, dueAt: iso(until), kind: "MISSED_CALL" });
    // Snoozed past today: not in today's list any more.
    expect((await today(rep.headers)).items.map((i: { taskId: string }) => i.taskId)).not.toContain(r1.id);

    const other = await t.loginDevice(uniqueEmail("rep"));
    expect((await patch(other.headers, r2.id, { action: "done" })).statusCode).toBe(404);

    const session = await t.sessionFor(email);
    expect((await patch(session, r2.id, { action: "done" }, "/api")).statusCode).toBe(200);
    expect((await t.db.followUpTask.findUniqueOrThrow({ where: { id: r2.id } })).state).toBe("DONE");
    expect((await patch(rep.headers, r1.id, { action: "dismiss" })).statusCode).toBe(200);
    expect((await t.db.followUpTask.findUniqueOrThrow({ where: { id: r1.id } })).state).toBe("DISMISSED");

    // A closed task stays closed: snooze 409s, a late done does not overwrite the dismiss.
    const closed = await t.db.followUpTask.findUniqueOrThrow({ where: { id: r1.id } });
    expect((await patch(rep.headers, r1.id, { action: "snooze", until: iso(until) })).statusCode).toBe(409);
    expect((await patch(rep.headers, r1.id, { action: "done" })).statusCode).toBe(200);
    const after = await t.db.followUpTask.findUniqueOrThrow({ where: { id: r1.id } });
    expect(after).toMatchObject({ state: "DISMISSED", doneAt: closed.doneAt, dueAt: closed.dueAt });
  });
});

describe("missed call on another rep's contact", () => {
  it("does not link or expose a contact outside the rep's scope", async () => {
    const a = await t.loginDevice(uniqueEmail("rep"));
    const b = await t.loginDevice(uniqueEmail("rep"));
    const phone = randomMobile();
    expect((await activity(b.headers, phone, new Date(Date.now() - 3 * HOUR), { name: "Secret Name", note: "private note" })).statusCode).toBe(200);
    const [r] = (await missed(a.headers, [missedItem(phone, new Date(Date.now() - HOUR), { callerName: "Caller" })])).json().results;
    expect((await t.db.followUpTask.findUniqueOrThrow({ where: { id: r.id } })).contactId).toBeNull();
    const item = (await today(a.headers)).items.find((i: { taskId: string }) => i.taskId === r.id);
    expect(item).toMatchObject({ contactId: null, name: "Caller", company: null, status: null, lastNote: null });
  });
});

describe("followUpsToday", () => {
  it("buckets contact follow-ups around the IST day boundary", async () => {
    const rep = await t.loginDevice(uniqueEmail("rep"));
    // 2026-11-18 20:00 UTC = 2026-11-19 01:30 IST; today in IST runs 18:30Z .. next 18:30Z.
    const now = new Date("2026-11-18T20:00:00Z");
    const { start, end } = istDay(now);
    const mk = async (followUp: Date, note?: string) => {
      const phone = randomMobile();
      await activity(rep.headers, phone, new Date(now.getTime() - 3 * 86400_000), { outcome: "CALL_BACK", followUpAt: iso(followUp), note });
      return `+91${phone}`;
    };
    const overdue = await mk(new Date(start.getTime() - 60_000), "asked for pricing");
    const dueToday = await mk(new Date(start.getTime() + 60_000));
    const tomorrow = await mk(new Date(end.getTime() + 60_000));
    const later = await mk(new Date(end.getTime() + 2 * 86400_000));

    const r = await followUpsToday({ db: t.db, config: t.config } as never, rep.user.id, now);
    const byPhone = (list: { phoneE164: string }[], p: string) => list.find((i) => i.phoneE164 === p);
    expect(byPhone(r.items, overdue)).toMatchObject({ kind: "FOLLOW_UP", overdue: true, lastNote: "asked for pricing", status: "CALL_BACK" });
    expect(byPhone(r.items, dueToday)).toMatchObject({ overdue: false });
    expect(byPhone(r.items, tomorrow)).toBeUndefined();
    expect(byPhone(r.upcoming, tomorrow)).toBeDefined();
    expect(byPhone(r.upcoming, later)).toBeUndefined();
    expect(r.counts).toEqual({ overdue: 1, today: 1 });
    expect(r.items.map((i) => i.phoneE164)).toEqual([overdue, dueToday]);
  });

  it("is served on the dashboard for the signed-in user", async () => {
    const email = uniqueEmail("rep");
    await t.loginDevice(email);
    const res = await t.app.inject({ method: "GET", url: "/api/followups/today", headers: await t.sessionFor(email) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], upcoming: [], counts: { overdue: 0, today: 0 } });
  });
});

describe("phone status", () => {
  it("reports online, offline and no phone", async () => {
    const email = uniqueEmail("rep");
    await t.db.user.create({ data: { email } });
    const session = await t.sessionFor(email);
    const get = async () => (await t.app.inject({ method: "GET", url: "/api/me/phone", headers: session })).json();
    expect(await get()).toEqual({ lastSeenAt: null, online: false, model: null, appVersion: null });

    const rep = await t.loginDevice(email);
    const now = new Date();
    const seen = new Date(now.getTime() - 2 * 60_000);
    await t.db.device.updateMany({ where: { userId: rep.user.id }, data: { lastSeenAt: seen, appVersion: "1.2.3" } });
    expect(await get()).toMatchObject({ online: true, lastSeenAt: iso(seen), model: "Test", appVersion: "1.2.3" });

    const deps = { db: t.db, config: t.config } as never;
    expect((await phoneStatus(deps, rep.user.id, new Date(seen.getTime() + PHONE_ONLINE_MS + 1))).online).toBe(false);
    await t.db.device.updateMany({ where: { userId: rep.user.id }, data: { revokedAt: now } });
    expect((await get()).lastSeenAt).toBeNull();
  });
});
