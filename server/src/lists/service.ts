import { HttpError, type Deps } from "../context.js";
import { Prisma, type User } from "../generated/prisma/client.js";
import { dncExistsSql, dncFor } from "../activity/dnc.js";
import { contactDto, contactInclude } from "../activity/service.js";
import { numberKey } from "../privacy/clientNumbers.js";

/** A claimed item is held this long; `next` from the same rep extends it. */
export const LEASE_MS = 15 * 60 * 1000;
const INSERT_CHUNK = 500;

const userRef = { select: { id: true, name: true, email: true } } as const;

export interface ListProgress {
  total: number;
  done: number;
  pending: number;
  inProgress: number;
  skipped: number;
  removed: number;
}
export interface ListResult {
  outcomeId: string | null;
  label: string;
  color: string;
  count: number;
}

const EMPTY_PROGRESS: ListProgress = { total: 0, done: 0, pending: 0, inProgress: 0, skipped: 0, removed: 0 };

/**
 * Progress per list: done = DONE + SKIPPED + REMOVED, pending = PENDING + IN_PROGRESS whose lease ran out,
 * inProgress = live claims.
 */
export async function progressOf(db: Deps["db"], listIds: string[], now = new Date()): Promise<Map<string, ListProgress>> {
  if (listIds.length === 0) return new Map();
  const rows = await db.$queryRaw<
    { list_id: string; total: bigint; done: bigint; pending: bigint; in_progress: bigint; skipped: bigint; removed: bigint }[]
  >`
    SELECT "list_id",
      count(*) AS "total",
      count(*) FILTER (WHERE "state" IN ('DONE', 'SKIPPED', 'REMOVED')) AS "done",
      count(*) FILTER (WHERE "state" = 'PENDING' OR ("state" = 'IN_PROGRESS' AND ("lease_until" IS NULL OR "lease_until" <= ${now}))) AS "pending",
      count(*) FILTER (WHERE "state" = 'IN_PROGRESS' AND "lease_until" > ${now}) AS "in_progress",
      count(*) FILTER (WHERE "state" = 'SKIPPED') AS "skipped",
      count(*) FILTER (WHERE "state" = 'REMOVED') AS "removed"
    FROM "call_list_items" WHERE "list_id" = ANY(${listIds}::uuid[]) GROUP BY "list_id"`;
  return new Map(
    rows.map((r) => [
      r.list_id,
      {
        total: Number(r.total),
        done: Number(r.done),
        pending: Number(r.pending),
        inProgress: Number(r.in_progress),
        skipped: Number(r.skipped),
        removed: Number(r.removed),
      },
    ]),
  );
}

/** Counts of items by their last outcome (any state), in the outcomes' order. */
export async function resultsOf(db: Deps["db"], listIds: string[]): Promise<Map<string, ListResult[]>> {
  if (listIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ list_id: string; outcome_id: string; label: string; color: string; count: bigint }[]>`
    SELECT i."list_id", o."id" AS "outcome_id", o."label", o."color", count(*) AS "count"
    FROM "call_list_items" i JOIN "outcome_defs" o ON o."id" = i."last_outcome_id"
    WHERE i."list_id" = ANY(${listIds}::uuid[])
    GROUP BY i."list_id", o."id", o."label", o."color", o."sort_order"
    ORDER BY o."sort_order", o."label"`;
  const out = new Map<string, ListResult[]>();
  for (const r of rows) {
    const list = out.get(r.list_id) ?? [];
    list.push({ outcomeId: r.outcome_id, label: r.label, color: r.color, count: Number(r.count) });
    out.set(r.list_id, list);
  }
  return out;
}

export const listInclude = {
  script: { select: { id: true, name: true } },
  assignees: { include: { user: userRef } },
} as const;
type ListRow = Prisma.CallListGetPayload<{ include: typeof listInclude }>;

/** ListSummary for each list (two grouped queries for all of them). */
export async function listSummaries(db: Deps["db"], lists: ListRow[]) {
  const ids = lists.map((l) => l.id);
  const [progress, results] = await Promise.all([progressOf(db, ids), resultsOf(db, ids)]);
  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    state: l.state,
    script: l.script,
    assignees: l.assignees.map((a) => a.user).sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email)),
    createdAt: l.createdAt,
    progress: progress.get(l.id) ?? EMPTY_PROGRESS,
    results: results.get(l.id) ?? [],
  }));
}
export type ListSummary = Awaited<ReturnType<typeof listSummaries>>[number];

