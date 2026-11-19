import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { callScope, requireDevice, requireSession } from "../auth/guards.js";
import { HttpError, currentUser, type Deps } from "../context.js";
import type { Prisma, User } from "../generated/prisma/client.js";
import { toE164 } from "../phone.js";
import {
  ActivityBody,
  activityDto,
  addActivity,
  contactDtoOf,
  contactDtos,
  contactInclude,
  contactScope,
  existingActivity,
  istDay,
  listableScope,
  outcomeDefSelect,
  repContactScope,
  repUserScope,
  resolveActivity,
  upsertContact,
} from "../activity/service.js";
import { CONTACT_FILTERS, ContactFilter, STATUSES, dashContactWhere, filterWhere, listOrder, searchWhere } from "../activity/contacts.js";
import { Mapping, autoMapping, mapRows, parseCsv, previewImport, runImport } from "../activity/csv.js";
import { assignLead } from "../leads/assign.js";
import { addItems, listScope } from "../lists/service.js";
import { audit } from "../audit.js";

const TIMELINE_MAX = 200;

const idParam = (req: FastifyRequest) => z.uuid().parse((req.params as { id: string }).id);

const DeviceListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  filter: z.enum(CONTACT_FILTERS).optional(),
});
const DashListQuery = DeviceListQuery.extend(ContactFilter.omit({ q: true }).shape);
const NameFields = {
  name: z.string().trim().max(200).nullable().optional(),
  company: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(200).nullable().optional(),
};
const DevicePatch = z.object(NameFields);
const DashPatch = z.object({
  ...NameFields,
  status: z.enum(STATUSES).optional(),
  nextFollowUpAt: z.iso.datetime({ offset: true }).nullable().optional(),
  ownerId: z.uuid().optional(),
});
const NoteBody = z.object({
  note: z.string().trim().min(1).max(2000),
  followUpAt: z.iso.datetime({ offset: true }).optional(),
});
const RangeQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
const NewContact = z.object({
  phone: z.string().trim().min(1).max(40),
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  city: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
  assignTo: z.union([z.uuid(), z.literal("auto")]).nullable().optional(),
});
const CSV_LIMIT = 10 * 1024 * 1024;
const PreviewBody = z.object({ csv: z.string().max(CSV_LIMIT), mapping: Mapping.optional(), hasHeader: z.boolean().optional() });
const ImportBody = z.object({
  csv: z.string().max(CSV_LIMIT),
  mapping: Mapping,
  // Optional override; by default a first row naming a phone column is the header.
  hasHeader: z.boolean().optional(),
  ownerId: z.uuid().nullable().optional(),
  listId: z.uuid().optional(),
});

/** Blank strings clear a field; undefined leaves it. */
const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v || null);

/** A MANAGER may only pick users of their own team (or themselves); ADMIN anyone. 400 for an unknown / inactive user. */
export async function checkAssignable(deps: Deps, by: User, userId: string) {
  const u = await deps.db.user.findUnique({ where: { id: userId } });
  if (!u || !u.active) throw new HttpError(400, "Unknown or inactive user");
  if (by.role === "MANAGER" && u.id !== by.id && (!by.team || u.team !== by.team)) throw new HttpError(403, "User must be in your team");
  return u;
}

