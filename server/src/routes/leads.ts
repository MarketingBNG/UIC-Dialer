import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireSession } from "../auth/guards.js";
import { HttpError, type Deps } from "../context.js";
import { Prisma, type LeadSource } from "../generated/prisma/client.js";
import { toE164 } from "../phone.js";
import { type FieldMap, assignLead, extractLead, leadResultOf, leadTokenHash, newLeadToken } from "../leads/assign.js";
import { audit } from "../audit.js";

const idParam = (req: FastifyRequest) => z.uuid().parse((req.params as { id: string }).id);
const DAY_MS = 24 * 3600 * 1000;

const FieldMapBody = z
  .object({
    name: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(100).optional(),
    company: z.string().trim().max(100).optional(),
    city: z.string().trim().max(100).optional(),
    note: z.string().trim().max(100).optional(),
  })
  .transform((m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v)) as FieldMap);
const SourceBody = z.object({
  name: z.string().trim().min(1).max(60),
  repPool: z.array(z.uuid()).max(200).optional(),
  fieldMap: FieldMapBody.nullable().optional(),
  active: z.boolean().optional(),
});
const EventsQuery = z.object({
  sourceId: z.uuid().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Lead sources (admins) and the inbound lead webhook (token per source). */
export async function leadRoutes(app: FastifyInstance, deps: Deps) {
  const admins = { preHandler: requireSession(deps, ["ADMIN"]) };
  const webhookUrl = `${deps.config.PUBLIC_URL.replace(/\/$/, "")}/v1/leads/inbound`;

  const sourceDtos = async (rows: LeadSource[]) => {
    const poolIds = [...new Set(rows.flatMap((r) => r.repPool))];
    const users = poolIds.length
      ? await deps.db.user.findMany({ where: { id: { in: poolIds } }, select: { id: true, name: true, email: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const since = new Date(Date.now() - 7 * DAY_MS);
    const [counts, lasts] = await Promise.all([
      deps.db.leadEvent.groupBy({ by: ["sourceId"], where: { sourceId: { in: rows.map((r) => r.id) }, createdAt: { gte: since } }, _count: { _all: true } }),
      deps.db.leadEvent.groupBy({ by: ["sourceId"], where: { sourceId: { in: rows.map((r) => r.id) } }, _max: { createdAt: true } }),
    ]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active,
      repPool: r.repPool.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : [])),
      fieldMap: (r.fieldMap as FieldMap | null) ?? null,
      tokenHint: r.tokenHint,
      webhookUrl,
      createdAt: r.createdAt,
      stats: {
        last7d: counts.find((c) => c.sourceId === r.id)?._count._all ?? 0,
        lastAt: lasts.find((c) => c.sourceId === r.id)?._max.createdAt ?? null,
      },
    }));
  };
  const sourceDto = async (r: LeadSource) => (await sourceDtos([r]))[0]!;

  const checkPool = async (ids: string[] | undefined) => {
    if (!ids?.length) return;
    // Only active reps (AGENT / MANAGER) can take leads; the round-robin never falls back past an explicit pool.
    const found = await deps.db.user.count({ where: { id: { in: ids }, active: true, role: { in: ["AGENT", "MANAGER"] } } });
    if (found !== new Set(ids).size) throw new HttpError(400, "The rep pool may only hold active agents and managers");
  };

  app.get("/api/lead-sources", admins, async () => ({
    items: await sourceDtos(await deps.db.leadSource.findMany({ orderBy: { name: "asc" } })),
  }));

  app.post("/api/lead-sources", admins, async (req, reply) => {
    const body = SourceBody.parse(req.body);
    await checkPool(body.repPool);
    const token = newLeadToken();
    try {
      const s = await deps.db.leadSource.create({
        data: {
          name: body.name,
          tokenHash: leadTokenHash(token),
          tokenHint: token.slice(-4),
          active: body.active ?? true,
          repPool: [...new Set(body.repPool ?? [])],
          fieldMap: body.fieldMap ?? Prisma.DbNull,
        },
      });
      await audit(deps, req, "LEAD_SOURCE_CHANGE", { created: s.id, name: s.name });
      return reply.code(201).send({ ...(await sourceDto(s)), token });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new HttpError(409, "A lead source with this name exists");
      throw e;
    }
  });

  app.patch("/api/lead-sources/:id", admins, async (req) => {
    const id = idParam(req);
    const body = SourceBody.partial().parse(req.body);
    await checkPool(body.repPool);
    if (!(await deps.db.leadSource.findUnique({ where: { id }, select: { id: true } }))) throw new HttpError(404, "Lead source not found");
    try {
      const s = await deps.db.leadSource.update({
        where: { id },
        data: {
          name: body.name,
          active: body.active,
          repPool: body.repPool ? [...new Set(body.repPool)] : undefined,
          fieldMap: body.fieldMap === undefined ? undefined : (body.fieldMap ?? Prisma.DbNull),
        },
      });
      await audit(deps, req, "LEAD_SOURCE_CHANGE", { sourceId: id, fields: Object.keys(body) });
      return sourceDto(s);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new HttpError(409, "A lead source with this name exists");
      throw e;
    }
  });

  app.post("/api/lead-sources/:id/rotate", admins, async (req) => {
    const id = idParam(req);
    const token = newLeadToken();
    const r = await deps.db.leadSource.updateMany({ where: { id }, data: { tokenHash: leadTokenHash(token), tokenHint: token.slice(-4) } });
    if (r.count === 0) throw new HttpError(404, "Lead source not found");
    await audit(deps, req, "LEAD_SOURCE_CHANGE", { sourceId: id, rotated: true });
    return { ...(await sourceDto(await deps.db.leadSource.findUniqueOrThrow({ where: { id } }))), token };
  });

  app.get("/api/lead-events", admins, async (req) => {
    const q = EventsQuery.parse(req.query);
    const rows = await deps.db.leadEvent.findMany({
      where: q.sourceId ? { sourceId: q.sourceId } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: {
        source: { select: { id: true, name: true } },
        contact: { select: { id: true, name: true, phoneE164: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return {
      items: items.map((e) => ({
        id: e.id,
        source: e.source,
        externalId: e.externalId,
        contact: e.contact,
        assignedTo: e.assignedTo,
        status: e.status,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
      nextCursor: more ? items.at(-1)!.id : null,
    };
  });

  // ---- Webhook ----

  const tokenOf = (req: FastifyRequest) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
    const h = req.headers["x-uic-lead-token"];
    // No ?token= fallback: URLs end up in request and proxy logs, headers don't.
    return typeof h === "string" ? h.trim() : "";
  };

  /** Any JSON object (64 KB). Auth: Bearer or X-UIC-Lead-Token header. Repeats of (source, externalId) are idempotent. */
  app.post(
    "/v1/leads/inbound",
    { bodyLimit: 64 * 1024, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const token = tokenOf(req);
      const source = token ? await deps.db.leadSource.findUnique({ where: { tokenHash: leadTokenHash(token) } }) : null;
      if (!source?.active) throw new HttpError(401, "Bad lead token");
      // Fastify also parses text/plain; only JSON is accepted here.
      if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        throw new HttpError(415, "Send the lead as application/json");
      }
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new HttpError(400, "Body must be a JSON object");
      const body = req.body as Record<string, unknown>;
      const f = extractLead(body, (source.fieldMap as FieldMap | null) ?? null);
      const phoneE164 = toE164(f.phone, deps.config.DEFAULT_PHONE_REGION);
      if (f.externalId) {
        const prior = await deps.db.leadEvent.findUnique({ where: { sourceId_externalId: { sourceId: source.id, externalId: f.externalId } } });
        if (prior?.status === "INVALID") {
          // Not final: a retry with a usable phone (fixed payload or field map) replaces the rejected event.
          if (!phoneE164) return reply.code(400).send({ error: "No valid phone number in the lead" });
          await deps.db.leadEvent.deleteMany({ where: { id: prior.id, status: "INVALID" } });
        } else if (prior) return { ok: true, ...(await leadResultOf(deps, prior.id)) };
      }
      if (!phoneE164) {
        try {
          await deps.db.leadEvent.create({
            data: { sourceId: source.id, externalId: f.externalId ?? null, status: "INVALID", payload: body as Prisma.InputJsonValue },
          });
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
        }
        return reply.code(400).send({ error: "No valid phone number in the lead" });
      }
      try {
        const r = await assignLead(deps, source, { ...f, phoneE164 }, body);
        return { ok: true, ...r };
      } catch (e) {
        // The same lead posted twice at once: the first one's event answers.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          if (f.externalId) {
            const prior = await deps.db.leadEvent.findUnique({ where: { sourceId_externalId: { sourceId: source.id, externalId: f.externalId } } });
            if (prior) return { ok: true, ...(await leadResultOf(deps, prior.id)) };
          }
          // The same new number posted twice at once (no external id): the other request created the contact,
          // so a retry takes the existing-contact path.
          return { ok: true, ...(await assignLead(deps, source, { ...f, phoneE164 }, body)) };
        }
        throw e;
      }
    },
  );
}
