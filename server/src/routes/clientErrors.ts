import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { describeClient, requireSession } from "../auth/guards.js";
import { currentUser, type Deps } from "../context.js";

const KEEP_DAYS = 30;
const Body = z.object({
  kind: z.string().trim().min(1).max(60),
  message: z.string().trim().max(2000).default(""),
});
const ListQuery = z.object({ days: z.coerce.number().int().min(1).max(KEEP_DAYS).default(7) });

// Old rows are pruned on insert, at most once an hour per instance (no extra job needed).
let lastPrune = 0;

/** Saves one problem from a phone / laptop / browser. Never throws: a failed report must not break the caller. */
export async function recordClientError(deps: Deps, req: FastifyRequest, kind: string, message: string) {
  try {
    const user = currentUser(req);
    const source = req.device ? "android" : describeClient(req.headers["user-agent"]).kind === "desktop" ? "desktop" : "web";
    await deps.db.clientError.create({
      data: { userId: user.id, deviceId: req.device?.id ?? null, source, kind: kind.slice(0, 60), message: message.slice(0, 300) },
    });
    if (Date.now() - lastPrune > 3600_000) {
      lastPrune = Date.now();
      await deps.db.clientError.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * 86400_000) } } });
    }
  } catch (e) {
    req.log.warn({ err: e }, "could not save client error");
  }
}

/** Staff devices report problems here so admins see them on the Health page. */
export async function clientErrorRoutes(app: FastifyInstance, deps: Deps) {
  const anyone = { preHandler: requireSession(deps), config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
  const managers = { preHandler: requireSession(deps, ["ADMIN", "MANAGER"]) };

  app.post("/v1/client-errors", anyone, async (req, reply) => {
    const body = Body.parse(req.body);
    await recordClientError(deps, req, body.kind, body.message);
    return reply.code(201).send({ ok: true });
  });

  app.get("/api/client-errors", managers, async (req) => {
    const { days } = ListQuery.parse(req.query);
    const rows = await deps.db.clientError.findMany({
      where: { createdAt: { gte: new Date(Date.now() - days * 86400_000) } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const ids = [...new Set(rows.map((r) => r.userId))];
    const deviceIds = [...new Set(rows.flatMap((r) => (r.deviceId ? [r.deviceId] : [])))];
    const [users, devices] = await Promise.all([
      deps.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }),
      deps.db.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, model: true } }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const deviceById = new Map(devices.map((d) => [d.id, d]));
    return {
      items: rows.map((r) => {
        const u = userById.get(r.userId);
        const d = r.deviceId ? deviceById.get(r.deviceId) : undefined;
        return {
          id: r.id,
          user: { id: r.userId, name: u?.name ?? u?.email ?? "Unknown" },
          source: r.source,
          device: d?.model ?? null,
          kind: r.kind,
          message: r.message,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    };
  });
}
