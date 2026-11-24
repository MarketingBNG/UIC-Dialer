import { z } from "zod";
import type { Db } from "../db.js";
import { toE164 } from "../phone.js";

/** A SIM as the phone reports it. key = the call log's PHONE_ACCOUNT_ID for that SIM. */
export const SimReport = z.object({
  key: z.string().min(1).max(100),
  slot: z.number().int().min(0).max(8).nullable().optional(),
  carrier: z.string().max(100).nullable().optional(),
  /** Read from the SIM when Android allows it; often missing. */
  number: z.string().max(40).nullable().optional(),
});
export type SimReport = z.infer<typeof SimReport>;

/** A SIM counts as "new" on the dashboard for this long after a heartbeat first lists it. */
export const NEW_SIM_MS = 7 * 24 * 3600_000;
/** SIMs first listed within this long of the device's first SIM report count as original, not new. */
export const NEW_SIM_GRACE_MS = 24 * 3600_000;

/**
 * Records the SIMs a device reports. A number read from the SIM fills in only a missing or SIM-read number,
 * never one the user or an admin typed. [now] is when the SIM was in use (a call's start, or the heartbeat time).
 */
export async function upsertSims(db: Db, deviceId: string, sims: SimReport[], region: string, now = new Date(), fromHeartbeat = true) {
  if (fromHeartbeat && sims.length) {
    await db.device.updateMany({ where: { id: deviceId, simsReportedAt: null }, data: { simsReportedAt: now } });
  }
  const reportedAt = fromHeartbeat ? now : null;
  for (const s of sims) {
    const number = toE164(s.number ?? undefined, region) ?? null;
    const existing = await db.deviceSim.findUnique({ where: { deviceId_simKey: { deviceId, simKey: s.key } } });
    if (!existing) {
      await db.deviceSim
        .create({
          data: {
            deviceId, simKey: s.key, slot: s.slot ?? null, carrier: s.carrier ?? null,
            number, numberSetBy: number ? "SIM" : null, firstSeenAt: now, lastSeenAt: now, reportedAt,
          },
        })
        .catch(() => undefined); // created concurrently by the other path
      continue;
    }
    const simMayWrite = number && (existing.numberSetBy === null || existing.numberSetBy === "SIM");
    await db.deviceSim.update({
      where: { id: existing.id },
      data: {
        slot: s.slot ?? existing.slot,
        carrier: s.carrier ?? existing.carrier,
        lastSeenAt: now > existing.lastSeenAt ? now : existing.lastSeenAt,
        // A backlog call older than the first sighting moves it back, so an old SIM isn't shown as new.
        ...(now < existing.firstSeenAt ? { firstSeenAt: now } : {}),
        ...(reportedAt && !existing.reportedAt ? { reportedAt } : {}),
        ...(simMayWrite ? { number, numberSetBy: "SIM" } : {}),
      },
    });
  }
}

/** Sets a SIM's number by hand. Returns false when the number can't be parsed. */
export async function setSimNumber(
  db: Db, deviceId: string, simKey: string, raw: string | null, by: "USER" | "ADMIN", region: string,
): Promise<boolean> {
  const number = raw ? toE164(raw, region) : null;
  if (raw && !number) return false;
  await db.deviceSim.upsert({
    where: { deviceId_simKey: { deviceId, simKey } },
    create: { deviceId, simKey, number, numberSetBy: number ? by : null },
    update: { number, numberSetBy: number ? by : null },
  });
  return true;
}

export type FromInfo = { fromNumber: string | null; simSlot: number | null; simCarrier: string | null };

/** The rep's own number for each call, via its device's SIM record. */
export async function fromNumbers<T extends { deviceId: string | null; simKey: string | null; simSlot: number | null; simCarrier: string | null }>(
  db: Db, calls: T[],
): Promise<FromInfo[]> {
  const pairs = calls.filter((c) => c.deviceId && c.simKey).map((c) => ({ deviceId: c.deviceId!, simKey: c.simKey! }));
  const sims = pairs.length ? await db.deviceSim.findMany({ where: { OR: pairs } }) : [];
  const byKey = new Map(sims.map((s) => [`${s.deviceId}|${s.simKey}`, s]));
  return calls.map((c) => {
    const s = byKey.get(`${c.deviceId}|${c.simKey}`);
    return { fromNumber: s?.number ?? null, simSlot: s?.slot ?? c.simSlot, simCarrier: s?.carrier ?? c.simCarrier };
  });
}

/**
 * A SIM a heartbeat first listed in the last week, at least a day after the device first reported its SIMs
 * (so the SIMs present at rollout or sign-in are never "new"). Uses only timestamps backlog calls can't move.
 */
export function isNewSim(sim: { reportedAt: Date | null }, simsReportedAt: Date | null, now = new Date()): boolean {
  if (!sim.reportedAt || !simsReportedAt) return false;
  const at = sim.reportedAt.getTime();
  return now.getTime() - at <= NEW_SIM_MS && at - simsReportedAt.getTime() > NEW_SIM_GRACE_MS;
}