export function scriptDto(s: { id: string; name: string; sections: unknown; active: boolean; updatedAt: Date }) {
  return { id: s.id, name: s.name, sections: s.sections as { heading: string; text: string }[], active: s.active, updatedAt: s.updatedAt };
}

export const itemInclude = {
  contact: { include: contactInclude },
  lastOutcomeDef: { select: { id: true, label: true, color: true } },
  claimedBy: userRef,
  doneBy: userRef,
} as const;
type ItemRow = Prisma.CallListItemGetPayload<{ include: typeof itemInclude }>;

export async function itemDtos(db: Deps["db"], items: ItemRow[]) {
  const dnc = await dncFor(db, items.map((i) => i.contact.phoneE164));
  return items.map((i) => ({
    id: i.id,
    position: i.position,
    state: i.state,
    attempts: i.attempts,
    retryAt: i.retryAt,
    lastOutcome: i.lastOutcomeDef,
    lastActivityAt: i.lastActivityAt,
    claimedBy: i.claimedBy,
    doneBy: i.doneBy,
    contact: contactDto(i.contact, dnc),
  }));
}

/** Lists a dashboard manager may manage: ADMIN all; MANAGER lists made by / assigned to their team (or themselves). */
export function listScope(user: User): Prisma.CallListWhereInput {
  if (user.role === "ADMIN") return {};
  const mine: Prisma.CallListWhereInput[] = [{ createdById: user.id }, { assignees: { some: { userId: user.id } } }];
  if (user.role === "MANAGER" && user.team) {
    mine.push({ createdBy: { team: user.team } }, { assignees: { some: { user: { team: user.team } } } });
  }
  return { OR: mine };
}

/** The list for a rep session: 404 unknown, 403 NOT_ASSIGNED. */
export async function assignedList(db: Deps["db"], userId: string, listId: string) {
  const list = await db.callList.findUnique({
    where: { id: listId },
    include: { assignees: { where: { userId }, select: { userId: true } } },
  });
  if (!list) throw new HttpError(404, "Call list not found");
  if (list.assignees.length === 0) throw new HttpError(403, "You are not assigned to this list", "NOT_ASSIGNED");
  return list;
}

/**
 * Claims the rep's next item (§5.2): an item already held is returned with a fresh lease (idempotent); else the
 * first runnable item (PENDING or lease expired, retry time reached, number not DNC) by retry time, position, id,
 * locked with FOR UPDATE SKIP LOCKED so two reps never get the same one.
 */
export async function nextItem(deps: Deps, userId: string, listId: string) {
  const list = await assignedList(deps.db, userId, listId);
  if (list.state !== "ACTIVE") throw new HttpError(409, "This list is paused", "LIST_PAUSED");
  // A number that went on the DNC list after it was added: drop it from the list (own statement, no claim locks).
  await deps.db.$executeRaw`
    UPDATE "call_list_items" i SET "state" = 'REMOVED', "updated_at" = ${new Date()}
    FROM "contacts" c
    WHERE c."id" = i."contact_id" AND i."list_id" = ${listId}::uuid AND i."state" = 'PENDING' AND ${dncExistsSql("c")}`;
  const now = new Date();
  const lease = new Date(now.getTime() + LEASE_MS);
  const itemId = await deps.db.$transaction(async (tx) => {
    const held = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "call_list_items" SET "lease_until" = ${lease}, "updated_at" = ${now}
      WHERE "id" = (
        SELECT "id" FROM "call_list_items"
        WHERE "list_id" = ${listId}::uuid AND "state" = 'IN_PROGRESS' AND "claimed_by_id" = ${userId}::uuid AND "lease_until" > ${now}
        ORDER BY "updated_at" DESC, "id" LIMIT 1 FOR UPDATE)
      RETURNING "id"`;
    if (held[0]) return held[0].id;
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "call_list_items" SET "state" = 'IN_PROGRESS', "claimed_by_id" = ${userId}::uuid, "lease_until" = ${lease}, "updated_at" = ${now}
      WHERE "id" = (
        SELECT i."id" FROM "call_list_items" i JOIN "contacts" c ON c."id" = i."contact_id"
        WHERE i."list_id" = ${listId}::uuid
          AND (i."state" = 'PENDING' OR (i."state" = 'IN_PROGRESS' AND i."lease_until" < ${now}))
          AND (i."retry_at" IS NULL OR i."retry_at" <= ${now})
          AND NOT ${dncExistsSql("c")}
        ORDER BY i."retry_at" ASC NULLS FIRST, i."position", i."id"
        LIMIT 1 FOR UPDATE OF i SKIP LOCKED)
      RETURNING "id"`;
    return claimed[0]?.id ?? null;
  });
  return nextResponse(deps, listId, itemId);
}

