import type { Deps } from "../context.js";
import { Prisma } from "../generated/prisma/client.js";
import { istDay } from "./service.js";
import { directionCounts, type DirectionCounts } from "./live.js";

const DAY_MS = 24 * 3600 * 1000;

export type StatsRange = "today" | "7d" | "30d";

/** today = the IST day; 7d / 30d = IST start of the day 6 / 29 days ago until the end of today. */
export function rangeBounds(range: StatsRange, now = new Date()): { from: Date; to: Date; days: number } {
  const { start, end } = istDay(now);
  const days = range === "30d" ? 30 : range === "7d" ? 7 : 1;
  return { from: new Date(start.getTime() - (days - 1) * DAY_MS), to: end, days };
}

/** Explicit from/to: the number of IST days it touches (at least 1). */
export function daysBetween(from: Date, to: Date): number {
  const first = istDay(from).start.getTime();
  const last = istDay(new Date(to.getTime() - 1)).start.getTime();
  return Math.max(1, Math.round((last - first) / DAY_MS) + 1);
}

/**
 * Same definitions as /api/activity/reps: a call is "connected" when its call-log duration is > 0, or, without a
 * duration, when it has an outcome other than NO_ANSWER.
 */
export const isConnected = (a: { durationS: number | null; outcome: string | null }) =>
  a.durationS != null ? a.durationS > 0 : a.outcome !== null && a.outcome !== "NO_ANSWER";

export interface RepNumbers {
  calls: number;
  connected: number;
  talkTimeS: number;
  connectRate: number | null;
  firstCallAt: Date | null;
  lastCallAt: Date | null;
  messages: number;
}

/** Calls / connected / talk time / messages per user over [from, to). */
export async function activityNumbers(db: Deps["db"], userIds: string[], from: Date, to: Date): Promise<Map<string, RepNumbers>> {
  const acts = userIds.length
    ? await db.activity.findMany({
        where: { userId: { in: userIds }, type: { in: ["CALL", "WHATSAPP"] }, occurredAt: { gte: from, lt: to } },
        select: { userId: true, type: true, outcome: true, durationS: true, occurredAt: true },
      })
    : [];
  const out = new Map<string, RepNumbers>();
  for (const id of userIds) {
    out.set(id, { calls: 0, connected: 0, talkTimeS: 0, connectRate: null, firstCallAt: null, lastCallAt: null, messages: 0 });
  }
  for (const a of acts) {
    const n = out.get(a.userId)!;
    if (a.type === "WHATSAPP") {
      n.messages++;
      continue;
    }
    n.calls++;
    if (isConnected(a)) n.connected++;
    n.talkTimeS += a.durationS ?? 0;
    if (!n.firstCallAt || a.occurredAt < n.firstCallAt) n.firstCallAt = a.occurredAt;
    if (!n.lastCallAt || a.occurredAt > n.lastCallAt) n.lastCallAt = a.occurredAt;
  }
  for (const n of out.values()) n.connectRate = rate(n.connected, n.calls);
  return out;
}

export const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) / 100 : null);

/**
 * followUpsDone: CALL / WHATSAPP activities in the range that answered an open, due follow-up: the contact's
 * activity just before this one (any rep, nothing in between) set a follow-up date no later than one day after this
 * activity. Once answered, the follow-up is closed, so later calls on the contact don't count again. One SQL query.
 */
export async function followUpsDone(db: Deps["db"], userIds: string[], from: Date, to: Date): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ user_id: string; n: bigint }[]>`
    SELECT a."user_id", count(*) AS "n" FROM "activities" a
    WHERE a."user_id" = ANY(${userIds}::uuid[]) AND a."type" IN ('CALL', 'WHATSAPP')
      AND a."occurred_at" >= ${from} AND a."occurred_at" < ${to}
      AND EXISTS (
        SELECT 1 FROM "activities" p
        WHERE p."contact_id" = a."contact_id" AND p."occurred_at" < a."occurred_at"
          AND p."follow_up_at" IS NOT NULL AND p."follow_up_at" <= a."occurred_at" + interval '1 day'
          AND NOT EXISTS (
            SELECT 1 FROM "activities" q
            WHERE q."contact_id" = a."contact_id" AND q."occurred_at" > p."occurred_at" AND q."occurred_at" < a."occurred_at"))
    GROUP BY a."user_id"`;
  return new Map(rows.map((r) => [r.user_id, Number(r.n)]));
}

