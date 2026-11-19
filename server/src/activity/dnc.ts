import { Prisma, type DncNumber, type DncSource } from "../generated/prisma/client.js";
import type { Deps } from "../context.js";
import { numberKey } from "../privacy/clientNumbers.js";

type Db = Deps["db"] | Prisma.TransactionClient;

/**
 * SQL: is this contacts row's number on the do-not-call list? Same key rule as numberKey() (last 10 digits;
 * right() of a shorter string is the whole string). `alias` is the contacts alias in the surrounding query.
 */
export const dncExistsSql = (alias: string) =>
  Prisma.raw(
    `EXISTS (SELECT 1 FROM "dnc_numbers" d WHERE d."key" = right(regexp_replace(${alias}."phone_e164", '\\D', '', 'g'), 10))`,
  );

/** DNC rows for these numbers, keyed by numberKey(). One query. */
export async function dncFor(db: Db, phones: (string | null | undefined)[]): Promise<Map<string, DncNumber>> {
  const keys = [...new Set(phones.filter((p): p is string => !!p).map(numberKey).filter(Boolean))];
  if (keys.length === 0) return new Map();
  const rows = await db.dncNumber.findMany({ where: { key: { in: keys } } });
  return new Map(rows.map((r) => [r.key, r]));
}

export async function isDnc(db: Db, phone: string): Promise<DncNumber | null> {
  const key = numberKey(phone);
  if (!key) return null;
  return db.dncNumber.findUnique({ where: { key } });
}

/** Adds a number to the list; an existing row (same key) is kept as it is (the first reason wins). */
export async function upsertDnc(
  db: Db,
  input: { raw: string; phoneE164: string | null; reason: string | null; source: DncSource; createdById: string | null },
): Promise<{ row: DncNumber; created: boolean }> {
  const key = numberKey(input.raw);
  const existing = await db.dncNumber.findUnique({ where: { key } });
  if (existing) return { row: existing, created: false };
  try {
    const row = await db.dncNumber.create({
      data: { key, raw: input.raw.slice(0, 40), phoneE164: input.phoneE164, reason: input.reason, source: input.source, createdById: input.createdById },
    });
    return { row, created: true };
  } catch (e) {
    // A concurrent add of the same number won.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { row: await db.dncNumber.findUniqueOrThrow({ where: { key } }), created: false };
    }
    throw e;
  }
}

export const dncInfo = (row: DncNumber | undefined | null) => (row ? { reason: row.reason, createdAt: row.createdAt } : null);

const userRef = { select: { id: true, name: true, email: true } } as const;
export const dncInclude = { createdBy: userRef } as const;
type DncRow = Prisma.DncNumberGetPayload<{ include: typeof dncInclude }>;

export function dncDto(r: DncRow) {
  return {
    id: r.id,
    phoneE164: r.phoneE164,
    raw: r.raw,
    reason: r.reason,
    source: r.source,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}
