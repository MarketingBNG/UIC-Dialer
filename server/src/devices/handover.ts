import type { Db } from "../db.js";

/**
 * A rep signs in with their own account on a phone that was used by a now-blocked shared account (e.g. hello@):
 * that phone's calls move to the rep. Same phone = same installId (kept across sign-out). Calls the rep already
 * has (same file or same call-log entry) stay where they are. Returns how many calls moved.
 */
export async function takeOverBlockedDevices(db: Db, userId: string, installId: string): Promise<number> {
  const old = await db.device.findMany({
    where: { installId, userId: { not: userId }, user: { active: false } },
    select: { id: true, user: { select: { email: true } } },
  });
  let moved = 0;
  for (const d of old) {
    const blocked = await db.blockedEmail.findUnique({ where: { email: d.user.email } });
    if (!blocked) continue;
    moved += await db.$executeRaw`
      update calls c set user_id = ${userId}::uuid, updated_at = now()
      where c.device_id = ${d.id}::uuid
        and not exists (select 1 from calls x where x.user_id = ${userId}::uuid and x.original_sha256 = c.original_sha256)
        and (c.call_log_key is null or not exists (select 1 from calls x where x.user_id = ${userId}::uuid and x.call_log_key = c.call_log_key))`;
  }
  return moved;
}
