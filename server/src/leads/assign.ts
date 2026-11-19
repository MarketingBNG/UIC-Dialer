import { createHash, randomBytes } from "node:crypto";
import type { Deps } from "../context.js";
import { Prisma, type LeadSource } from "../generated/prisma/client.js";
import { numberKey } from "../privacy/clientNumbers.js";

type Tx = Prisma.TransactionClient;

export const LEAD_STATUSES = ["ASSIGNED", "EXISTING_OWNER", "DNC", "NO_REP", "INVALID"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
const MANUAL_RR_KEY = "lead-rr:manual";

export interface LeadFields {
  phoneE164: string;
  name?: string | null | undefined;
  company?: string | null | undefined;
  city?: string | null | undefined;
  note?: string | null | undefined;
  externalId?: string | null | undefined;
}

export interface LeadResult {
  leadId: string;
  contactId: string | null;
  assignedTo: { id: string; name: string | null } | null;
  status: LeadStatus;
}

/** Lead webhook tokens: "uicl_" + 24 random bytes; only the sha256 hex is stored (like refresh tokens). */
export const newLeadToken = () => `uicl_${randomBytes(24).toString("base64url")}`;
export const leadTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Next rep after `cursor` in the sorted pool, wrapping around. */
export function nextInPool(pool: string[], cursor: string | null): string | null {
  if (pool.length === 0) return null;
  const sorted = [...pool].sort();
  return (cursor ? sorted.find((id) => id > cursor) : undefined) ?? sorted[0]!;
}

/**
 * Picks the next rep round-robin with the cursor row locked (FOR UPDATE), so concurrent leads take turns.
 * Source leads use lead_sources.rr_cursor over its pool (empty = all active AGENT/MANAGER users);
 * manual leads use the alert_states row "lead-rr:manual" (last id in `message`) over all active reps.
 */
async function pickRep(tx: Tx, source: LeadSource | null): Promise<string | null> {
  let cursor: string | null;
  let poolIds: string[] = [];
  if (source) {
    const [row] = await tx.$queryRaw<{ rr_cursor: string | null; rep_pool: string[] | null }[]>`
      SELECT "rr_cursor", "rep_pool" FROM "lead_sources" WHERE "id" = ${source.id}::uuid FOR UPDATE`;
    cursor = row?.rr_cursor ?? null;
    poolIds = row?.rep_pool ?? [];
  } else {
    await tx.alertState.createMany({ data: [{ key: MANUAL_RR_KEY }], skipDuplicates: true });
    const [row] = await tx.$queryRaw<{ message: string | null }[]>`
      SELECT "message" FROM "alert_states" WHERE "key" = ${MANUAL_RR_KEY} FOR UPDATE`;
    cursor = row?.message ?? null;
  }
  let pool: string[] = [];
  if (poolIds.length > 0) {
    pool = (await tx.user.findMany({ where: { id: { in: poolIds }, active: true, role: { in: ["AGENT", "MANAGER"] } }, select: { id: true }, orderBy: { id: "asc" } })).map((u) => u.id);
  }
  // An explicit pool with no active rep left means NO_REP, not "everyone".
  if (pool.length === 0 && poolIds.length === 0) {
    pool = (
      await tx.user.findMany({ where: { active: true, role: { in: ["AGENT", "MANAGER"] } }, select: { id: true }, orderBy: { id: "asc" } })
    ).map((u) => u.id);
  }
  const rep = nextInPool(pool, cursor);
  if (rep) {
    if (source) await tx.leadSource.update({ where: { id: source.id }, data: { rrCursor: rep } });
    else await tx.alertState.update({ where: { key: MANUAL_RR_KEY }, data: { message: rep } });
  }
  return rep;
}

const blank = (v: string | null | undefined) => !v || !v.trim();

/**
 * §9.3, in one transaction: DNC check, keep an active existing owner, else round-robin (or `assignTo`), upsert the
 * contact, store the LeadEvent, and give the rep a NEW_LEAD task (+ a NOTE activity with the lead's message).
 * `assignTo`: a user id to assign directly (manual leads); undefined = round-robin.
 */
export async function assignLead(
  deps: Deps,
  source: LeadSource | null,
  f: LeadFields,
  payload: unknown,
  assignTo?: string,
): Promise<LeadResult> {
  return deps.db.$transaction(
    async (tx) => {
      const key = numberKey(f.phoneE164);
      const dnc = await tx.dncNumber.findUnique({ where: { key }, select: { id: true } });
      const existing = await tx.contact.findUnique({
        where: { phoneE164: f.phoneE164 },
        include: { owner: { select: { id: true, active: true } } },
      });
      let status: LeadStatus;
      let repId: string | null = null;
      if (dnc) {
        status = "DNC";
      } else if (existing?.owner?.active) {
        status = "EXISTING_OWNER";
        repId = existing.owner.id;
      } else {
        repId = assignTo ?? (await pickRep(tx, source));
        status = repId ? "ASSIGNED" : "NO_REP";
      }

      const sourceName = source?.name ?? "manual";
      const fill = (field: "name" | "company" | "city") => {
        const v = f[field]?.trim();
        return v && (!existing || blank(existing[field])) ? { [field]: v.slice(0, 200) } : {};
      };
      const fields = { ...fill("name"), ...fill("company"), ...fill("city") };
      let contactId: string;
      if (existing) {
        const ownerFree = !existing.owner || !existing.owner.active;
        await tx.contact.update({
          where: { id: existing.id },
          data: { ...fields, source: sourceName, ...(repId && ownerFree ? { ownerId: repId } : {}) },
        });
        contactId = existing.id;
      } else {
        contactId = (await tx.contact.create({ data: { phoneE164: f.phoneE164, ...fields, source: sourceName, ownerId: repId } })).id;
      }

      const event = await tx.leadEvent.create({
        data: {
          sourceId: source?.id ?? null,
          externalId: f.externalId ?? null,
          contactId,
          assignedToId: repId,
          status,
          payload: (payload ?? {}) as Prisma.InputJsonValue,
        },
      });
      if (repId) {
        const now = new Date();
        await tx.followUpTask.create({
          data: {
            clientId: `lead:${event.id}`,
            userId: repId,
            contactId,
            phoneE164: f.phoneE164,
            callerName: f.name?.trim() || existing?.name || null,
            kind: "NEW_LEAD",
            occurredAt: now,
            dueAt: now,
            leadEventId: event.id,
          },
        });
        const note = f.note?.trim();
        if (note) {
          await tx.activity.create({
            data: { clientId: `lead-note:${event.id}`, contactId, userId: repId, type: "NOTE", note: note.slice(0, 2000), occurredAt: now },
          });
          await tx.contact.updateMany({
            where: { id: contactId, OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: now } }] },
            data: { lastActivityAt: now },
          });
        }
      }
      const rep = repId ? await tx.user.findUnique({ where: { id: repId }, select: { id: true, name: true } }) : null;
      return { leadId: event.id, contactId, assignedTo: rep, status };
    },
    { timeout: 20_000, maxWait: 20_000 },
  );
}

