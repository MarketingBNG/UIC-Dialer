import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError, type Deps } from "../context.js";
import {
  Prisma,
  type ActivityType,
  type CallOutcome,
  type DialVia,
  type DncNumber,
  type OutcomeDef,
  type User,
} from "../generated/prisma/client.js";
import { numberKey } from "../privacy/clientNumbers.js";
import { dncFor, dncInfo, upsertDnc } from "./dnc.js";
import { ASK_RULES, DEFAULT_OUTCOME_IDS, keepsFollowUp } from "./outcomes.js";
import { VIA_VALUES } from "./via.js";

/** A CALL activity and a recorded Call belong together when same rep, same number, start within this window. */
export const LINK_WINDOW_MS = 10 * 60 * 1000;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

/** Start and end (exclusive) of the Asia/Kolkata calendar day containing `now`. IST has no DST. */
export function istDay(now = new Date()): { start: Date; end: Date } {
  const start = Math.floor((now.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

export const OUTCOMES = ["INTERESTED", "CALL_BACK", "NOT_INTERESTED", "NO_ANSWER"] as const;
export const CHANNELS = ["WHATSAPP", "SMS"] as const;

export const ActivityBody = z.object({
  clientId: z.uuid(),
  phone: z.string().trim().min(1).max(40),
  type: z.enum(["CALL", "WHATSAPP", "NOTE"]),
  outcome: z.enum(OUTCOMES).optional(),
  note: z.string().trim().max(2000).optional(),
  followUpAt: z.iso.datetime({ offset: true }).optional(),
  durationS: z.number().int().min(0).max(24 * 3600).optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  // How the call was dialled; only kept for CALL activities.
  via: z.enum(VIA_VALUES).optional(),
  // Stage 2 (all optional so old apps still validate).
  outcomeId: z.uuid().optional(),
  callListItemId: z.uuid().optional(),
  channel: z.enum(CHANNELS).optional(),
  templateId: z.uuid().optional(),
});
export type ActivityBody = z.infer<typeof ActivityBody>;

const userSelect = { id: true, name: true, email: true } as const;
export const contactInclude = { owner: { select: userSelect } } as const;
type ContactRow = Prisma.ContactGetPayload<{ include: typeof contactInclude }>;
/** Where activities are read for a DTO, include the outcome's label and colour. */
export const outcomeDefSelect = { outcomeDef: { select: { label: true, color: true } } } as const;
type ActivityRow = Prisma.ActivityGetPayload<object> & { outcomeDef?: { label: string; color: string } | null };

/** `dnc` is filled from the map (see contactDtos); without one it is null. */
export function contactDto(c: ContactRow, dnc?: Map<string, DncNumber>) {
  return {
    id: c.id,
    phoneE164: c.phoneE164,
    name: c.name,
    company: c.company,
    city: c.city,
    source: c.source,
    status: c.status,
    nextFollowUpAt: c.nextFollowUpAt,
    lastActivityAt: c.lastActivityAt,
    owner: c.owner,
    dnc: dncInfo(dnc?.get(numberKey(c.phoneE164))),
  };
}
export type ContactDto = ReturnType<typeof contactDto>;

/** Contact DTOs with their DNC state loaded in one query. */
export async function contactDtos(db: Deps["db"] | Prisma.TransactionClient, rows: ContactRow[]) {
  const dnc = await dncFor(db, rows.map((r) => r.phoneE164));
  return rows.map((r) => contactDto(r, dnc));
}
export async function contactDtoOf(db: Deps["db"] | Prisma.TransactionClient, row: ContactRow) {
  return (await contactDtos(db, [row]))[0]!;
}

export function activityDto(a: ActivityRow) {
  return {
    id: a.id,
    clientId: a.clientId,
    type: a.type,
    outcome: a.outcome,
    note: a.note,
    followUpAt: a.followUpAt,
    durationS: a.durationS,
    occurredAt: a.occurredAt,
    callId: a.callId,
    via: a.via,
    outcomeId: a.outcomeId,
    outcomeLabel: a.outcomeDef?.label ?? null,
    outcomeColor: a.outcomeDef?.color ?? null,
    callListItemId: a.callListItemId,
    channel: a.channel,
    templateId: a.templateId,
  };
}

/**
 * Contacts a rep works with: owned, with any activity of theirs, or on a (non-archived) call list assigned to them.
 */
export function repContactScope(userId: string): Prisma.ContactWhereInput {
  return {
    OR: [
      { ownerId: userId },
      { activities: { some: { userId } } },
      {
        listItems: {
          some: { state: { not: "REMOVED" }, list: { state: { not: "ARCHIVED" }, assignees: { some: { userId } } } },
        },
      },
    ],
  };
}

/** Which contacts a dashboard user may see. Mirrors callScope() in auth/guards.ts. */
export function contactScope(user: User): Prisma.ContactWhereInput {
  if (user.role === "ADMIN") return {};
  if (user.role === "MANAGER" && user.team) return { owner: { team: user.team } };
  return repContactScope(user.id);
}

/**
 * Contacts a list builder may put on a list (and a CSV import may touch): their contact scope. A MANAGER may also use
 * unowned contacts (a CSV import without an owner creates those; their contactScope would otherwise hide them).
 */
export function listableScope(user: User): Prisma.ContactWhereInput {
  if (user.role === "MANAGER") return { OR: [contactScope(user), { ownerId: null }] };
  return contactScope(user);
}

/** Reps a manager sees in per-rep views: ADMIN everyone, MANAGER their team (or just themselves without one). */
export function repUserScope(user: User): Prisma.UserWhereInput {
  if (user.role === "ADMIN") return {};
  if (user.team) return { team: user.team };
  return { id: user.id };
}

/** The user's recorded call on this number closest to `at` (within the window) that no activity has claimed yet. */
async function findCallFor(db: Deps["db"], userId: string, phoneE164: string, at: Date) {
  const calls = await db.call.findMany({
    where: {
      userId,
      phoneE164,
      startedAt: { gte: new Date(at.getTime() - LINK_WINDOW_MS), lte: new Date(at.getTime() + LINK_WINDOW_MS) },
      activities: { none: {} },
    },
    select: { id: true, startedAt: true, via: true },
  });
  return closest(calls, (c) => c.startedAt, at) ?? null;
}

function closest<T>(rows: T[], time: (r: T) => Date, at: Date): T | undefined {
  return rows.sort((a, b) => Math.abs(time(a).getTime() - at.getTime()) - Math.abs(time(b).getTime() - at.getTime()))[0];
}

/** A late outcome on a call already in Zoho: queue the call so its Subject/Description get the outcome. */
async function requeueSyncedCall(db: Deps["db"] | Prisma.TransactionClient, callId: string) {
  // Already in Zoho (SYNCED, or a Call record exists) or a sync is running right now: that sync may have read the
  // activities before this outcome, and it only clears crm_queued_at if nobody set it meanwhile.
  await db.call.updateMany({
    where: { id: callId, OR: [{ crmStatus: "SYNCED" }, { crmCallId: { not: null } }, { crmLockedUntil: { gt: new Date() } }] },
    data: { crmQueuedAt: new Date(), crmAttempts: 0, crmNextAttemptAt: null },
  });
}

/** After a Call is registered: link it to the closest unlinked CALL activity by the same rep on the same number. */
export async function linkCallToActivity(
  deps: Deps,
  call: { id: string; userId: string; phoneE164: string | null; startedAt: Date; via?: DialVia | null },
) {
  if (!call.phoneE164) return;
  if ((await deps.db.activity.count({ where: { callId: call.id } })) > 0) return;
  const at = call.startedAt;
  const candidates = await deps.db.activity.findMany({
    where: {
      userId: call.userId,
      type: "CALL",
      callId: null,
      contact: { phoneE164: call.phoneE164 },
      occurredAt: { gte: new Date(at.getTime() - LINK_WINDOW_MS), lte: new Date(at.getTime() + LINK_WINDOW_MS) },
    },
    select: { id: true, occurredAt: true, outcome: true },
  });
  const best = closest(candidates, (a) => a.occurredAt, at);
  if (!best) return;
  const { count } = await deps.db.activity.updateMany({ where: { id: best.id, callId: null }, data: { callId: call.id } });
  // The call knows how it was dialled; an activity without its own via takes it (never the other way).
  if (count === 1 && call.via) await deps.db.activity.updateMany({ where: { id: best.id, via: null }, data: { via: call.via } });
  if (count === 1 && best.outcome) await requeueSyncedCall(deps.db, call.id);
}

export interface NewActivity {
  clientId?: string;
  type: ActivityType;
  outcome?: CallOutcome | undefined;
  /** Custom outcome (OutcomeDef id); its base outcome wins over `outcome`. */
  outcomeId?: string | undefined;
  note?: string | undefined;
  followUpAt?: Date | undefined;
  durationS?: number | undefined;
  occurredAt: Date;
  via?: DialVia | undefined;
  callListItemId?: string | undefined;
  channel?: (typeof CHANNELS)[number] | undefined;
  templateId?: string | undefined;
}

/** NewActivity after resolveActivity(): outcome = base, def loaded, followUpAt computed for RETRY. */
export interface ResolvedActivity extends NewActivity {
  def: OutcomeDef | null;
  resolved: true;
}

/** Old-app validation (kept for callers that check before creating a contact). */
export function validateActivity(a: Pick<NewActivity, "type" | "outcome" | "followUpAt">) {
  if (a.outcome && a.type !== "CALL") throw new HttpError(400, "outcome is only for CALL activities");
  if (a.outcome === "CALL_BACK" && !a.followUpAt) throw new HttpError(400, "CALL_BACK needs followUpAt");
}

/**
 * Resolves the outcome (§2.2): an `outcomeId` gives the base outcome and the rule; a plain `outcome` (old apps)
 * maps to the seeded default. Validates the rule's date, computes RETRY's followUpAt, defaults the channel.
 * Throws HttpError(400) for a bad combination.
 */
export async function resolveActivity(db: Deps["db"] | Prisma.TransactionClient, a: NewActivity | ResolvedActivity): Promise<ResolvedActivity> {
  if ("resolved" in a && a.resolved) return a;
  if (a.channel && a.type !== "WHATSAPP") throw new HttpError(400, "channel is only for WHATSAPP activities");
  let def: OutcomeDef | null = null;
  let outcome = a.outcome;
  let followUpAt = a.followUpAt;
  if (a.outcomeId) {
    if (a.type !== "CALL") throw new HttpError(400, "outcome is only for CALL activities");
    // An inactive outcome is still accepted: an offline phone may have queued it before it was switched off.
    def = await db.outcomeDef.findUnique({ where: { id: a.outcomeId } });
    if (!def) throw new HttpError(400, "Unknown outcome");
    outcome = def.baseOutcome;
    const needsDate = ASK_RULES.includes(def.rule) || (def.rule === "NONE" && outcome === "CALL_BACK");
    if (needsDate && !followUpAt) throw new HttpError(400, `${def.label} needs a follow-up date`, "OUTCOME_NEEDS_DATE");
  } else if (outcome) {
    if (a.type !== "CALL") throw new HttpError(400, "outcome is only for CALL activities");
    def = await db.outcomeDef.findUnique({ where: { id: DEFAULT_OUTCOME_IDS[outcome] } });
    // Old apps: same rule as before (they never send dates for other outcomes).
    if (def?.rule !== "RETRY" && outcome === "CALL_BACK" && !followUpAt) throw new HttpError(400, "CALL_BACK needs followUpAt");
  }
  if (def?.rule === "RETRY") followUpAt = new Date(a.occurredAt.getTime() + (def.retryHours ?? 24) * HOUR_MS);
  const templateId =
    a.templateId && (await db.messageTemplate.findUnique({ where: { id: a.templateId }, select: { id: true } })) ? a.templateId : undefined;
  return {
    ...a,
    outcome,
    outcomeId: def?.id,
    followUpAt,
    channel: a.type === "WHATSAPP" ? (a.channel ?? "WHATSAPP") : undefined,
    // A deleted template must not lose a queued message log.
    templateId,
    def,
    resolved: true,
  };
}

/** Contact changes implied by a new activity (see docs/dialer-plan.md). */
function contactUpdate(contact: { lastActivityAt: Date | null }, a: ResolvedActivity): Prisma.ContactUpdateInput {
  const data: Prisma.ContactUpdateInput = {};
  if (!contact.lastActivityAt || contact.lastActivityAt < a.occurredAt) data.lastActivityAt = a.occurredAt;
  // An older activity synced late (offline phone) must not overwrite newer status/follow-up.
  if (contact.lastActivityAt && a.occurredAt < contact.lastActivityAt) return data;
  if (a.type === "CALL" && a.outcome) {
    data.status = a.outcome;
    data.nextFollowUpAt = keepsFollowUp(a.def, a.outcome) ? (a.followUpAt ?? null) : null;
  } else if (a.type === "NOTE" && a.followUpAt) {
    data.status = "CALL_BACK";
    data.nextFollowUpAt = a.followUpAt;
  }
  return data;
}

const OPEN_ITEM = { in: ["PENDING" as const, "IN_PROGRESS" as const] };

/**
 * Call-list and DNC side effects of an outcome (§2.2). Idempotent, so they run even for an activity older than
 * the contact's newest one. `itemId` is the activity's (validated) call-list item.
 */
async function applyListEffects(
  tx: Prisma.TransactionClient,
  userId: string,
  contact: { id: string; phoneE164: string },
  a: ResolvedActivity,
  itemId: string | null,
) {
  const rule = a.type === "CALL" ? (a.def?.rule ?? null) : null;
  const now = new Date();
  const closed = { claimedById: null, leaseUntil: null, doneById: userId, doneAt: now };
  if (rule === "CLOSE_LEAD") {
    await tx.callListItem.updateMany({
      where: { contactId: contact.id, state: OPEN_ITEM, ...(itemId ? { id: { not: itemId } } : {}) },
      data: { state: "REMOVED", ...closed },
    });
  }
  if (rule === "REMOVE_FROM_LISTS") {
    await tx.callListItem.updateMany({ where: { contactId: contact.id, state: OPEN_ITEM }, data: { state: "REMOVED", ...closed } });
    if (a.def!.addToDnc) {
      await upsertDnc(tx, {
        raw: contact.phoneE164,
        phoneE164: contact.phoneE164,
        reason: `Outcome: ${a.def!.label}`.slice(0, 200),
        source: "OUTCOME",
        createdById: userId,
      });
    }
  }
  if (!itemId) return;
  const state = rule === "RETRY" ? "PENDING" : rule === "REMOVE_FROM_LISTS" ? "REMOVED" : "DONE";
  // Only an item that is still this rep's to work moves: open and not held by someone else (their lease ran out
  // or they never had it), and not already worked by a newer activity. A late, offline-synced outcome never
  // reopens a DONE / SKIPPED / REMOVED item or knocks another rep's claim off it.
  const moved = await tx.callListItem.updateMany({
    where: {
      id: itemId,
      AND: [
        {
          OR: [
            { state: "PENDING" },
            { state: "IN_PROGRESS", claimedById: userId },
            { state: "IN_PROGRESS", claimedById: null },
            { state: "IN_PROGRESS", leaseUntil: { lt: now } },
          ],
        },
        { OR: [{ lastActivityAt: null }, { lastActivityAt: { lte: a.occurredAt } }] },
      ],
    },
    data: {
      attempts: { increment: 1 },
      ...(a.outcome ? { lastOutcome: a.outcome, lastOutcomeId: a.outcomeId ?? null } : {}),
      lastActivityAt: a.occurredAt,
      claimedById: null,
      leaseUntil: null,
      state,
      retryAt: rule === "RETRY" ? (a.followUpAt ?? null) : null,
      doneById: state === "PENDING" ? null : userId,
      doneAt: state === "PENDING" ? null : now,
    },
  });
  if (moved.count > 0) return;
  // Stale: just count the attempt (and its time, when newer).
  await tx.callListItem.update({ where: { id: itemId }, data: { attempts: { increment: 1 } } });
  await tx.callListItem.updateMany({
    where: { id: itemId, OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: a.occurredAt } }] },
    data: { lastActivityAt: a.occurredAt },
  });
}

