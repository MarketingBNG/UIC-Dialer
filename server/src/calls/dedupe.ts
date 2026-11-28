import type { Db } from "../db.js";

/**
 * Nightly repair of "recording attached to the next call" duplicates (old Android app bug).
 * A duplicate b: a recording row with no call_log_key sharing user+started_at with a call-log row.
 * Its real owner n: the latest NO_RECORDING row of the same user and number in the 15 minutes before.
 * The recording (b) takes over n's call-log metadata and n is deleted. Unclear cases are left alone.
 */
const IST_MS = 5.5 * 3600_000;
const MAX_PER_RUN = 500;
const SLACK_MS = 30_000;

interface Pair {
  b: string;
  n: string;
  originalName: string | null;
  nStartedAt: Date;
  nDurationS: number | null;
}

/** Recording time from the file name (IST), e.g. "..._20261127_143005.m4a" or "20261127143005"; null if none. */
export function nameTime(name: string | null): Date | null {
  if (!name) return null;
  const m = /(20\d{2})(\d{2})(\d{2})[_\-\s]?(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - IST_MS);
}

/** True when the file name has no time, or its time falls inside call n (with 30 s slack). */
export function nameFits(p: Pick<Pair, "originalName" | "nStartedAt" | "nDurationS">): boolean {
  const t = nameTime(p.originalName);
  if (!t) return true;
  const start = p.nStartedAt.getTime();
  return t.getTime() >= start - SLACK_MS && t.getTime() <= start + (p.nDurationS ?? 0) * 1000 + SLACK_MS;
}

export async function findDuplicatePairs(db: Db, now = new Date()): Promise<Pair[]> {
  const since = new Date(now.getTime() - 30 * 24 * 3600_000);
  const rows = await db.$queryRaw<{ b: string; n: string; original_name: string | null; n_started_at: Date; n_duration_s: number | null }[]>`
    WITH cand AS (
      SELECT b.id, b.user_id, b.started_at, b.original_name, right(regexp_replace(coalesce(b.phone_raw, ''), '\D', '', 'g'), 10) AS num
      FROM calls b
      WHERE b.call_log_key IS NULL AND b.file_path IS NOT NULL AND b.status <> 'PENDING_UPLOAD' AND b.started_at > ${since}
        AND EXISTS (SELECT 1 FROM calls a WHERE a.user_id = b.user_id AND a.started_at = b.started_at AND a.id <> b.id AND a.call_log_key IS NOT NULL)
    ), m AS (
      SELECT DISTINCT ON (c.id) c.id AS b, n.id AS n, c.original_name, n.started_at AS n_started_at, n.duration_s AS n_duration_s
      FROM cand c
      JOIN calls n ON n.user_id = c.user_id AND n.status = 'NO_RECORDING' AND n.id <> c.id
        AND length(c.num) = 10 AND right(regexp_replace(coalesce(n.phone_raw, ''), '\D', '', 'g'), 10) = c.num
        AND n.started_at >= c.started_at - interval '15 minutes' AND n.started_at <= c.started_at - interval '1 second'
      ORDER BY c.id, n.started_at DESC
    )
    SELECT b, n, original_name, n_started_at, n_duration_s FROM m
    WHERE n IN (SELECT n FROM m GROUP BY n HAVING count(*) = 1)
    ORDER BY n_started_at
    LIMIT ${MAX_PER_RUN}`;
  return rows.map((r) => ({ b: r.b, n: r.n, originalName: r.original_name, nStartedAt: r.n_started_at, nDurationS: r.n_duration_s }));
}

async function repairPair(db: Db, b: string, n: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    // Re-check inside the transaction so a concurrent change (or a second run) never misapplies.
    const ok = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok FROM calls bb JOIN calls nn ON nn.id = ${n}::uuid
      WHERE bb.id = ${b}::uuid AND bb.call_log_key IS NULL AND bb.status <> 'PENDING_UPLOAD' AND nn.status = 'NO_RECORDING'
      FOR UPDATE`;
    if (!ok.length) return false;
    await tx.$executeRaw`UPDATE activities SET call_id = ${b}::uuid WHERE call_id = ${n}::uuid`;
    await tx.$executeRaw`UPDATE dial_intents SET call_id = CASE WHEN EXISTS (SELECT 1 FROM dial_intents WHERE call_id = ${b}::uuid) THEN NULL ELSE ${b}::uuid END WHERE call_id = ${n}::uuid`;
    await tx.$executeRaw`DELETE FROM jobs WHERE call_id = ${n}::uuid`;
    await tx.$executeRaw`DELETE FROM call_scores WHERE call_id = ${n}::uuid`;
    await tx.$executeRaw`DELETE FROM fireflies_reservations WHERE call_id = ${n}::uuid`;
    const [meta] = await tx.$queryRaw<{ key: string | null }[]>`SELECT call_log_key AS key FROM calls WHERE id = ${n}::uuid`;
    await tx.$executeRaw`UPDATE calls SET call_log_key = NULL WHERE id = ${n}::uuid`;
    await tx.$executeRaw`
      UPDATE calls b SET started_at = n.started_at, duration_s = n.duration_s, direction = n.direction, log_type = n.log_type,
        call_log_key = ${meta?.key ?? null}, phone_raw = n.phone_raw, phone_e164 = n.phone_e164,
        contact_name = coalesce(n.contact_name, b.contact_name), via = coalesce(n.via, b.via), updated_at = now()
      FROM calls n WHERE b.id = ${b}::uuid AND n.id = ${n}::uuid`;
    await tx.$executeRaw`DELETE FROM calls WHERE id = ${n}::uuid`;
    return true;
  });
}

/** One repair pass (bounded, idempotent). */
export async function repairDuplicateRecordings(db: Db, now = new Date()) {
  const pairs = await findDuplicatePairs(db, now);
  let fixed = 0;
  let skipped = 0;
  for (const p of pairs) {
    if (!nameFits(p)) { skipped++; continue; }
    if (await repairPair(db, p.b, p.n)) fixed++;
    else skipped++;
  }
  return { found: pairs.length, fixed, skipped };
}

/** Runs the repair once per IST day after 02:00. Safe to call every few minutes. */
export async function nightlyDedupe(db: Db, log: (msg: string) => void = () => {}, now = new Date()) {
  const ist = new Date(now.getTime() + IST_MS);
  if (ist.getUTCHours() < 2) return null;
  const key = `dedupe:${ist.toISOString().slice(0, 10)}`;
  const { count } = await db.alertState.createMany({ data: [{ key }], skipDuplicates: true });
  if (!count) return null;
  const r = await repairDuplicateRecordings(db, now);
  log(`duplicate recordings repair: found ${r.found}, fixed ${r.fixed}, skipped ${r.skipped}`);
  return r;
}
