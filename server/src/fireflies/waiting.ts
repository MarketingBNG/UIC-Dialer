import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * Jobs whose audio is with Fireflies don't hold a worker while Fireflies works (that took hours and timed out).
 * The worker uploads (with a webhook), hands the job back here, and it waits as WAITING_BUDGET with this prefix.
 * The webhook makes it runnable at once; otherwise a worker checks again every RECHECK_MS. Each check is one quick
 * look, not a long wait, and doesn't count as an attempt. Nothing times out: a call that is still not ready a day
 * after upload keeps waiting (hourly checks) outside the in-flight limit, so it can't block new uploads.
 */
const BASE = "WAITING_BUDGET: FIREFLIES";
/** Uploaded and waiting; counts toward the in-flight limit. */
export const WAIT_PREFIX = `${BASE}: `;
/** Still no transcript a day after the upload: keeps waiting (never fails), checked hourly, no longer counted. */
export const SLOW_PREFIX = `${BASE}-SLOW: `;
export const RECHECK_MS = 15 * 60_000;
export const SLOW_AFTER_MS = 24 * 3600_000;
export const SLOW_RECHECK_MS = 3600_000;
/** Default for FIREFLIES_MAX_IN_FLIGHT. */
export const MAX_IN_FLIGHT = 40;

export const inFlight = (db: Db | Prisma.TransactionClient) =>
  db.job.count({ where: { kind: "transcribe", status: "WAITING_BUDGET", lastError: { startsWith: WAIT_PREFIX } } });

/** Worker hand-back after an upload or a not-ready check. */
export async function waitForFireflies(db: Db, jobId: string, workerId: string, now = new Date()): Promise<"waiting" | "lost"> {
  const job = await db.job.findFirst({ where: { id: jobId, status: "RUNNING", lockedBy: workerId }, select: { callId: true } });
  if (!job) return "lost";
  const upload = await db.firefliesReservation.findFirst({
    where: { callId: job.callId, uploadedAt: { not: null } },
    orderBy: { uploadedAt: "desc" },
    select: { uploadedAt: true },
  });
  const slow = !!upload?.uploadedAt && now.getTime() - upload.uploadedAt.getTime() > SLOW_AFTER_MS;
  const n = await db.$executeRaw`
    UPDATE "jobs" SET "status" = 'WAITING_BUDGET', "attempts" = greatest("attempts" - 1, 0),
      "locked_at" = NULL, "locked_by" = NULL, "run_after" = ${new Date(now.getTime() + (slow ? SLOW_RECHECK_MS : RECHECK_MS))},
      "last_error" = ${slow ? `${SLOW_PREFIX}no transcript a day after upload; still checking hourly` : `${WAIT_PREFIX}uploaded, waiting for the transcript`}, "updated_at" = now()
    WHERE "id" = ${jobId}::uuid AND "status" = 'RUNNING' AND "locked_by" = ${workerId}`;
  return n === 1 ? "waiting" : "lost";
}

/** Webhook: Fireflies says this call's transcript is ready; let a worker fetch it now. */
export async function transcriptReady(db: Db, callId: string): Promise<number> {
  const { count } = await db.job.updateMany({
    where: { callId, kind: "transcribe", status: "WAITING_BUDGET", lastError: { startsWith: BASE } },
    data: { runAfter: new Date() },
  });
  return count;
}
