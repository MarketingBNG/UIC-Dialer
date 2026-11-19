import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireDevice, requireSession } from "../auth/guards.js";
import { HttpError, currentUser, type Deps } from "../context.js";
import type { Prisma } from "../generated/prisma/client.js";
import { MIN_KEY_DIGITS, hashKey, numberKey, parseClientCsv } from "../privacy/clientNumbers.js";
import { toE164 } from "../phone.js";
import { dncDto, dncInclude, upsertDnc } from "../activity/dnc.js";
import { audit } from "../audit.js";

const AddBody = z.object({ phone: z.string().trim().min(1).max(40), reason: z.string().trim().max(200).optional() });
const ListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Stage 3 do-not-call list. The server can't stop a SIM call: lists, leads and dial intents enforce it; phones warn. */
export async function dncRoutes(app: FastifyInstance, deps: Deps) {
  const device = { preHandler: requireDevice(deps) };
  const anyone = { preHandler: requireSession(deps) };
  const managers = { preHandler: requireSession(deps, ["ADMIN", "MANAGER"]) };
  const admins = { preHandler: requireSession(deps, ["ADMIN"]) };

  const add = async (req: FastifyRequest, reply: FastifyReply) => {
    const body = AddBody.parse(req.body);
    const key = numberKey(body.phone);
    if (key.length < MIN_KEY_DIGITS) throw new HttpError(400, `Enter a phone number with at least ${MIN_KEY_DIGITS} digits`);
    const { row, created } = await upsertDnc(deps.db, {
      raw: body.phone,
      phoneE164: toE164(body.phone, deps.config.DEFAULT_PHONE_REGION) ?? null,
      reason: body.reason || null,
      source: "MANUAL",
      createdById: currentUser(req).id,
    });
    if (created) await audit(deps, req, "DNC_CHANGE", { added: 1, key: row.key });
    const full = await deps.db.dncNumber.findUniqueOrThrow({ where: { id: row.id }, include: dncInclude });
    // 201 either way (upsert by key; an existing number keeps its first row).
    return reply.code(201).send(dncDto(full));
  };

  app.post("/api/dnc", anyone, add);
  app.post("/v1/dnc", device, add);

  app.get("/api/dnc", managers, async (req) => {
    const q = ListQuery.parse(req.query);
    const digits = q.q?.replace(/\D/g, "") ?? "";
    const where: Prisma.DncNumberWhereInput = q.q
      ? {
          OR: [
            { reason: { contains: q.q, mode: "insensitive" } },
            { raw: { contains: q.q, mode: "insensitive" } },
            ...(digits.length >= 3 ? [{ key: { contains: digits } }] : []),
          ],
        }
      : {};
    const [rows, count] = await Promise.all([
      deps.db.dncNumber.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: dncInclude,
      }),
      deps.db.dncNumber.count({ where }),
    ]);
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return { items: items.map(dncDto), nextCursor: more ? items.at(-1)!.id : null, count };
  });

  app.delete("/api/dnc/:id", managers, async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const row = await deps.db.dncNumber.findUnique({ where: { id } });
    if (!row) throw new HttpError(404, "Not found");
    await deps.db.dncNumber.delete({ where: { id } });
    await audit(deps, req, "DNC_CHANGE", { removed: 1, key: row.key });
    return reply.code(204).send();
  });

  /** One number per line, optional reason after the first comma (same parser as the client list). Existing rows kept. */
  app.post("/api/dnc/import", { ...admins, bodyLimit: 10 * 1024 * 1024 }, async (req) => {
    const { csv } = z.object({ csv: z.string().max(10 * 1024 * 1024) }).parse(req.body);
    const { rows, rejected } = parseClientCsv(csv);
    const userId = currentUser(req).id;
    let added = 0;
    let updated = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const existing = await deps.db.dncNumber.findMany({ where: { key: { in: chunk.map((r) => r.key) } }, select: { key: true, reason: true } });
      const have = new Map(existing.map((e) => [e.key, e]));
      const fresh = chunk.filter((r) => !have.has(r.key));
      if (fresh.length > 0) {
        added += (
          await deps.db.dncNumber.createMany({
            data: fresh.map((r) => ({
              key: r.key,
              raw: r.raw,
              phoneE164: toE164(r.raw, deps.config.DEFAULT_PHONE_REGION) ?? null,
              reason: r.label,
              source: "IMPORT" as const,
              createdById: userId,
            })),
            skipDuplicates: true,
          })
        ).count;
      }
      // A label on an existing number fills its reason when it has none.
      for (const r of chunk) {
        const e = have.get(r.key);
        if (e && r.label && !e.reason) {
          await deps.db.dncNumber.update({ where: { key: r.key }, data: { reason: r.label } });
          updated++;
        }
      }
    }
    await audit(deps, req, "DNC_CHANGE", { imported: added, updated, rejected: rejected.length });
    return { added, updated, rejected: rejected.length, rejectedSample: rejected.slice(0, 10) };
  });

  /** Same shape as /v1/device/client-numbers: sha256 of each key; ETag = sha256 of the sorted keys (304 when unchanged). */
  app.get("/v1/dnc/hashes", device, async (req, reply) => {
    const rows = await deps.db.dncNumber.findMany({ select: { key: true }, orderBy: { key: "asc" } });
    const etag = `"${createHash("sha256").update(rows.map((r) => r.key).join(",")).digest("hex")}"`;
    reply.header("etag", etag);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    return { hashes: rows.map((r) => hashKey(r.key)) };
  });
}