/** A stored event as the webhook's response (idempotent repeats get the first one's). */
export async function leadResultOf(deps: Deps, eventId: string): Promise<LeadResult> {
  const e = await deps.db.leadEvent.findUniqueOrThrow({
    where: { id: eventId },
    include: { assignedTo: { select: { id: true, name: true } } },
  });
  return { leadId: e.id, contactId: e.contactId, assignedTo: e.assignedTo, status: e.status as LeadStatus };
}

/** Reads a value by dot path ("data.phone"); default keys are matched case-insensitively at the top level. */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const DEFAULT_KEYS: Record<string, string[]> = {
  phone: ["phone", "mobile", "phone_number", "mobile_number", "contact", "number"],
  name: ["name", "full_name", "fullname", "sender_name"],
  company: ["company", "company_name", "sender_company"],
  city: ["city", "sender_city"],
  note: ["message", "note", "comments", "query_message", "subject"],
  externalId: ["id", "lead_id", "leadgen_id", "unique_query_id"],
};

export type FieldMap = Partial<Record<"name" | "phone" | "company" | "city" | "note", string>>;

const asText = (v: unknown): string | undefined =>
  typeof v === "string" ? v.trim() || undefined : typeof v === "number" || typeof v === "bigint" ? String(v) : undefined;

/** The lead's fields from a webhook JSON body: field-map dot paths first, then the default key names. */
export function extractLead(body: Record<string, unknown>, fieldMap: FieldMap | null) {
  const lower = new Map(Object.entries(body).map(([k, v]) => [k.toLowerCase(), v]));
  const pick = (field: string): string | undefined => {
    const mapped = fieldMap?.[field as keyof FieldMap];
    if (mapped) {
      const v = asText(readPath(body, mapped));
      if (v) return v;
    }
    for (const k of DEFAULT_KEYS[field] ?? []) {
      const v = asText(lower.get(k));
      if (v) return v;
    }
    return undefined;
  };
  return {
    phone: pick("phone"),
    name: pick("name")?.slice(0, 200),
    company: pick("company")?.slice(0, 200),
    city: pick("city")?.slice(0, 200),
    note: pick("note")?.slice(0, 2000),
    externalId: pick("externalId")?.slice(0, 200),
  };
}