/** As of now: owned contacts whose follow-up was due before today (IST) + open follow-up tasks due before today. */
export async function followUpsOverdue(db: Deps["db"], userIds: string[], now = new Date()): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const { start } = istDay(now);
  const [contacts, tasks] = await Promise.all([
    db.contact.groupBy({ by: ["ownerId"], where: { ownerId: { in: userIds }, nextFollowUpAt: { lt: start } }, _count: { _all: true } }),
    db.followUpTask.groupBy({ by: ["userId"], where: { userId: { in: userIds }, state: "OPEN", dueAt: { lt: start } }, _count: { _all: true } }),
  ]);
  const out = new Map<string, number>();
  for (const c of contacts) if (c.ownerId) out.set(c.ownerId, (out.get(c.ownerId) ?? 0) + c._count._all);
  for (const t of tasks) out.set(t.userId, (out.get(t.userId) ?? 0) + t._count._all);
  return out;
}

export const pct = (value: number, target: number | null, days: number) =>
  target && target > 0 ? Math.round((100 * value) / (target * days)) : null;

/** Recorded / logged calls (calls table) per user over [from, to), by direction. */
export async function callDirections(db: Deps["db"], userIds: string[], from: Date, to: Date): Promise<Map<string, DirectionCounts>> {
  const rows = userIds.length
    ? await db.call.groupBy({
        by: ["userId", "direction"],
        where: { userId: { in: userIds }, startedAt: { gte: from, lt: to } },
        _count: { _all: true },
      })
    : [];
  return directionCounts(rows.map((r) => ({ userId: r.userId, direction: r.direction, n: r._count._all })), userIds);
}

/** GET /api/team/stats (§8). */
export async function teamStats(
  db: Deps["db"],
  where: Prisma.UserWhereInput,
  from: Date,
  to: Date,
  days: number,
) {
  const users = await db.user.findMany({
    where: { AND: [{ active: true }, where] },
    select: { id: true, name: true, email: true, targetCallsPerDay: true, targetTalkMinPerDay: true },
    orderBy: [{ name: "asc" }, { email: "asc" }],
  });
  const ids = users.map((u) => u.id);
  const [nums, done, overdue, dirs] = await Promise.all([
    activityNumbers(db, ids, from, to),
    followUpsDone(db, ids, from, to),
    followUpsOverdue(db, ids),
    callDirections(db, ids, from, to),
  ]);
  const items = users.map((u) => {
    const n = nums.get(u.id)!;
    return {
      user: { id: u.id, name: u.name, email: u.email },
      ...n,
      ...dirs.get(u.id)!,
      followUpsDone: done.get(u.id) ?? 0,
      followUpsOverdue: overdue.get(u.id) ?? 0,
      target: { callsPerDay: u.targetCallsPerDay, talkMinPerDay: u.targetTalkMinPerDay },
      vsTarget: { callsPct: pct(n.calls, u.targetCallsPerDay, days), talkPct: pct(n.talkTimeS / 60, u.targetTalkMinPerDay, days) },
    };
  });
  const sum = (k: "calls" | "connected" | "talkTimeS" | "messages" | "followUpsDone" | "followUpsOverdue" | "outgoing" | "incoming" | "missed") =>
    items.reduce((s, i) => s + i[k], 0);
  const totals = {
    calls: sum("calls"),
    connected: sum("connected"),
    talkTimeS: sum("talkTimeS"),
    connectRate: rate(sum("connected"), sum("calls")),
    messages: sum("messages"),
    outgoing: sum("outgoing"),
    incoming: sum("incoming"),
    missed: sum("missed"),
    followUpsDone: sum("followUpsDone"),
    followUpsOverdue: sum("followUpsOverdue"),
  };
  const leaderboard = [...items]
    .sort((a, b) => b.connected - a.connected || b.talkTimeS - a.talkTimeS || b.calls - a.calls)
    .map((i, idx) => ({ userId: i.user.id, rank: idx + 1, calls: i.calls, connected: i.connected, talkTimeS: i.talkTimeS }));
  return { from, to, days, totals, items, leaderboard };
}

/** GET /v1/me/today and /api/me/today (§10): the caller's own IST-today numbers against their targets. */
export async function meToday(db: Deps["db"], user: { id: string; targetCallsPerDay: number | null; targetTalkMinPerDay: number | null }, now = new Date()) {
  const { start, end } = istDay(now);
  const n = (await activityNumbers(db, [user.id], start, end)).get(user.id)!;
  return {
    calls: n.calls,
    connected: n.connected,
    talkTimeS: n.talkTimeS,
    messages: n.messages,
    target: { callsPerDay: user.targetCallsPerDay, talkMinPerDay: user.targetTalkMinPerDay },
    progress: { callsPct: pct(n.calls, user.targetCallsPerDay, 1), talkPct: pct(n.talkTimeS / 60, user.targetTalkMinPerDay, 1) },
  };
}