/** The activity already stored under this clientId (null if none); 409 if another user owns it. */
export async function existingActivity(deps: Deps, clientId: string, userId: string) {
  const existing = await deps.db.activity.findUnique({ where: { clientId }, include: outcomeDefSelect });
  return existing ? sameOwner(existing, userId) : null;
}

/** Creates the activity, updates its contact, and links a matching recorded call. Idempotent on clientId. */
export async function addActivity(deps: Deps, userId: string, contactId: string, input: NewActivity | ResolvedActivity) {
  const a = await resolveActivity(deps.db, input);
  const clientId = a.clientId ?? randomUUID();
  const existing = await existingActivity(deps, clientId, userId);
  if (existing) return existing;

  try {
    return await deps.db.$transaction(async (tx) => {
      // Row lock serialises activities on one contact: no lost contact update, no Call claimed twice.
      await tx.$executeRaw`SELECT 1 FROM contacts WHERE id = ${contactId}::uuid FOR UPDATE`;
      const contact = await tx.contact.findUniqueOrThrow({ where: { id: contactId } });
      const call = a.type === "CALL" ? await findCallFor(tx as Deps["db"], userId, contact.phoneE164, a.occurredAt) : null;
      // A list item from a list this rep is not assigned to is ignored (the activity is still stored).
      const item = a.callListItemId
        ? await tx.callListItem.findFirst({
            where: { id: a.callListItemId, contactId, list: { assignees: { some: { userId } } } },
            select: { id: true },
          })
        : null;
      const activity = await tx.activity.create({
        data: {
          clientId,
          contactId,
          userId,
          type: a.type,
          outcome: a.outcome ?? null,
          outcomeId: a.outcomeId ?? null,
          note: a.note || null,
          followUpAt: a.followUpAt ?? null,
          durationS: a.durationS ?? null,
          occurredAt: a.occurredAt,
          callId: call?.id ?? null,
          via: a.type === "CALL" ? (a.via ?? call?.via ?? null) : null,
          callListItemId: item?.id ?? null,
          channel: a.channel ?? null,
          templateId: a.templateId ?? null,
        },
        include: outcomeDefSelect,
      });
      await tx.contact.update({ where: { id: contactId }, data: contactUpdate(contact, a) });
      if (a.type === "CALL" || a.type === "WHATSAPP") await closeMissedTasks(tx as Deps["db"], userId, contact.phoneE164, a.occurredAt);
      await applyListEffects(tx, userId, contact, a, item?.id ?? null);
      if (call && a.outcome) await requeueSyncedCall(tx, call.id);
      return activity;
    });
  } catch (e) {
    // A concurrent retry with the same clientId won the insert.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return sameOwner(await deps.db.activity.findUniqueOrThrow({ where: { clientId }, include: outcomeDefSelect }), userId);
    }
    throw e;
  }
}

