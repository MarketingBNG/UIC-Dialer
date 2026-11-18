import { z } from "zod";
import { HttpError, type Deps } from "../context.js";
import { Prisma, type ContactStatus } from "../generated/prisma/client.js";
import { toE164 } from "../phone.js";
import { istDay, repContactScope } from "./service.js";

/** The dashboard calls the phone "online" when its last heartbeat is newer than this. */
export const PHONE_ONLINE_MS = 75 * 60 * 1000;
const TODAY_MAX = 500;
const HOUR_MS = 3600 * 1000;

export const MissedItem = z.object({
  clientId: z.string().min(1).max(120),
  phone: z.string().trim().min(1).max(40),
  occurredAt: z.iso.datetime({ offset: true }),
  callerName: z.string().trim().max(200).nullable().optional(),
});
export type MissedItem = z.infer<typeof MissedItem>;

export const FollowUpPatch = z.object({
  action: z.enum(["done", "dismiss", "snooze"]),
  until: z.iso.datetime({ offset: true }).optional(),
});

export interface FollowUpItem {
  key: string;
  kind: "FOLLOW_UP" | "MISSED_CALL";
  contactId: string | null;
  taskId: string | null;
  phoneE164: string;
  name: string | null;
  company: string | null;
  status: ContactStatus | null;
  dueAt: Date;
  overdue: boolean;
  lastNote: string | null;
}

/** Sort by due time, then key (stable across refreshes). */
export function sortItems(items: FollowUpItem[]) {
  return items.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Overdue / today counts over the items list. */
export function countItems(items: FollowUpItem[]) {
  const overdue = items.filter((i) => i.overdue).length;
  return { overdue, today: items.length - overdue };
}

const contactSelect = { id: true, phoneE164: true, name: true, company: true, status: true, nextFollowUpAt: true } as const;
type ContactLite = Prisma.ContactGetPayload<{ select: typeof contactSelect }>;
const taskInclude = { contact: { select: contactSelect } } as const;
type TaskRow = Prisma.FollowUpTaskGetPayload<{ include: typeof taskInclude }>;

/** Newest non-empty note per contact. */
async function lastNotes(db: Deps["db"], contactIds: string[]) {
  if (contactIds.length === 0) return new Map<string, string>();
  const rows = await db.activity.findMany({
    where: { contactId: { in: contactIds }, AND: [{ note: { not: null } }, { note: { not: "" } }] },
    orderBy: [{ contactId: "asc" }, { occurredAt: "desc" }, { id: "desc" }],
    distinct: ["contactId"],
    select: { contactId: true, note: true },
  });
  return new Map(rows.map((r) => [r.contactId, r.note!]));
}

function contactItem(c: ContactLite, start: Date, notes: Map<string, string>): FollowUpItem {
  return {
    key: `contact:${c.id}`,
    kind: "FOLLOW_UP",
    contactId: c.id,
    taskId: null,
    phoneE164: c.phoneE164,
    name: c.name,
    company: c.company,
    status: c.status,
    dueAt: c.nextFollowUpAt!,
    overdue: c.nextFollowUpAt! < start,
    lastNote: notes.get(c.id) ?? null,
  };
}

function taskItem(t: TaskRow, notes: Map<string, string>): FollowUpItem {
  return {
    key: `task:${t.id}`,
    kind: "MISSED_CALL",
    contactId: t.contactId,
    taskId: t.id,
    phoneE164: t.phoneE164,
    name: t.contact?.name ?? t.callerName,
    company: t.contact?.company ?? null,
    status: t.contact?.status ?? null,
    dueAt: t.dueAt,
    overdue: true, // a missed call is always waiting on the rep
    lastNote: (t.contactId && notes.get(t.contactId)) || null,
  };
}

/** The rep's own follow-ups due by the end of today (IST), missed-call tasks, and the next 24 h of contact follow-ups. */
export async function followUpsToday(deps: Deps, userId: string, now = new Date()) {
  const { start, end } = istDay(now);
  const horizon = new Date(Math.max(end.getTime(), now.getTime() + 24 * HOUR_MS));
  const [contacts, upcoming, tasks] = await Promise.all([
    deps.db.contact.findMany({
      where: { AND: [repContactScope(userId), { nextFollowUpAt: { lt: end } }] },
      orderBy: [{ nextFollowUpAt: "asc" }, { id: "asc" }],
      take: TODAY_MAX,
      select: contactSelect,
    }),
    deps.db.contact.findMany({
      where: { AND: [repContactScope(userId), { nextFollowUpAt: { gte: end, lt: horizon } }] },
      orderBy: [{ nextFollowUpAt: "asc" }, { id: "asc" }],
      take: TODAY_MAX,
      select: contactSelect,
    }),
    deps.db.followUpTask.findMany({
      where: { userId, state: "OPEN", dueAt: { lt: end } },
      orderBy: [{ dueAt: "asc" }, { id: "asc" }],
      take: TODAY_MAX,
      include: taskInclude,
    }),
  ]);
  const ids = new Set([...contacts, ...upcoming].map((c) => c.id));
  for (const t of tasks) if (t.contactId) ids.add(t.contactId);
  const notes = await lastNotes(deps.db, [...ids]);
  const items = sortItems([...contacts.map((c) => contactItem(c, start, notes)), ...tasks.map((t) => taskItem(t, notes))]).slice(0, TODAY_MAX);
  return {
    items,
    upcoming: sortItems(upcoming.map((c) => contactItem(c, start, notes))),
    counts: countItems(items),
  };
}

/** One missed call from the phone; idempotent on clientId. Returns the task's id and state. */
export async function saveMissed(deps: Deps, userId: string, item: MissedItem): Promise<{ id: string; state: string }> {
  const phoneE164 = toE164(item.phone, deps.config.DEFAULT_PHONE_REGION);
  if (!phoneE164) throw new HttpError(400, "Invalid phone number");
  const prior = await deps.db.followUpTask.findUnique({ where: { clientId: item.clientId } });
  if (prior) return ownTask(prior, userId);

  const occurredAt = new Date(item.occurredAt);
  // A later connected call or a WhatsApp to the number already is the follow-up.
  const [laterCall, laterActivity, contact] = await Promise.all([
    deps.db.call.findFirst({
      where: {
        userId,
        phoneE164,
        startedAt: { gt: occurredAt },
        OR: [{ direction: "OUTGOING" }, { direction: { not: "MISSED" }, durationS: { gt: 0 } }],
      },
      select: { id: true },
    }),
    deps.db.activity.findFirst({
      where: { userId, type: { in: ["CALL", "WHATSAPP"] }, occurredAt: { gt: occurredAt }, contact: { phoneE164 } },
      select: { id: true },
    }),
    // Only a contact the rep may see; another rep's contact stays hidden.
    deps.db.contact.findFirst({ where: { AND: [{ phoneE164 }, repContactScope(userId)] }, select: { id: true } }),
  ]);
  const handled = !!(laterCall || laterActivity);
  try {
    const t = await deps.db.followUpTask.create({
      data: {
        clientId: item.clientId,
        userId,
        contactId: contact?.id ?? null,
        phoneE164,
        callerName: item.callerName || null,
        occurredAt,
        dueAt: occurredAt,
        state: handled ? "DONE" : "OPEN",
        doneAt: handled ? new Date() : null,
      },
    });
    return { id: t.id, state: t.state };
  } catch (e) {
    // A concurrent retry with the same clientId won the insert.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return ownTask(await deps.db.followUpTask.findUniqueOrThrow({ where: { clientId: item.clientId } }), userId);
    }
    throw e;
  }
}

