import { z } from "zod";
import { HttpError, type Deps } from "../context.js";
import type { Prisma } from "../generated/prisma/client.js";
import { numberKey } from "../privacy/clientNumbers.js";
import { toE164 } from "../phone.js";

export const MAX_IMPORT_ROWS = 20_000;
const CHUNK = 500;

/**
 * RFC-4180-ish CSV: quoted fields with "" escapes and commas / newlines inside quotes, CRLF or LF line ends,
 * ";" or tab as the delimiter when the first line has no comma, a leading BOM stripped. Blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = firstLine.includes(",") ? "," : firstLine.includes(";") ? ";" : firstLine.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      field = "";
      quoted = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
}

export const Mapping = z.object({
  name: z.number().int().min(0).max(200).nullable(),
  phone: z.number().int().min(0).max(200),
  company: z.number().int().min(0).max(200).nullable(),
  city: z.number().int().min(0).max(200).nullable(),
});
export type Mapping = z.infer<typeof Mapping>;

const HEADERS: Record<keyof Mapping, string[]> = {
  name: ["name", "full name", "contact", "contact name"],
  phone: [
    "phone", "mobile", "number", "phone number", "mobile number", "contact number", "whatsapp", "whatsapp number", "tel",
    "telephone", "cell", "cell phone", "cellphone", "phone no", "phone no.", "mobile no", "mobile no.", "contact no",
    "contact no.", "phone_number", "mobile_number", "phone1", "phone 1", "mobile1", "mobile 1",
  ],
  company: ["company", "firm", "organisation", "organization", "business"],
  city: ["city", "town", "location"],
};

/** Header auto-match. No phone header = the first row is data, and phone = first column with a 10+ digit value. */
export function autoMapping(rows: string[][]): { mapping: Mapping; hasHeader: boolean } {
  const first = rows[0] ?? [];
  const norm = first.map((h) => h.trim().toLowerCase());
  const find = (k: keyof Mapping) => {
    const i = norm.findIndex((h) => HEADERS[k].includes(h));
    return i >= 0 ? i : null;
  };
  const phone = norm.findIndex((h) => HEADERS.phone.includes(h));
  if (phone >= 0) {
    const name = norm.findIndex((h, i) => i !== phone && HEADERS.name.includes(h));
    return {
      hasHeader: true,
      mapping: { phone, name: name >= 0 ? name : null, company: find("company"), city: find("city") },
    };
  }
  const guess = first.findIndex((v) => v.replace(/\D/g, "").length >= 10);
  return { hasHeader: false, mapping: { phone: Math.max(guess, 0), name: null, company: null, city: null } };
}

export interface ImportRow {
  row: number; // 1-based line in the file (header included)
  name: string | null;
  phoneRaw: string;
  phoneE164: string | null;
  company: string | null;
  city: string | null;
}

/** Applies the mapping; a header row is skipped. 400 above MAX_IMPORT_ROWS data rows. */
export function mapRows(rows: string[][], mapping: Mapping, hasHeader: boolean, region: string): ImportRow[] {
  const data = hasHeader ? rows.slice(1) : rows;
  if (data.length > MAX_IMPORT_ROWS) throw new HttpError(400, `Too many rows (max ${MAX_IMPORT_ROWS})`);
  const cell = (r: string[], i: number | null) => (i === null ? null : (r[i] ?? "").trim().slice(0, 200) || null);
  return data.map((r, i) => {
    const phoneRaw = (r[mapping.phone] ?? "").trim();
    return {
      row: i + 1 + (hasHeader ? 1 : 0),
      name: cell(r, mapping.name),
      phoneRaw,
      phoneE164: toE164(phoneRaw, region) ?? null,
      company: cell(r, mapping.company),
      city: cell(r, mapping.city),
    };
  });
}

export type RowStatus = "new" | "existing" | "bad" | "dnc";

/**
 * Per-row status: bad number, DNC, existing contact (numbers are globally unique), or new. `existing` covers every
 * contact with the number; `mine` only those inside `scope` (the importer's listable contacts).
 */
export async function classify(db: Deps["db"], rows: ImportRow[], scope: Prisma.ContactWhereInput = {}) {
  const phones = [...new Set(rows.flatMap((r) => (r.phoneE164 ? [r.phoneE164] : [])))];
  const existing = new Set<string>();
  const mine = new Set<string>();
  const dnc = new Set<string>();
  for (let i = 0; i < phones.length; i += CHUNK) {
    const chunk = phones.slice(i, i + CHUNK);
    const [found, inScope, blocked] = await Promise.all([
      db.contact.findMany({ where: { phoneE164: { in: chunk } }, select: { phoneE164: true } }),
      db.contact.findMany({ where: { AND: [{ phoneE164: { in: chunk } }, scope] }, select: { phoneE164: true } }),
      db.dncNumber.findMany({ where: { key: { in: chunk.map(numberKey) } }, select: { key: true } }),
    ]);
    for (const c of found) existing.add(c.phoneE164);
    for (const c of inScope) mine.add(c.phoneE164);
    for (const d of blocked) dnc.add(d.key);
  }
  const statusOf = (r: ImportRow): RowStatus =>
    !r.phoneE164 ? "bad" : dnc.has(numberKey(r.phoneE164)) ? "dnc" : existing.has(r.phoneE164) ? "existing" : "new";
  return { statusOf, existing, mine, dnc };
}

