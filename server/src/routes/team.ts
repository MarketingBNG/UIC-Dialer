import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireDevice, requireSession } from "../auth/guards.js";
import { HttpError, currentUser, type Deps } from "../context.js";
import { repUserScope } from "../activity/service.js";
import { daysBetween, meToday, rangeBounds, teamStats } from "../activity/stats.js";
import { queueScoreBackfill } from "../jobs/queue.js";
import { audit } from "../audit.js";

const StatsQuery = z.object({
  range: z.enum(["today", "7d", "30d"]).default("today"),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
export const TargetFields = {
  targetCallsPerDay: z.number().int().min(0).max(1000).nullable().optional(),
  targetTalkMinPerDay: z.number().int().min(0).max(1440).nullable().optional(),
};
const BulkTargets = z.object({ userIds: z.array(z.uuid()).min(1).max(1000), ...TargetFields });

/** Team dashboard, daily targets, the caller's own today numbers, feature flags, score backfill. */
export async function teamRoutes(app: FastifyInstance, deps: Deps) {
  const device = { preHandler: requireDevice(deps) };
  const anyone = { preHandler: requireSession(deps) };
  const managers = { preHandler: requireSession(deps, ["ADMIN", "MANAGER"]) };
  const admins = { preHandler: requireSession(deps, ["ADMIN"]) };

  app.get("/api/team/stats", managers, async (req) => {
    const q = StatsQuery.parse(req.query);
    let from: Date;
    let to: Date;
    let days: number;
    if (q.from || q.to) {
      const r = rangeBounds(q.range);
      from = q.from ? new Date(q.from) : r.from;
      to = q.to ? new Date(q.to) : r.to;
      if (to <= from) throw new HttpError(400, "to must be after from");
      days = daysBetween(from, to);
    } else {
      ({ from, to, days } = rangeBounds(q.range));
    }
    const stats = await teamStats(deps.db, repUserScope(currentUser(req)), from, to, days);
    // Live status: ringing / on a call (phone reports), phone app connected now, phone last seen.
    const ids = stats.items.map((i) => i.user.id);
    const devices = ids.length
      ? await deps.db.device.groupBy({ by: ["userId"], where: { userId: { in: ids }, revokedAt: null }, _max: { lastSeenAt: true } })
      : [];
    const seen = new Map(devices.map((d) => [d.userId, d._max.lastSeenAt]));
    const rt = app.realtime;
    const items = stats.items.map((i) => {
      const live = rt?.live.get(i.user.id) ?? null;
      return {
        ...i,
        live: {
          state: live?.state ?? null,
          since: live?.since ?? null,
          phoneOnline: (rt?.phonesFor(i.user.id) ?? 0) > 0,
          phoneLastSeenAt: seen.get(i.user.id) ?? null,
        },
      };
    });
    return { ...stats, items, now: new Date() };
  });

  app.get("/v1/me/today", device, async (req) => meToday(deps.db, currentUser(req)));
  app.get("/api/me/today", anyone, async (req) => meToday(deps.db, currentUser(req)));

  app.put("/api/targets", admins, async (req) => {
    const body = BulkTargets.parse(req.body);
    const data = { targetCallsPerDay: body.targetCallsPerDay, targetTalkMinPerDay: body.targetTalkMinPerDay };
    if (data.targetCallsPerDay === undefined && data.targetTalkMinPerDay === undefined) throw new HttpError(400, "Nothing to set");
    const r = await deps.db.user.updateMany({ where: { id: { in: body.userIds } }, data });
    await audit(deps, req, "TARGET_CHANGE", { userIds: body.userIds, ...data });
    return { updated: r.count };
  });

  /** What the UIs may show: AI scoring and summaries are switched on server-side (the worker also needs its key). */
  app.get("/api/features", anyone, async () => ({ scoring: deps.config.SCORE_ENABLED, summaries: deps.config.SUMMARIZE_ENABLED }));

  /** Queues an AI score for every summarized call without one (counts toward the Claude cap). */
  app.post("/api/admin/score-backfill", admins, async (req) => {
    const queued = await queueScoreBackfill(deps.db);
    req.log.info({ queued, by: currentUser(req).id }, "score backfill queued");
    return { queued };
  });
}