function ownTask(t: { id: string; userId: string; state: string }, userId: string) {
  if (t.userId !== userId) throw new HttpError(409, "clientId already used");
  return { id: t.id, state: t.state };
}

/** done / dismiss / snooze on the rep's own task; returns it in the today-item shape. */
export async function patchTask(deps: Deps, userId: string, taskId: string, body: z.infer<typeof FollowUpPatch>, now = new Date()) {
  const task = await deps.db.followUpTask.findFirst({ where: { id: taskId, userId } });
  if (!task) throw new HttpError(404, "Follow-up not found");
  let data: Prisma.FollowUpTaskUpdateInput;
  if (task.state !== "OPEN") {
    // A closed task stays closed; a late retry of done/dismiss is a no-op.
    if (body.action === "snooze") throw new HttpError(409, "Follow-up is already closed");
    const same = await deps.db.followUpTask.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
    return taskItem(same, await lastNotes(deps.db, same.contactId ? [same.contactId] : []));
  }
  if (body.action === "snooze") {
    if (!body.until) throw new HttpError(400, "until is required to snooze");
    const until = new Date(body.until);
    if (until.getTime() <= now.getTime() - 60_000 || until.getTime() > now.getTime() + 30 * 24 * HOUR_MS) {
      throw new HttpError(400, "until must be between now and 30 days ahead");
    }
    data = { dueAt: until };
  } else {
    data = { state: body.action === "done" ? "DONE" : "DISMISSED", doneAt: now };
  }
  const { count } = await deps.db.followUpTask.updateMany({ where: { id: task.id, state: "OPEN" }, data: data as Prisma.FollowUpTaskUpdateManyMutationInput });
  if (count === 0 && body.action === "snooze") throw new HttpError(409, "Follow-up is already closed");
  const updated = await deps.db.followUpTask.findUniqueOrThrow({ where: { id: task.id }, include: taskInclude });
  const notes = await lastNotes(deps.db, updated.contactId ? [updated.contactId] : []);
  return taskItem(updated, notes);
}

/** The rep's phone heartbeat: the non-revoked device seen most recently. */
export async function phoneStatus(deps: Deps, userId: string, now = new Date()) {
  const d = await deps.db.device.findFirst({
    where: { userId, revokedAt: null, lastSeenAt: { not: null } },
    orderBy: { lastSeenAt: "desc" },
    select: { lastSeenAt: true, model: true, appVersion: true },
  });
  if (!d?.lastSeenAt) return { lastSeenAt: null, online: false, model: null, appVersion: null };
  return {
    lastSeenAt: d.lastSeenAt,
    online: now.getTime() - d.lastSeenAt.getTime() < PHONE_ONLINE_MS,
    model: d.model,
    appVersion: d.appVersion,
  };
}
