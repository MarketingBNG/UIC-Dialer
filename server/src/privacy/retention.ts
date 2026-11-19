import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { LocalStorage } from "../storage/local.js";
import { getPrivacySettings } from "./settings.js";

export const RETENTION_INTERVAL_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
const BATCH = 500;
const OPEN_JOB = { status: { in: ["QUEUED" as const, "RUNNING" as const, "WAITING_BUDGET" as const] } };

/** `months` calendar months before `now` (UTC), clamped to the last day of a shorter month. */
export function retentionCutoff(now: Date, months: number): Date {
  const d = new Date(now);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** The retention cutoff: retentionDays wins over retentionMonths; null = retention off (the default). */
export function effectiveCutoff(now: Date, p: { retentionDays: number | null; retentionMonths: number | null }): Date | null {
  if (p.retentionDays !== null) return new Date(now.getTime() - p.retentionDays * DAY_MS);
  if (p.retentionMonths !== null) return retentionCutoff(now, p.retentionMonths);
  return null;
}

/**
 * Deletes audio files of calls that started before the retention cutoff. With retentionDeleteTranscript, the
 * transcript text (text, segments, English) is blanked in the same guarded step; the summary, action items,
 * sentiment, tags and call score stay. Does nothing while retention is off (the default). Calls with an open job
 * of any kind are skipped so a running job never loses its input. One RETENTION_DELETE audit row per run.
 */
export async function runRetention(
  db: Db,
  storage: LocalStorage,
  now = new Date(),
): Promise<{ deleted: number; bytes: number; transcriptsCleared: number } | null> {
  const { retentionMonths, retentionDays, retentionDeleteTranscript: deleteTranscript } = await getPrivacySettings(db);
  const cutoff = effectiveCutoff(now, { retentionDays, retentionMonths });
  if (!cutoff) return null;
  let deleted = 0;
  let bytes = 0;
  let transcriptsCleared = 0;
  const callIds: string[] = [];
  let after: string | undefined;
  // Audio still on disk, or (when transcripts go too) a transcript that still has text.
  const pending: Prisma.CallWhereInput[] = [{ filePath: { not: null } }];
  if (deleteTranscript) pending.push({ transcript: { text: { not: "" } } });
  for (;;) {
    const calls = await db.call.findMany({
      where: {
        startedAt: { lt: cutoff },
        status: { in: ["TRANSCRIBED", "FAILED"] },
        jobs: { none: OPEN_JOB },
        OR: pending,
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true, filePath: true, fileSize: true, crmStatus: true },
    });
    if (calls.length === 0) break;
    after = calls.at(-1)!.id;
    for (const c of calls) {
      // Clear the row first (guarded on the same path and still no open job), then remove the file:
      // a crash in between leaves an orphan file, never a row pointing at a missing file.
      const cleared = await db.$transaction(async (tx) => {
        const r = await tx.call.updateMany({
          where: { id: c.id, filePath: c.filePath, jobs: { none: OPEN_JOB } },
          data: {
            ...(c.filePath ? { filePath: null, fileSize: null, audioDeletedAt: now } : {}),
            // Blanking the transcript must not re-send the call to Zoho (sync compares transcript updated_at).
            ...(deleteTranscript && c.crmStatus === "SYNCED" ? { crmSyncedAt: now } : {}),
          },
        });
        if (r.count === 0) return null;
        // Raw SQL leaves transcripts.updated_at alone (a Prisma update would bump it and look like a new
        // transcript to the CRM sync); tsv is a generated column and empties itself.
        const t = deleteTranscript
          ? await tx.$executeRaw`UPDATE "transcripts" SET "text" = '', "segments" = NULL, "text_en" = NULL
              WHERE "call_id" = ${c.id}::uuid AND ("text" <> '' OR "segments" IS NOT NULL OR "text_en" IS NOT NULL)`
          : 0;
        return { t };
      });
      if (!cleared) continue;
      if (cleared.t > 0) transcriptsCleared++;
      if (c.filePath) {
        await storage.remove(c.filePath).catch(() => {});
        deleted++;
        bytes += Number(c.fileSize ?? 0n);
      }
      if (callIds.length < 1000) callIds.push(c.id);
    }
    if (calls.length < BATCH) break;
  }
  if (deleted > 0 || transcriptsCleared > 0) {
    await db.auditLog.create({
      data: {
        action: "RETENTION_DELETE",
        detail: {
          deleted,
          bytes,
          transcriptsCleared,
          retentionMonths,
          retentionDays,
          deleteTranscript,
          cutoff: cutoff.toISOString(),
          callIds,
        },
      },
    });
  }
  return { deleted, bytes, transcriptsCleared };
}

const LAST_RUN_KEY = "retention:last_run";
const CHECK_INTERVAL_MS = 3600_000;

/**
 * Claims today's run: true at most once per RETENTION_INTERVAL_MS across restarts and server instances
 * (last run time kept in alert_states.last_sent_at; the conditional update is the lock).
 */
export async function claimRetentionRun(db: Db, now = new Date()): Promise<boolean> {
  await db.alertState.createMany({ data: [{ key: LAST_RUN_KEY }], skipDuplicates: true });
  const r = await db.alertState.updateMany({
    where: { key: LAST_RUN_KEY, OR: [{ lastSentAt: null }, { lastSentAt: { lte: new Date(now.getTime() - RETENTION_INTERVAL_MS) } }] },
    data: { lastSentAt: now },
  });
  return r.count === 1;
}

/** Checks hourly (first a minute after start) and runs retention once a day. Returns a stop function. */
export function startRetentionLoop(
  db: Db,
  storage: LocalStorage,
  onError: (err: unknown) => void,
  onDeleted: (r: { deleted: number; bytes: number; transcriptsCleared: number }) => void,
) {
  const tick = () =>
    claimRetentionRun(db)
      .then((claimed) => (claimed ? runRetention(db, storage) : null))
      .then((r) => {
        if (r && (r.deleted > 0 || r.transcriptsCleared > 0)) onDeleted(r);
      })
      .catch(onError);
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
