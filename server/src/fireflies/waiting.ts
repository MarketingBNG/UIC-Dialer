import type { Db } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";

/**
 * Jobs whose audio is with Fireflies don't hold a worker while Fireflies works (that took hours and timed out).
 * The worker uploads (with a webhook), hands the job back here, and it waits as WAITING_BUDGET with this prefix.
 * The webhook makes it runnable at once; otherwise a worker checks again every RECHECK_MS. Each check is one quick
 * look, not a long wait, and doesn't count as an attempt.
 */
export const WAIT_PREFIX = "WAITING_BUDGET: FIREFLIES";
export const RECHECK_MS = 15 * 60_000;
/** No transcript this long after the (last) upload: give up, the job fails and shows as failed. */
export const GIVE_UP_MS = 24 * 3600_000;
/** Calls uploaded and still waiting at once; more stay queued so Fireflies isn't handed the whole backlog. */
export const MAX_IN_FLIGHT = 500;

export const inFlight = (db: Db | Prisma.TransactionClient) =>
  db.job.count({ where: { kind: "transcribe", status: "WAITING_BUDGET", lastError: { startsWith: WAIT_PREFIX } } });

/** Worker hand-back after an upload or a not-ready check. */
export async function waitForFireflies(db: Db, jobId: string, workerId: string, now = new Date()): Promise<"waiting" | "failed" | "lost"> {
  const job = await db.job.findFirst({ where: { id: jobId, status: "RUNNING", lockedBy: workerId }, select: { callId: true } });
  if (!job) return "lost";
  const upload = await db.firefliesReservation.findFirst({
    where: { callId: job.callId, uploadedAt: { not: null } },
    orderBy: { uploadedAt: "desc" },
    select: { uploadedAt: true },
  });
  if (upload?.uploadedAt && now.getTime() - upload.uploadedAt.getTime() > GIVE_UP_MS) {
    await db.$executeRaw`
      UPDATE "jobs" SET "status" = 'FAILED', "locked_at" = NULL, "locked_by" = NULL, "finished_at" = now(),
        "last_error" = 'Fireflies returned no transcript within 24 hours of upload', "updated_at" = now()
      WHERE "id" = ${jobId}::uuid AND "locked_by" = ${workerId}`;
    await db.call.updateMany({ where: { id: job.callId, status: "TRANSCRIBING" }, data: { status: "FAILED" } });
    return "failed";
  }
  const n = await db.$executeRaw`
    UPDATE "jobs" SET "status" = 'WAITING_BUDGET', "attempts" = greatest("attempts" - 1, 0),
      "locked_at" = NULL, "locked_by" = NULL, "run_after" = ${new Date(now.getTime() + RECHECK_MS)},
      "last_error" = ${`${WAIT_PREFIX}: uploaded, waiting for the transcript`}, "updated_at" = now()
    WHERE "id" = ${jobId}::uuid AND "status" = 'RUNNING' AND "locked_by" = ${workerId}`;
  return n === 1 ? "waiting" : "lost";
}

/** Webhook: Fireflies says this call's transcript is ready; let a worker fetch it now. */
export async function transcriptReady(db: Db, callId: string): Promise<number> {
  const { count } = await db.job.updateMany({
    where: { callId, kind: "transcribe", status: "WAITING_BUDGET", lastError: { startsWith: WAIT_PREFIX } },
    data: { runAfter: new Date() },
  });
  return count;
}