/** Activity tracker: phone dialer API (Bearer) and dashboard API (session). See docs/dialer-plan.md. */
export async function activityRoutes(app: FastifyInstance, deps: Deps) {
  const device = { preHandler: requireDevice(deps) };
  const anyone = { preHandler: requireSession(deps) };
  const managers = { preHandler: requireSession(deps, ["ADMIN", "MANAGER"]) };
  const region = deps.config.DEFAULT_PHONE_REGION;

  const findContact = async (where: Prisma.ContactWhereInput) => {
    const c = await deps.db.contact.findFirst({ where, include: contactInclude });
    if (!c) throw new HttpError(404, "Contact not found");
    return c;
  };

  // ---- Phone app ----

  /** Stores one activity from the phone (idempotent by clientId). Throws HttpError for a bad item. */
  const saveFromPhone = async (userId: string, body: z.infer<typeof ActivityBody>, via = body.via) => {
    const phoneE164 = toE164(body.phone, region);
    if (!phoneE164) throw new HttpError(400, "Invalid phone number");
    // Outcome / rule validation before the contact is touched (a bad item creates nothing).
    const resolved = await resolveActivity(deps.db, {
      clientId: body.clientId,
      type: body.type,
      outcome: body.outcome,
      outcomeId: body.outcomeId,
      note: body.note,
      followUpAt: body.followUpAt ? new Date(body.followUpAt) : undefined,
      durationS: body.durationS,
      occurredAt: new Date(body.occurredAt),
      via: body.type === "CALL" ? via : undefined,
      callListItemId: body.callListItemId,
      channel: body.channel,
      templateId: body.templateId,
    });
    // Retry of an already stored activity: return it without touching the contact (409 if not this rep's).
    const prior = await existingActivity(deps, body.clientId, userId);
    return prior ?? (await addActivity(deps, userId, (await upsertContact(deps, phoneE164, userId, body.name, body.company)).id, resolved));
  };

  app.post("/v1/activities", device, async (req) => {
    const activity = await saveFromPhone(currentUser(req).id, ActivityBody.parse(req.body));
    const fresh = await deps.db.contact.findUniqueOrThrow({ where: { id: activity.contactId }, include: contactInclude });
    const { callId: _callId, ...dto } = activityDto(activity);
    return { activity: dto, contact: await contactDtoOf(deps.db, fresh) };
  });

  /**
   * Up to 50 queued activities in one request (after an outage the phone may hold many). Stored in the order
   * sent, so a contact ends in the state of its newest outcome. Each item succeeds or fails on its own; an item
   * that fails validation is reported with its status and does not stop the rest.
   */
  app.post("/v1/activities/batch", device, async (req) => {
    const raw = z.object({ items: z.array(z.unknown()).min(1).max(50) }).parse(req.body).items;
    const userId = currentUser(req).id;
    const results = [];
    for (const item of raw) {
      const parsed = ActivityBody.safeParse(item);
      const clientId = typeof (item as { clientId?: unknown })?.clientId === "string" ? (item as { clientId: string }).clientId : null;
      if (!parsed.success) {
        results.push({ clientId, ok: false, status: 400, error: parsed.error.issues[0]?.message ?? "Invalid activity" });
        continue;
      }
      try {
        await saveFromPhone(userId, parsed.data);
        results.push({ clientId, ok: true });
      } catch (e) {
        if (!(e instanceof HttpError) || e.statusCode >= 500) throw e; // server trouble: the phone retries the batch
        results.push({ clientId, ok: false, status: e.statusCode, error: e.message, ...(e.code ? { code: e.code } : {}) });
      }
    }
    return { results };
  });

  // ---- Dashboard / desktop dialer ----

  /** Call outcome or message log from the desktop (same rules and idempotency as the phone's). */
  app.post("/api/activities", anyone, async (req) => {
    const userId = currentUser(req).id;
    const body = ActivityBody.parse(req.body);
    // The dashboard registered this click-to-call as a dial intent: it was dialled from the laptop.
    const intent = await deps.db.dialIntent.findFirst({ where: { clientId: body.clientId, userId }, select: { id: true } });
    const activity = await saveFromPhone(userId, body, intent ? "LAPTOP" : body.via);
    const fresh = await deps.db.contact.findUniqueOrThrow({ where: { id: activity.contactId }, include: contactInclude });
    const { callId: _callId, ...dto } = activityDto(activity);
    return { activity: dto, contact: await contactDtoOf(deps.db, fresh) };
  });

  app.get("/v1/contacts", device, async (req) => {
    const q = DeviceListQuery.parse(req.query);
    const userId = currentUser(req).id;
    const rows = await deps.db.contact.findMany({
      where: { AND: [repContactScope(userId), searchWhere(q.q), await filterWhere(deps.db, q.filter, userId)] },
      orderBy: listOrder,
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: contactInclude,
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    return { items: await contactDtos(deps.db, items), nextCursor: more ? items.at(-1)!.id : null };
  });

  app.get("/v1/contacts/followups", device, async (req) => {
    const { end } = istDay();
    const rows = await deps.db.contact.findMany({
      where: { AND: [repContactScope(currentUser(req).id), { nextFollowUpAt: { lt: end } }] },
      orderBy: [{ nextFollowUpAt: "asc" }, { id: "asc" }],
      take: 500,
      include: contactInclude,
    });
    return { items: await contactDtos(deps.db, rows) };
  });

  app.get("/v1/contacts/by-phone", device, async (req) => {
    const { phone } = z.object({ phone: z.string().trim().min(1).max(40) }).parse(req.query);
    const phoneE164 = toE164(phone, region);
    if (!phoneE164) throw new HttpError(400, "Invalid phone number");
    const contact = await deps.db.contact.findFirst({
      where: { AND: [{ phoneE164 }, repContactScope(currentUser(req).id)] },
      include: contactInclude,
    });
    if (!contact) return { contact: null, activities: [], lastSummary: null };
    const activities = await deps.db.activity.findMany({
      where: { contactId: contact.id },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 20,
      include: outcomeDefSelect,
    });
    // For the caller card: what was said last time on this number (calls this rep may see).
    const last = await deps.db.call.findFirst({
      where: { AND: [callScope(currentUser(req)), { phoneE164, transcript: { summary: { not: null } } }] },
      orderBy: { startedAt: "desc" },
      select: { transcript: { select: { summary: true } } },
    });
    return {
      contact: await contactDtoOf(deps.db, contact),
      activities: activities.map(activityDto),
      lastSummary: last?.transcript?.summary ?? null,
    };
  });

  app.patch("/v1/contacts/:id", device, async (req) => {
    const id = idParam(req);
    const body = DevicePatch.parse(req.body);
    await findContact({ AND: [{ id }, repContactScope(currentUser(req).id)] });
    const c = await deps.db.contact.update({
      where: { id },
      data: { name: blankToNull(body.name), company: blankToNull(body.company), city: blankToNull(body.city) },
      include: contactInclude,
    });
    return contactDtoOf(deps.db, c);
  });

  // ---- Dashboard ----

  app.get("/api/contacts", anyone, async (req) => {
    const q = DashListQuery.parse(req.query);
    const rows = await deps.db.contact.findMany({
      where: await dashContactWhere(deps.db, currentUser(req), { ...q, q: q.q }),
      orderBy: listOrder,
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { ...contactInclude, _count: { select: { activities: true } } },
    });
    const more = rows.length > q.limit;
    const items = more ? rows.slice(0, q.limit) : rows;
    const dtos = await contactDtos(deps.db, items);
    return {
      items: dtos.map((d, i) => ({ ...d, activityCount: items[i]!._count.activities })),
      nextCursor: more ? items.at(-1)!.id : null,
    };
  });

  /**
   * Manual new lead (§9.4). AGENTs always assign themselves; managers pick "auto" (round-robin), a user, or nobody.
   * An existing contact the caller can see is updated; one they can't see is 409 EXISTS.
   */
  app.post("/api/contacts", anyone, async (req, reply) => {
    const user = currentUser(req);
    const body = NewContact.parse(req.body);
    const phoneE164 = toE164(body.phone, region);
    if (!phoneE164) throw new HttpError(400, "Invalid phone number");
    const existing = await deps.db.contact.findUnique({ where: { phoneE164 }, select: { id: true } });
    if (existing) {
      const visible = await deps.db.contact.findFirst({ where: { AND: [{ id: existing.id }, contactScope(user)] }, select: { id: true } });
      if (!visible) throw new HttpError(409, "This number is already a contact of another rep", "EXISTS", { contactId: existing.id });
      const c = await deps.db.contact.update({
        where: { id: existing.id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.company ? { company: body.company } : {}),
          ...(body.city ? { city: body.city } : {}),
        },
        include: contactInclude,
      });
      return { contact: await contactDtoOf(deps.db, c), leadId: null, assignedTo: null };
    }
    let assignTo: string | null | "auto";
    if (user.role === "AGENT") assignTo = user.id;
    else assignTo = body.assignTo === undefined ? user.id : body.assignTo;
    if (assignTo && assignTo !== "auto") await checkAssignable(deps, user, assignTo);
    const fields = { phoneE164, name: body.name, company: body.company, city: body.city, note: body.note };
    if (assignTo === null) {
      const c = await deps.db.contact.create({
        data: { phoneE164, name: body.name || null, company: body.company || null, city: body.city || null, source: "manual" },
        include: contactInclude,
      });
      return reply.code(201).send({ contact: await contactDtoOf(deps.db, c), leadId: null, assignedTo: null });
    }
    const r = await assignLead(deps, null, fields, { manual: true, by: user.id, ...body }, assignTo === "auto" ? undefined : assignTo);
    const c = await deps.db.contact.findUniqueOrThrow({ where: { id: r.contactId! }, include: contactInclude });
    const assignedTo = r.assignedTo ? await deps.db.user.findUnique({ where: { id: r.assignedTo.id }, select: { id: true, name: true, email: true } }) : null;
    return reply.code(201).send({ contact: await contactDtoOf(deps.db, c), leadId: r.leadId, assignedTo });
  });

  // CSV import (managers): preview, then import. 10 MB bodies, 20 000 rows.
  const csvOpts = { ...managers, bodyLimit: CSV_LIMIT + 64 * 1024 };

  app.post("/api/contacts/import/preview", csvOpts, async (req) => {
    const user = currentUser(req);
    const body = PreviewBody.parse(req.body);
    const rows = parseCsv(body.csv);
    const auto = autoMapping(rows);
    const mapping = body.mapping ?? auto.mapping;
    const hasHeader = body.hasHeader ?? auto.hasHeader;
    const mapped = mapRows(rows, mapping, hasHeader, region);
    const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
    const columns = hasHeader ? (rows[0] ?? []) : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
    return { columns, hasHeader, mapping, ...(await previewImport(deps.db, mapped, listableScope(user))) };
  });

  app.post("/api/contacts/import", csvOpts, async (req) => {
    const user = currentUser(req);
    const body = ImportBody.parse(req.body);
    if (body.ownerId) await checkAssignable(deps, user, body.ownerId);
    if (body.listId && !(await deps.db.callList.findFirst({ where: { AND: [{ id: body.listId }, listScope(user)] }, select: { id: true } }))) {
      throw new HttpError(404, "Call list not found");
    }
    const rows = parseCsv(body.csv);
    const hasHeader = body.hasHeader ?? autoMapping(rows).hasHeader;
    const mapped = mapRows(rows, body.mapping, hasHeader, region);
    const r = await runImport(deps.db, mapped, body.ownerId ?? null, listableScope(user));
    let dncSkippedFromList = 0;
    if (body.listId) {
      const added = await addItems(deps.db, body.listId, r.contactIds);
      dncSkippedFromList = added.excludedDnc;
    }
    await audit(deps, req, "CONTACT_IMPORT", {
      created: r.created,
      updated: r.updated,
      skipped: r.skipped,
      ownedElsewhere: r.ownedElsewhere,
      ownerId: body.ownerId ?? null,
      listId: body.listId ?? null,
    });
    return { created: r.created, updated: r.updated, skipped: r.skipped, ownedElsewhere: r.ownedElsewhere, dncSkippedFromList, contactIds: r.contactIds };
  });

  app.get("/api/contacts/:id", anyone, async (req) => {
    const user = currentUser(req);
    const contact = await findContact({ AND: [{ id: idParam(req) }, contactScope(user)] });
    const activities = await deps.db.activity.findMany({
      where: { contactId: contact.id },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: TIMELINE_MAX,
      include: { user: { select: { id: true, name: true, email: true } }, ...outcomeDefSelect },
    });
    const linkedIds = activities.flatMap((a) => (a.callId ? [a.callId] : []));
    // Calls on this number plus calls linked to these activities, limited to what the viewer may see.
    const calls = await deps.db.call.findMany({
      where: { AND: [callScope(user), { OR: [{ phoneE164: contact.phoneE164 }, { id: { in: linkedIds } }] }] },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: TIMELINE_MAX + linkedIds.length,
      select: {
        id: true,
        direction: true,
        startedAt: true,
        durationS: true,
        status: true,
        filePath: true,
        audioDeletedAt: true,
        via: true,
        user: { select: { id: true, name: true, email: true } },
        transcript: { select: { summary: true } },
      },
    });
    const callFields = (c: (typeof calls)[number]) => ({
      id: c.id,
      status: c.status,
      summary: c.transcript?.summary ?? null,
      hasAudio: !!c.filePath && !c.audioDeletedAt,
    });
    const byId = new Map(calls.map((c) => [c.id, c]));
    const linked = new Set(linkedIds);
    const items = [
      ...activities.map((a) => {
        const call = a.callId ? byId.get(a.callId) : undefined;
        return { kind: "activity" as const, ...activityDto(a), user: a.user, call: call ? callFields(call) : null, at: a.occurredAt };
      }),
      ...calls
        .filter((c) => !linked.has(c.id))
        .map((c) => {
          const { id, status, summary, hasAudio } = callFields(c);
          return { kind: "call" as const, id, direction: c.direction, via: c.via, startedAt: c.startedAt, durationS: c.durationS, status, user: c.user, hasAudio, summary, at: c.startedAt };
        }),
    ];
    items.sort((a, b) => b.at.getTime() - a.at.getTime());
    return { contact: await contactDtoOf(deps.db, contact), timeline: items.slice(0, TIMELINE_MAX).map(({ at: _at, ...rest }) => rest) };
  });

  app.patch("/api/contacts/:id", anyone, async (req) => {
    const user = currentUser(req);
    const id = idParam(req);
    const body = DashPatch.parse(req.body);
    await findContact({ AND: [{ id }, contactScope(user)] });
    if (body.ownerId !== undefined) {
      if (user.role === "AGENT") throw new HttpError(403, "Only managers can change the owner");
      const owner = await deps.db.user.findUnique({ where: { id: body.ownerId } });
      if (!owner) throw new HttpError(400, "Unknown owner");
      if (user.role === "MANAGER" && (!user.team || owner.team !== user.team) && owner.id !== user.id) {
        throw new HttpError(403, "Owner must be in your team");
      }
    }
    const c = await deps.db.contact.update({
      where: { id },
      data: {
        name: blankToNull(body.name),
        company: blankToNull(body.company),
        city: blankToNull(body.city),
        status: body.status,
        nextFollowUpAt: body.nextFollowUpAt === undefined ? undefined : body.nextFollowUpAt && new Date(body.nextFollowUpAt),
        ownerId: body.ownerId,
      },
      include: contactInclude,
    });
    return contactDtoOf(deps.db, c);
  });

  app.post("/api/contacts/:id/notes", anyone, async (req) => {
    const user = currentUser(req);
    const contact = await findContact({ AND: [{ id: idParam(req) }, contactScope(user)] });
    const body = NoteBody.parse(req.body);
    const a = await addActivity(deps, user.id, contact.id, {
      type: "NOTE",
      note: body.note,
      followUpAt: body.followUpAt ? new Date(body.followUpAt) : undefined,
      occurredAt: new Date(),
    });
    return activityDto(a);
  });

  /** Kept unchanged for old clients; the Team page uses /api/team/stats (same definitions). */
  app.get("/api/activity/reps", managers, async (req) => {
    const q = RangeQuery.parse(req.query);
    const today = istDay();
    const from = q.from ? new Date(q.from) : today.start;
    const to = q.to ? new Date(q.to) : today.end;
    const users = await deps.db.user.findMany({
      where: { active: true, ...repUserScope(currentUser(req)) },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
    });
    const ids = users.map((u) => u.id);
    const [acts, dueToday, overdue] = await Promise.all([
      deps.db.activity.findMany({
        where: { userId: { in: ids }, type: { in: ["CALL", "WHATSAPP"] }, occurredAt: { gte: from, lt: to } },
        select: { userId: true, type: true, outcome: true, durationS: true },
      }),
      deps.db.contact.groupBy({
        by: ["ownerId"],
        where: { ownerId: { in: ids }, nextFollowUpAt: { gte: today.start, lt: today.end } },
        _count: { _all: true },
      }),
      deps.db.contact.groupBy({
        by: ["ownerId"],
        where: { ownerId: { in: ids }, nextFollowUpAt: { lt: today.start } },
        _count: { _all: true },
      }),
    ]);
    const countOf = (rows: typeof dueToday, id: string) => rows.find((r) => r.ownerId === id)?._count._all ?? 0;
    const items = users.map((u) => {
      const mine = acts.filter((a) => a.userId === u.id);
      const calls = mine.filter((a) => a.type === "CALL");
      return {
        user: u,
        callsMade: calls.length,
        // The call log's duration decides when the phone gave one (0 s = never connected, whatever the rep
        // picked, e.g. Call back after no answer); only without a duration does the outcome decide.
        answered: calls.filter((a) =>
          a.durationS != null ? a.durationS > 0 : a.outcome !== null && a.outcome !== "NO_ANSWER",
        ).length,
        talkTimeS: calls.reduce((s, a) => s + (a.durationS ?? 0), 0),
        whatsapp: mine.length - calls.length,
        followUpsDueToday: countOf(dueToday, u.id),
        overdue: countOf(overdue, u.id),
      };
    });
    return { items };
  });
}
