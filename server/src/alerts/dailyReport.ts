import type { Db } from "../db.js";
import { getSettings } from "../settings.js";
import type { AlertSender } from "./cliq.js";
import { sendAlert } from "./cliq.js";

/** Report goes out once a day after this hour (IST). */
const REPORT_HOUR_IST = 10;
const IST_MS = 5.5 * 3600_000;
const DAY = 24 * 3600_000;

interface PhoneRow {
  email: string;
  model: string | null;
  appVersion: string | null;
  permissionsOk: boolean;
  pendingCount: number;
  lastSyncAt: Date | null;
  lastSeenAt: Date | null;
  calls7d: number | null;
  recordings7d: number | null;
  /** Recordings this week that made a second row for a call (old app bug). */
  dupes7d?: number;
}

/** One line per phone that needs attention; empty when all is well. Pure, for tests. */
export function phoneProblems(p: PhoneRow, latest: string | null, now: Date): string[] {
  const out: string[] = [];
  if (!p.permissionsOk) out.push("permissions missing");
  if (p.calls7d != null && p.calls7d >= 5 && (p.recordings7d ?? 0) < p.calls7d * 0.5) out.push(`recording off? ${p.recordings7d ?? 0} recordings / ${p.calls7d} calls (7 days)`);
  if (p.pendingCount >= 50) out.push(`${p.pendingCount} waiting to upload`);
  if (p.pendingCount > 0 && (!p.lastSyncAt || now.getTime() - p.lastSyncAt.getTime() > DAY)) out.push(`no upload since ${p.lastSyncAt ? p.lastSyncAt.toISOString().slice(0, 10) : "ever"}`);
  if (p.lastSeenAt && now.getTime() - p.lastSeenAt.getTime() > 2 * DAY) out.push(`offline since ${p.lastSeenAt.toISOString().slice(0, 10)}`);
  if ((p.dupes7d ?? 0) >= 2) out.push(`${p.dupes7d} duplicate recordings this week (update the app)`);
  if (latest && p.appVersion && p.appVersion !== latest) out.push(`old app ${p.appVersion} (latest ${latest})`);
  return out;
}

export function reportText(rows: PhoneRow[], latest: string | null, now: Date): string {
  const lines: string[] = [];
  for (const r of rows) {
    const probs = phoneProblems(r, latest, now);
    if (probs.length) lines.push(`• ${r.email} (${r.model ?? "phone"}): ${probs.join("; ")}`);
  }
  const head = `Daily phone check: ${rows.length} phones, ${lines.length} need attention.`;
  return lines.length ? `${head}\n${lines.join("\n")}` : `${head} All good.`;
}

/** Sends the daily report once per IST day, after REPORT_HOUR_IST. Safe to call every few minutes. */
export async function dailyPhoneReport(db: Db, send: AlertSender, now = new Date()): Promise<boolean> {
  const ist = new Date(now.getTime() + IST_MS);
  if (ist.getUTCHours() < REPORT_HOUR_IST) return false;
  const day = ist.toISOString().slice(0, 10);
  const key = `daily-phone-report:${day}`;
  if (await db.alertState.findUnique({ where: { key } })) return false;
  const rows = await db.device.findMany({
    where: { revokedAt: null, user: { active: true }, lastSeenAt: { gte: new Date(now.getTime() - 14 * DAY) } },
    select: {
      id: true, model: true, appVersion: true, permissionsOk: true, pendingCount: true, lastSyncAt: true, lastSeenAt: true,
      calls7d: true, recordings7d: true, user: { select: { email: true } },
    },
    orderBy: { user: { email: "asc" } },
  });
  if (!rows.length) return false;
  const dupes = await db.$queryRaw<{ device_id: string; n: number }[]>`
    SELECT b.device_id, count(*)::int AS n FROM calls b
    WHERE b.device_id IS NOT NULL AND b.call_log_key IS NULL AND b.file_path IS NOT NULL AND b.started_at > ${new Date(now.getTime() - 7 * DAY)}
      AND EXISTS (SELECT 1 FROM calls a WHERE a.user_id = b.user_id AND a.started_at = b.started_at AND a.id <> b.id AND a.call_log_key IS NOT NULL)
    GROUP BY b.device_id`;
  const dupesBy = new Map(dupes.map((d) => [d.device_id, d.n]));
  const { latestApp } = await getSettings(db);
  const text = reportText(rows.map((r) => ({ ...r, email: r.user.email, dupes7d: dupesBy.get(r.id) ?? 0 })), latestApp?.versionName ?? null, now);
  return sendAlert(db, send, key, text, now, { repeat: false });
}
