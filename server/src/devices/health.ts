/** Phone health flags derived from heartbeat fields (shared by /api/devices and the alert loop). */

/** UsageStatsManager.STANDBY_BUCKET_RARE / _RESTRICTED: Android runs our jobs rarely or almost never. */
export const BUCKET_RARE = 30;
export const BUCKET_RESTRICTED = 45;
/** "Calls but no recordings": more than this many 30 s+ calls in 7 days with zero recordings found. */
export const CALLS_NO_REC_MIN = 5;
/** "Missing recordings": at least this many 30 s+ calls in 7 days, and recordings for under LOW_REC_PCT% of them. */
export const LOW_REC_MIN_CALLS = 10;
export const LOW_REC_PCT = 50;

export function bucketName(bucket: number | null | undefined): string | null {
  if (bucket == null) return null;
  if (bucket <= 5) return "ACTIVE";
  if (bucket <= 10) return "WORKING_SET";
  if (bucket <= 20) return "FREQUENT";
  if (bucket <= 30) return "RARE";
  if (bucket <= 45) return "RESTRICTED";
  return "NEVER";
}

/** Health numbers older than this (no heartbeat since) are ignored by the flags and the alert. */
export const HEALTH_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

export interface HealthFields {
  standbyBucket: number | null;
  calls7d: number | null;
  recordings7d: number | null;
  lastSeenAt?: Date | null;
}

/** RARE or worse: background uploads may be delayed by hours or days. */
export const isThrottled = (d: HealthFields) => d.standbyBucket != null && d.standbyBucket >= BUCKET_RARE;

/** The dialer is probably not recording (auto-record off, or a dialer whose files we can't read). */
export const callsWithoutRecordings = (d: HealthFields, now = new Date()) =>
  (d.lastSeenAt === undefined || (d.lastSeenAt != null && now.getTime() - d.lastSeenAt.getTime() <= HEALTH_FRESH_MS)) &&
  d.calls7d != null && d.calls7d > CALLS_NO_REC_MIN && d.recordings7d === 0;

/**
 * Some calls are recorded but most aren't: auto-record on for one SIM only, switched off mid-week, or the
 * recorder folder changed. Not raised when callsWithoutRecordings already is.
 */
export const fewRecordings = (d: HealthFields, now = new Date()) =>
  (d.lastSeenAt === undefined || (d.lastSeenAt != null && now.getTime() - d.lastSeenAt.getTime() <= HEALTH_FRESH_MS)) &&
  d.calls7d != null && d.recordings7d != null && d.recordings7d > 0 &&
  d.calls7d >= LOW_REC_MIN_CALLS && d.recordings7d * 100 < d.calls7d * LOW_REC_PCT;