async function nextResponse(deps: Deps, listId: string, itemId: string | null) {
  const [progress, results] = await Promise.all([progressOf(deps.db, [listId]), resultsOf(deps.db, [listId])]);
  const base = { progress: progress.get(listId) ?? EMPTY_PROGRESS, results: results.get(listId) ?? [] };
  if (!itemId) return { item: null, ...base, code: "LIST_EMPTY" as const };
  const row = await deps.db.callListItem.findUniqueOrThrow({ where: { id: itemId }, include: itemInclude });
  return { item: (await itemDtos(deps.db, [row]))[0]!, ...base };
}

/** Skips the item the rep holds, then returns their next one. 409 when they don't hold it. */
export async function skipItem(deps: Deps, userId: string, itemId: string) {
  const item = await deps.db.callListItem.findUnique({ where: { id: itemId }, select: { listId: true } });
  if (!item) throw new HttpError(404, "Item not found");
  await assignedList(deps.db, userId, item.listId);
  const now = new Date();
  const { count } = await deps.db.callListItem.updateMany({
    where: { id: itemId, state: "IN_PROGRESS", claimedById: userId },
    data: { state: "SKIPPED", doneById: userId, doneAt: now, claimedById: null, leaseUntil: null },
  });
  if (count === 0) throw new HttpError(409, "This number is not held by you");
  return nextItem(deps, userId, item.listId);
}

/** Pause: the rep's held item goes back to PENDING. */
export async function releaseList(deps: Deps, userId: string, listId: string) {
  await assignedList(deps.db, userId, listId);
  await deps.db.callListItem.updateMany({
    where: { listId, state: "IN_PROGRESS", claimedById: userId },
    data: { state: "PENDING", claimedById: null, leaseUntil: null },
  });
}

/**
 * Appends contacts to a list in the given order: DNC numbers and contacts already on the list (or repeated) are
 * skipped. Positions continue after the list's last one.
 */
export async function addItems(db: Deps["db"], listId: string, contactIds: string[]) {
  // The list row lock serialises concurrent adds (two managers, an import plus a manual add): each batch reads
  // max(position) only after the previous one committed, so batches never share positions.
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM call_lists WHERE id = ${listId}::uuid FOR UPDATE`;
      return addItemsLocked(tx as Deps["db"], listId, contactIds);
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
}

async function addItemsLocked(db: Deps["db"], listId: string, contactIds: string[]) {
  const seen = new Set<string>();
  let excludedDuplicate = 0;
  const ordered: string[] = [];
  for (const id of contactIds) {
    if (seen.has(id)) excludedDuplicate++;
    else {
      seen.add(id);
      ordered.push(id);
    }
  }
  const already = new Set<string>();
  for (let i = 0; i < ordered.length; i += INSERT_CHUNK) {
    const rows = await db.callListItem.findMany({
      where: { listId, contactId: { in: ordered.slice(i, i + INSERT_CHUNK) } },
      select: { contactId: true },
    });
    for (const r of rows) already.add(r.contactId);
  }
  const fresh = ordered.filter((id) => !already.has(id));
  excludedDuplicate += ordered.length - fresh.length;
  const phones = new Map<string, string>();
  for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
    const rows = await db.contact.findMany({ where: { id: { in: fresh.slice(i, i + INSERT_CHUNK) } }, select: { id: true, phoneE164: true } });
    for (const r of rows) phones.set(r.id, r.phoneE164);
  }
  const dnc = await dncFor(db, [...phones.values()]);
  let excludedDnc = 0;
  const toAdd = fresh.filter((id) => {
    const phone = phones.get(id);
    if (!phone) return false;
    if (dnc.has(numberKey(phone))) {
      excludedDnc++;
      return false;
    }
    return true;
  });
  const last = await db.callListItem.aggregate({ where: { listId }, _max: { position: true } });
  const start = (last._max.position ?? -1) + 1;
  let added = 0;
  for (let i = 0; i < toAdd.length; i += INSERT_CHUNK) {
    const chunk = toAdd.slice(i, i + INSERT_CHUNK);
    added += (
      await db.callListItem.createMany({
        data: chunk.map((contactId, j) => ({ listId, contactId, position: start + i + j })),
        skipDuplicates: true,
      })
    ).count;
  }
  return { added, excludedDnc, excludedDuplicate };
}
