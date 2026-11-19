import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireDevice, requireSession } from "../auth/guards.js";
import { HttpError, currentUser, type Deps } from "../context.js";
import type { Prisma, User } from "../generated/prisma/client.js";
import { ContactFilter, dashContactWhere, listOrder } from "../activity/contacts.js";
import { listableScope } from "../activity/service.js";
import {
  addItems,
  itemDtos,
  itemInclude,
  listInclude,
  listScope,
  listSummaries,
  nextItem,
  releaseList,
  scriptDto,
  skipItem,
} from "../lists/service.js";
import { checkAssignable } from "./activity.js";
import { audit } from "../audit.js";

const MAX_LIST_CONTACTS = 20_000;
const STATES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;
const ITEM_STATES = ["PENDING", "IN_PROGRESS", "DONE", "SKIPPED", "REMOVED"] as const;

const param = (req: FastifyRequest, name: string) => z.uuid().parse((req.params as Record<string, string>)[name]);

const ListFilter = ContactFilter.omit({ due: true });
const CreateList = z.object({
  name: z.string().trim().min(1).max(120),
  scriptId: z.uuid().nullable().optional(),
  assigneeIds: z.array(z.uuid()).min(1).max(50),
  contactIds: z.array(z.uuid()).max(MAX_LIST_CONTACTS).optional(),
  filter: ListFilter.optional(),
});
const PatchList = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  scriptId: z.uuid().nullable().optional(),
  state: z.enum(STATES).optional(),
  assigneeIds: z.array(z.uuid()).min(1).max(50).optional(),
});
const AddItemsBody = z.object({ contactIds: z.array(z.uuid()).max(MAX_LIST_CONTACTS).optional(), filter: ListFilter.optional() });
const ItemsQuery = z.object({
  state: z.enum(ITEM_STATES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Contact ids for a list source, in order: explicit ids (intersected with scope) or a contacts filter. */
async function sourceIds(deps: Deps, user: User, body: { contactIds?: string[] | undefined; filter?: z.infer<typeof ListFilter> | undefined }) {
  if (!!body.contactIds === !!body.filter) throw new HttpError(400, "Give exactly one of contactIds and filter");
  if (body.contactIds) {
    const allowed = new Set<string>();
    const unique = [...new Set(body.contactIds)];
    for (let i = 0; i < unique.length; i += 1000) {
      const rows = await deps.db.contact.findMany({
        where: { AND: [{ id: { in: unique.slice(i, i + 1000) } }, listableScope(user)] },
        select: { id: true },
      });
      for (const r of rows) allowed.add(r.id);
    }
    // Repeats are kept so addItems counts them as duplicates.
    return body.contactIds.filter((id) => allowed.has(id));
  }
  const where = await dashContactWhere(deps.db, user, body.filter!);
  const rows = await deps.db.contact.findMany({ where, orderBy: listOrder, take: MAX_LIST_CONTACTS, select: { id: true } });
  return rows.map((r) => r.id);
}

async function checkAssignees(deps: Deps, user: User, ids: string[]) {
  for (const id of new Set(ids)) await checkAssignable(deps, user, id);
}

async function checkScript(deps: Deps, scriptId: string | null | undefined) {
  if (scriptId && !(await deps.db.callScript.findUnique({ where: { id: scriptId }, select: { id: true } }))) {
    throw new HttpError(400, "Unknown script");
  }
}

/** Stage 2 call lists: managers build and watch them; assigned reps work them (phone /v1 and dashboard /api/my). */
export async function listRoutes(app: FastifyInstance, deps: Deps) {
  const device = { preHandler: requireDevice(deps) };
  const anyone = { preHandler: requireSession(deps) };
  const managers = { preHandler: requireSession(deps, ["ADMIN", "MANAGER"]) };
  const isManager = (u: User) => u.role === "ADMIN" || u.role === "MANAGER";

  const managedList = async (user: User, id: string) => {
    const list = await deps.db.callList.findFirst({ where: { AND: [{ id }, listScope(user)] }, include: listInclude });
    if (!list) throw new HttpError(404, "Call list not found");
    return list;
  };
  const summaryOf = async (id: string) =>
    (await listSummaries(deps.db, [await deps.db.callList.findUniqueOrThrow({ where: { id }, include: listInclude })]))[0]!;

  // ---- Managers ----

  app.get("/api/call-lists", managers, async (req) => {
    const { state } = z.object({ state: z.enum(STATES).optional() }).parse(req.query);
    const lists = await deps.db.callList.findMany({
      where: { AND: [listScope(currentUser(req)), state ? { state } : { state: { not: "ARCHIVED" } }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: listInclude,
    });
    return { items: await listSummaries(deps.db, lists) };
  });

  app.post("/api/call-lists", { ...managers, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const user = currentUser(req);
    const body = CreateList.parse(req.body);
    await checkAssignees(deps, user, body.assigneeIds);
    await checkScript(deps, body.scriptId);
    const ids = await sourceIds(deps, user, body);
    const list = await deps.db.callList.create({
      data: {
        name: body.name,
        scriptId: body.scriptId ?? null,
        createdById: user.id,
        assignees: { create: [...new Set(body.assigneeIds)].map((userId) => ({ userId })) },
      },
    });
    const counts = await addItems(deps.db, list.id, ids);
    await audit(deps, req, "CALL_LIST_CHANGE", { created: list.id, name: list.name, ...counts });
    return reply.code(201).send({ ...(await summaryOf(list.id)), ...counts });
  });

  /** Managers (in scope) or an assignee. Items paged by position. */
  app.get("/api/call-lists/:id", anyone, async (req) => {
    const user = currentUser(req);
    const id = param(req, "id");
    const list = await deps.db.callList.findFirst({
      where: {
        AND: [{ id }, isManager(user) ? { OR: [listScope(user), { assignees: { some: { userId: user.id } } }] } : { assignees: { some: { userId: user.id } } }],
      },
      include: listInclude,
    });
    if (!list) throw new HttpError(404, "Call list not found");
    const q = ItemsQuery.parse(req.query);
    let after: { position: number; id: string } | undefined;
    if (q.cursor) {
      const c = await deps.db.callListItem.findFirst({ where: { id: q.cursor, listId: id }, select: { position: true, id: true } });
      if (c) after = c;
    }
    const rows = await deps.db.callListItem.findMany({
      where: {
        listId: id,
        ...(q.state ? { state: q.state } : {}),
        ...(after ? { OR: [{ position: { gt: after.position } }, { position: after.position, id: { gt: after.id } }] } : {}),
      },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: q.limit + 1,
      include: itemInclude,
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return {
      list: (await listSummaries(deps.db, [list]))[0],
      items: await itemDtos(deps.db, items),
      nextCursor: more ? items.at(-1)!.id : null,
    };
  });

  app.patch("/api/call-lists/:id", managers, async (req) => {
    const user = currentUser(req);
    const list = await managedList(user, param(req, "id"));
    const body = PatchList.parse(req.body);
    if (body.assigneeIds) await checkAssignees(deps, user, body.assigneeIds);
    await checkScript(deps, body.scriptId);
    await deps.db.$transaction(async (tx) => {
      await tx.callList.update({ where: { id: list.id }, data: { name: body.name, scriptId: body.scriptId, state: body.state } });
      if (body.assigneeIds) {
        const keep = [...new Set(body.assigneeIds)];
        await tx.callListAssignee.deleteMany({ where: { listId: list.id, userId: { notIn: keep } } });
        await tx.callListAssignee.createMany({ data: keep.map((userId) => ({ listId: list.id, userId })), skipDuplicates: true });
        // A rep taken off the list lets go of what they held.
        await tx.callListItem.updateMany({
          where: { listId: list.id, state: "IN_PROGRESS", claimedById: { notIn: keep } },
          data: { state: "PENDING", claimedById: null, leaseUntil: null },
        });
      }
    });
    await audit(deps, req, "CALL_LIST_CHANGE", { listId: list.id, ...body });
    return summaryOf(list.id);
  });

  app.post("/api/call-lists/:id/items", { ...managers, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const user = currentUser(req);
    const list = await managedList(user, param(req, "id"));
    const body = AddItemsBody.parse(req.body);
    const counts = await addItems(deps.db, list.id, await sourceIds(deps, user, body));
    await audit(deps, req, "CALL_LIST_CHANGE", { listId: list.id, ...counts });
    return counts;
  });

  app.delete("/api/call-lists/:id/items/:itemId", managers, async (req, reply) => {
    const list = await managedList(currentUser(req), param(req, "id"));
    const itemId = param(req, "itemId");
    const r = await deps.db.callListItem.updateMany({
      where: { id: itemId, listId: list.id },
      data: { state: "REMOVED", claimedById: null, leaseUntil: null, doneById: currentUser(req).id, doneAt: new Date() },
    });
    if (r.count === 0) throw new HttpError(404, "Item not found");
    await audit(deps, req, "CALL_LIST_CHANGE", { listId: list.id, removedItem: itemId });
    return reply.code(204).send();
  });

  app.post("/api/call-lists/:id/items/:itemId/reset", managers, async (req) => {
    const list = await managedList(currentUser(req), param(req, "id"));
    const itemId = param(req, "itemId");
    const r = await deps.db.callListItem.updateMany({
      where: { id: itemId, listId: list.id },
      data: { state: "PENDING", claimedById: null, leaseUntil: null, retryAt: null, doneById: null, doneAt: null },
    });
    if (r.count === 0) throw new HttpError(404, "Item not found");
    await audit(deps, req, "CALL_LIST_CHANGE", { listId: list.id, resetItem: itemId });
    const row = await deps.db.callListItem.findUniqueOrThrow({ where: { id: itemId }, include: itemInclude });
    return (await itemDtos(deps.db, [row]))[0];
  });

  // ---- Rep session (same handlers for the phone and the dashboard) ----

  const myLists = async (userId: string) => {
    const lists = await deps.db.callList.findMany({
      where: { state: { in: ["ACTIVE", "PAUSED"] }, assignees: { some: { userId } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { ...listInclude, script: true, createdBy: { select: { id: true, name: true, email: true } } },
    });
    const summaries = await listSummaries(deps.db, lists.map((l) => ({ ...l, script: l.script ? { id: l.script.id, name: l.script.name } : null })));
    return {
      items: summaries.map(({ assignees: _a, ...s }, i) => {
        const l = lists[i]!;
        return { ...s, script: l.script ? scriptDto(l.script) : null, createdBy: l.createdBy };
      }),
    };
  };

  for (const [prefix, guard] of [
    ["/v1/call-lists", device],
    ["/api/my/call-lists", anyone],
  ] as const) {
    app.get(prefix, guard, async (req) => myLists(currentUser(req).id));
    app.post(`${prefix}/:id/next`, guard, async (req) => nextItem(deps, currentUser(req).id, param(req, "id")));
    app.post(`${prefix}/:id/release`, guard, async (req, reply) => {
      await releaseList(deps, currentUser(req).id, param(req, "id"));
      return reply.code(204).send();
    });
  }
  app.post("/v1/call-lists/items/:itemId/skip", device, async (req) => skipItem(deps, currentUser(req).id, param(req, "itemId")));
  app.post("/api/my/call-list-items/:itemId/skip", anyone, async (req) => skipItem(deps, currentUser(req).id, param(req, "itemId")));
}
