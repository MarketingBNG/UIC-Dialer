import { z } from "zod";
import type { Deps } from "../context.js";
import { Prisma, type User } from "../generated/prisma/client.js";
import { dncExistsSql } from "./dnc.js";
import { OUTCOMES, contactScope, istDay } from "./service.js";

export const STATUSES = ["NEW", ...OUTCOMES] as const;
/** Contacts list chips. `dnc` is meant for the dashboard. */
export const CONTACT_FILTERS = ["interested", "callback", "never", "mine", "dnc"] as const;
export type ContactFilterKey = (typeof CONTACT_FILTERS)[number];

/** The dashboard's contact filters (also a call list's `filter` source). */
export const ContactFilter = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(STATUSES).optional(),
  filter: z.enum(CONTACT_FILTERS).optional(),
  ownerId: z.uuid().optional(),
  due: z.enum(["today", "overdue"]).optional(),
});
export type ContactFilter = z.infer<typeof ContactFilter>;

/**
 * name / company / city, digits (3+) against the stored number, and the text of any activity note on the contact.
 * The notes branch is safe for every role: the caller ANDs this with its contact scope.
 */
export function searchWhere(q: string | undefined): Prisma.ContactWhereInput {
  if (!q) return {};
  const or: Prisma.ContactWhereInput[] = [
    { name: { contains: q, mode: "insensitive" } },
    { company: { contains: q, mode: "insensitive" } },
    { city: { contains: q, mode: "insensitive" } },
    { activities: { some: { note: { contains: q, mode: "insensitive" } } } },
  ];
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 3) or.push({ phoneE164: { contains: digits } });
  return { OR: or };
}

/** Ids of contacts whose number is on the do-not-call list (bounded by the DNC list's size). */
async function dncContactIds(db: Deps["db"]): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT c."id" FROM "contacts" c WHERE ${dncExistsSql("c")}`;
  return rows.map((r) => r.id);
}

export async function filterWhere(db: Deps["db"], filter: ContactFilterKey | undefined, userId: string): Promise<Prisma.ContactWhereInput> {
  switch (filter) {
    case "interested":
      return { status: "INTERESTED" };
    case "callback":
      return { status: "CALL_BACK" };
    case "never":
      return { activities: { none: { type: "CALL" } } };
    case "mine":
      return { ownerId: userId };
    case "dnc":
      return { id: { in: await dncContactIds(db) } };
    default:
      return {};
  }
}

/** The /api/contacts where clause: the user's scope plus every filter. */
export async function dashContactWhere(db: Deps["db"], user: User, q: ContactFilter): Promise<Prisma.ContactWhereInput> {
  const { start, end } = istDay();
  const and: Prisma.ContactWhereInput[] = [contactScope(user), searchWhere(q.q), await filterWhere(db, q.filter, user.id)];
  if (q.ownerId) and.push({ ownerId: q.ownerId });
  if (q.status) and.push({ status: q.status });
  if (q.due === "overdue") and.push({ nextFollowUpAt: { lt: start } });
  if (q.due === "today") and.push({ nextFollowUpAt: { gte: start, lt: end } });
  return { AND: and };
}

export const listOrder: Prisma.ContactOrderByWithRelationInput[] = [
  { lastActivityAt: { sort: "desc", nulls: "last" } },
  { id: "desc" },
];