/**
 * Preview counts (§4.4). DNC rows are counted as `dnc` (they still import, but never go on a list). Existing contacts
 * outside the importer's scope are left alone by the import; they are reported only as the aggregate
 * `existingElsewhere` (also inside `existing`), never per row, so the preview is not a lookup into other teams.
 */
export async function previewImport(db: Deps["db"], rows: ImportRow[], scope: Prisma.ContactWhereInput = {}) {
  const { statusOf, mine } = await classify(db, rows, scope);
  const seen = new Set<string>();
  const counts = { total: rows.length, new: 0, existing: 0, existingElsewhere: 0, bad: 0, duplicateInFile: 0, dnc: 0 };
  const badSample: string[] = [];
  for (const r of rows) {
    const s = statusOf(r);
    if (s === "bad") {
      counts.bad++;
      if (badSample.length < 10) badSample.push(`row ${r.row}: ${r.phoneRaw.slice(0, 40)}`);
      continue;
    }
    if (seen.has(r.phoneE164!)) {
      counts.duplicateInFile++;
      continue;
    }
    seen.add(r.phoneE164!);
    counts[s]++;
    if (s === "existing" && !mine.has(r.phoneE164!)) counts.existingElsewhere++;
  }
  const sample = rows.slice(0, 20).map((r) => ({ name: r.name, phoneE164: r.phoneE164, company: r.company, city: r.city, status: statusOf(r) }));
  return { ...counts, badSample, sample };
}

/**
 * Creates new contacts (owner, source "csv") and fills name / company / city of existing ones inside `scope` (the
 * importer's listableScope) when the CSV value is non-empty (owner and status untouched). Existing contacts outside
 * the scope are neither changed nor returned; they count as `ownedElsewhere`. Batches of 500 in transactions.
 * Returns the in-scope contact ids in file order (deduplicated) and which of them are on the DNC list.
 */
export async function runImport(db: Deps["db"], rows: ImportRow[], ownerId: string | null, scope: Prisma.ContactWhereInput) {
  const { dnc } = await classify(db, rows, scope);
  const byPhone = new Map<string, ImportRow>();
  let skipped = 0;
  for (const r of rows) {
    if (!r.phoneE164 || byPhone.has(r.phoneE164)) {
      skipped++;
      continue;
    }
    byPhone.set(r.phoneE164, r);
  }
  const unique = [...byPhone.values()];
  let created = 0;
  let updated = 0;
  let ownedElsewhere = 0;
  const idByPhone = new Map<string, string>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    await db.$transaction(
      async (tx) => {
        const phones = chunk.map((r) => r.phoneE164!);
        const [found, inScope] = await Promise.all([
          tx.contact.findMany({ where: { phoneE164: { in: phones } }, select: { phoneE164: true } }),
          tx.contact.findMany({ where: { AND: [{ phoneE164: { in: phones } }, scope] } }),
        ]);
        const taken = new Set(found.map((c) => c.phoneE164));
        const have = new Map(inScope.map((c) => [c.phoneE164, c]));
        ownedElsewhere += found.filter((c) => !have.has(c.phoneE164)).length;
        const fresh = chunk.filter((r) => !taken.has(r.phoneE164!));
        if (fresh.length > 0) {
          created += (
            await tx.contact.createMany({
              data: fresh.map((r) => ({ phoneE164: r.phoneE164!, name: r.name, company: r.company, city: r.city, ownerId, source: "csv" })),
              skipDuplicates: true,
            })
          ).count;
        }
        for (const r of chunk) {
          const c = have.get(r.phoneE164!);
          if (!c) continue;
          const data = {
            ...(r.name && r.name !== c.name ? { name: r.name } : {}),
            ...(r.company && r.company !== c.company ? { company: r.company } : {}),
            ...(r.city && r.city !== c.city ? { city: r.city } : {}),
          };
          if (Object.keys(data).length > 0) {
            await tx.contact.update({ where: { id: c.id }, data });
            updated++;
          }
        }
        // Ids only for contacts the importer may list: the in-scope existing ones and the ones just created.
        const ids = await tx.contact.findMany({ where: { AND: [{ phoneE164: { in: phones } }, scope] }, select: { id: true, phoneE164: true } });
        for (const c of ids) idByPhone.set(c.phoneE164, c.id);
      },
      { timeout: 60_000 },
    );
  }
  const contactIds: string[] = [];
  const dncIds = new Set<string>();
  for (const r of unique) {
    const id = idByPhone.get(r.phoneE164!);
    if (!id) continue;
    contactIds.push(id);
    if (dnc.has(numberKey(r.phoneE164!))) dncIds.add(id);
  }
  return { created, updated, skipped, ownedElsewhere, contactIds, dncIds };
}
