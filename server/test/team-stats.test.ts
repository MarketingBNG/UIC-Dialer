import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { istDay } from "../src/activity/service.js";
import { daysBetween, rangeBounds } from "../src/activity/stats.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let mgr: Record<string, string>;
let a: Awaited<ReturnType<typeof t.loginDevice>>;
let bId: string;
const DAY = 24 * 3600_000;
const randomMobile = () => `+919${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

beforeAll(async () => {
  t = await setupTestApp();
  const team = `stats-${randomUUID().slice(0, 6)}`;
  const mgrEmail = uniqueEmail("smgr");
  await t.db.user.create({ data: { email: mgrEmail, role: "MANAGER", team } });
  mgr = await t.sessionFor(mgrEmail);
  a = await t.loginDevice(uniqueEmail("sa"), "AGENT", team);
  await t.db.user.update({ where: { id: a.user.id }, data: { name: "Asha", targetCallsPerDay: 8, targetTalkMinPerDay: 2 } });
  bId = (await t.db.user.create({ data: { email: uniqueEmail("sb"), name: "Bina", team } })).id;

  const { start } = istDay();
  // Inside today (IST) and not in the future, even right after midnight.
  const today = (msAgo: number) => new Date(Math.max(start.getTime() + 1000, Date.now() - msAgo));
  const contact = (ownerId: string, extra: object = {}) => t.db.contact.create({ data: { phoneE164: randomMobile(), ownerId, ...extra } });
  const act = (userId: string, contactId: string, data: object) =>
    t.db.activity.create({ data: { clientId: randomUUID(), userId, contactId, type: "CALL", occurredAt: today(60_000), ...data } });

  const y = await contact(a.user.id);
  // Earlier follow-up on Y (a NOTE two days ago, due now), answered by today's first call.
  await act(a.user.id, y.id, { type: "NOTE", occurredAt: new Date(start.getTime() - 2 * DAY), followUpAt: new Date() });
  await act(a.user.id, y.id, { durationS: 60, outcome: "INTERESTED", occurredAt: today(50 * 60_000) });
  const z = await contact(a.user.id);
  await act(a.user.id, z.id, { durationS: 0, outcome: "INTERESTED", occurredAt: today(40 * 60_000) });
  await act(a.user.id, z.id, { outcome: "NO_ANSWER", occurredAt: today(30 * 60_000) });
  await act(a.user.id, z.id, { outcome: "INTERESTED", occurredAt: today(20 * 60_000) });
  await act(a.user.id, z.id, { type: "WHATSAPP", occurredAt: today(10 * 60_000) });
  // Three days ago: only in the 7d / 30d ranges.
  await act(a.user.id, z.id, { durationS: 30, outcome: "INTERESTED", occurredAt: new Date(start.getTime() - 3 * DAY + 3600_000) });
  // Overdue: an owned contact due yesterday and an open task due yesterday.
  await contact(a.user.id, { nextFollowUpAt: new Date(start.getTime() - 3600_000) });
  await t.db.followUpTask.create({
    data: { clientId: `missed:${randomUUID()}`, userId: a.user.id, phoneE164: randomMobile(), occurredAt: new Date(start.getTime() - DAY), dueAt: new Date(start.getTime() - DAY) },
  });

  const w = await contact(bId);
  await act(bId, w.id, { durationS: 120, outcome: "CALL_BACK", occurredAt: today(5 * 60_000) });
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const stats = async (qs = "") => {
  const res = await t.app.inject({ method: "GET", url: `/api/team/stats${qs}`, headers: mgr });
  expect(res.statusCode).toBe(200);
  return res.json();
};

describe("ranges", () => {
  it("today / 7d / 30d in IST days", () => {
    const now = new Date("2026-11-18T10:00:00Z");
    expect(rangeBounds("today", now)).toEqual({ from: new Date("2026-11-17T18:30:00Z"), to: new Date("2026-11-18T18:30:00Z"), days: 1 });
    expect(rangeBounds("7d", now).from).toEqual(new Date("2026-11-11T18:30:00Z"));
    expect(rangeBounds("30d", now)).toMatchObject({ from: new Date("2026-10-19T18:30:00Z"), days: 30 });
    expect(daysBetween(new Date("2026-11-17T18:30:00Z"), new Date("2026-11-18T18:30:00Z"))).toBe(1);
  });
});

describe("GET /api/team/stats", () => {
  it("today: calls, connected, talk time, connect rate, first/last call, follow-ups, targets, leaderboard", async () => {
    const s = await stats();
    expect(s.days).toBe(1);
    expect(s.items).toHaveLength(3); // the manager, Asha, Bina (team scope)
    const asha = s.items.find((i: { user: { id: string } }) => i.user.id === a.user.id);
    expect(asha).toMatchObject({
      calls: 4,
      connected: 2,
      talkTimeS: 60,
      connectRate: 0.5,
      messages: 1,
      followUpsDone: 1,
      followUpsOverdue: 2,
      target: { callsPerDay: 8, talkMinPerDay: 2 },
      vsTarget: { callsPct: 50, talkPct: 50 },
    });
    expect(new Date(asha.firstCallAt).getTime()).toBeLessThanOrEqual(new Date(asha.lastCallAt).getTime());
    const bina = s.items.find((i: { user: { id: string } }) => i.user.id === bId);
    expect(bina).toMatchObject({ calls: 1, connected: 1, talkTimeS: 120, connectRate: 1, vsTarget: { callsPct: null, talkPct: null } });
    expect(s.totals).toMatchObject({ calls: 5, connected: 3, talkTimeS: 180, connectRate: 0.6, messages: 1, followUpsDone: 1, followUpsOverdue: 2 });
    expect(s.leaderboard.slice(0, 2)).toEqual([
      { userId: a.user.id, rank: 1, calls: 4, connected: 2, talkTimeS: 60 },
      { userId: bId, rank: 2, calls: 1, connected: 1, talkTimeS: 120 },
    ]);
  });

  it("7d and 30d include older calls and scale the target by days", async () => {
    const week = await stats("?range=7d");
    expect(week.days).toBe(7);
    const asha = week.items.find((i: { user: { id: string } }) => i.user.id === a.user.id);
    expect(asha).toMatchObject({ calls: 5, connected: 3, talkTimeS: 90, vsTarget: { callsPct: Math.round((100 * 5) / 56) } });
    expect((await stats("?range=30d")).days).toBe(30);
    const { start, end } = istDay();
    const explicit = await stats(`?from=${start.toISOString()}&to=${end.toISOString()}&range=30d`);
    expect(explicit.days).toBe(1);
  });

  it("is managers only", async () => {
    expect((await t.app.inject({ method: "GET", url: "/api/team/stats", headers: a.headers })).statusCode).toBe(403);
  });
});

describe("me/today and targets", () => {
  it("returns the caller's numbers with uncapped percentages", async () => {
    const res = await t.app.inject({ method: "GET", url: "/v1/me/today", headers: a.headers });
    expect(res.json()).toEqual({
      calls: 4,
      connected: 2,
      talkTimeS: 60,
      messages: 1,
      target: { callsPerDay: 8, talkMinPerDay: 2 },
      progress: { callsPct: 50, talkPct: 50 },
    });
    expect((await t.app.inject({ method: "GET", url: "/api/me/today", headers: a.headers })).json().calls).toBe(4);
  });

  it("admins set targets one by one and in bulk (audited)", async () => {
    const adminEmail = uniqueEmail("sadmin");
    await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
    const h = await t.sessionFor(adminEmail);
    const one = await t.app.inject({ method: "PATCH", url: `/api/users/${bId}`, headers: h, payload: { targetCallsPerDay: 1 } });
    expect(one.json()).toMatchObject({ targetCallsPerDay: 1 });
    expect((await t.app.inject({ method: "PATCH", url: `/api/users/${bId}`, headers: h, payload: { targetCallsPerDay: 1001 } })).statusCode).toBe(400);
    const bulk = await t.app.inject({ method: "PUT", url: "/api/targets", headers: h, payload: { userIds: [bId, a.user.id], targetTalkMinPerDay: 30 } });
    expect(bulk.json()).toEqual({ updated: 2 });
    const users = (await t.app.inject({ method: "GET", url: "/api/users", headers: h })).json();
    expect(users.find((u: { id: string }) => u.id === bId)).toMatchObject({ targetCallsPerDay: 1, targetTalkMinPerDay: 30 });
    const bina = (await stats()).items.find((i: { user: { id: string } }) => i.user.id === bId);
    expect(bina.vsTarget.callsPct).toBe(100);
    expect(await t.db.auditLog.count({ where: { action: "TARGET_CHANGE", detail: { path: ["userId"], equals: bId } } })).toBe(1);
    // Restore so the other tests' numbers stay the same if this file is re-ordered.
    await t.db.user.update({ where: { id: a.user.id }, data: { targetTalkMinPerDay: 2 } });
  });
});