/**
 * A later call or WhatsApp to the number is the follow-up: close this rep's open follow-up tasks (missed calls and
 * new leads alike: no kind filter) that happened before `at`.
 */
export async function closeMissedTasks(db: Deps["db"], userId: string, phoneE164: string, at: Date) {
  await db.followUpTask.updateMany({
    where: { userId, phoneE164, state: "OPEN", occurredAt: { lt: at } },
    data: { state: "DONE", doneAt: new Date() },
  });
}

function sameOwner<T extends { userId: string }>(a: T, userId: string): T {
  if (a.userId !== userId) throw new HttpError(409, "clientId already used");
  return a;
}

/**
 * Finds or creates the contact for a number. The first rep to log an activity owns it; that includes an existing
 * contact nobody owns yet (imported from CSV, or put on a call list).
 */
export async function upsertContact(deps: Deps, phoneE164: string, ownerId: string, name?: string, company?: string) {
  const fields = { ...(name ? { name } : {}), ...(company ? { company } : {}) };
  const upsert = () =>
    deps.db.contact.upsert({ where: { phoneE164 }, create: { phoneE164, ownerId, ...fields }, update: fields });
  let c;
  try {
    c = await upsert();
  } catch (e) {
    // Two reps' first activity on a new number at the same moment: the loser retries as an update.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") c = await upsert();
    else throw e;
  }
  if (c.ownerId === null) {
    const { count } = await deps.db.contact.updateMany({ where: { id: c.id, ownerId: null }, data: { ownerId } });
    if (count === 1) return { ...c, ownerId };
  }
  return c;
}
