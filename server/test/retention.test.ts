import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { effectiveCutoff, runRetention } from "../src/privacy/retention.js";
import { DEFAULT_PRIVACY_SETTINGS, savePrivacySettings } from "../src/privacy/settings.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let userId: string;
let adminEmail: string;
const DAY = 24 * 3600_000;

beforeAll(async () => {
  t = await setupTestApp();
  userId = (await t.db.user.create({ data: { email: uniqueEmail("ret2") } })).id;
  adminEmail = uniqueEmail("ret2admin");
  await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
});
afterAll(async () => {
  // Leave no open jobs behind for other test files (they share the database).
  await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
  await savePrivacySettings(t.db, DEFAULT_PRIVACY_SETTINGS);
  await t.app.close();
  await t.db.$disconnect();
});
beforeEach(async () => {
  await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
});

async function storedCall(daysAgo: number, extra: object = {}) {
  const id = randomUUID();
  const audio = randomBytes(500);
  const rel = `${userId}/ret/${id}.m4a`;
  await mkdir(path.join(t.storage.root, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(t.storage.root, rel), audio);
  const call = await t.db.call.create({
    data: {
      id,
      userId,
      startedAt: new Date(Date.now() - daysAgo * DAY),
      originalSha256: sha256(audio),
      status: "TRANSCRIBED",
      filePath: rel,
      fileSize: 500n,
      ...extra,
    },
  });
  await t.db.transcript.create({
    data: { callId: id, text: "namaste ji", textEn: "hello sir", segments: [{ text: "namaste ji" }], provider: "stub", summary: "Asked about GST.", tags: ["GST"] },
  });
  return { call, rel };
}
const exists = (rel: string) => existsSync(path.join(t.storage.root, rel));

describe("effective cutoff", () => {
  it("days win over months; neither = off", () => {
    const now = new Date("2026-11-18T00:00:00Z");
    expect(effectiveCutoff(now, { retentionDays: 10, retentionMonths: 6 })).toEqual(new Date("2026-11-08T00:00:00Z"));
    expect(effectiveCutoff(now, { retentionDays: null, retentionMonths: 1 })).toEqual(new Date("2026-10-18T00:00:00Z"));
    expect(effectiveCutoff(now, { retentionDays: null, retentionMonths: null })).toBeNull();
  });
});

describe("runRetention with days", () => {
  it("uses the days cutoff, and days win over months", async () => {
    const old = await storedCall(40);
    const recent = await storedCall(10);
    await savePrivacySettings(t.db, { ...DEFAULT_PRIVACY_SETTINGS, retentionMonths: 240, retentionDays: 30 });
    const r = await runRetention(t.db, t.storage);
    expect(r!.deleted).toBeGreaterThanOrEqual(1);
    expect(exists(old.rel)).toBe(false);
    expect(exists(recent.rel)).toBe(true);
    const after = await t.db.call.findUniqueOrThrow({ where: { id: old.call.id }, include: { transcript: true } });
    expect(after.audioDeletedAt).not.toBeNull();
    expect(after.transcript?.text).toBe("namaste ji"); // transcripts kept unless asked
    const row = await t.db.auditLog.findFirstOrThrow({ where: { action: "RETENTION_DELETE" }, orderBy: { createdAt: "desc" } });
    expect(row.detail).toMatchObject({ retentionDays: 30, deleteTranscript: false });
    expect((row.detail as { callIds: string[] }).callIds).toContain(old.call.id);
  });

  it("deleteTranscript empties the text but keeps the summary and score, without re-syncing Zoho", async () => {
    const synced = new Date(Date.now() - 50 * DAY);
    const old = await storedCall(60, { crmStatus: "SYNCED", crmSyncedAt: synced });
    await t.db.callScore.create({
      data: { callId: old.call.id, overall: 80, sentiment: "positive", objections: [], strengths: [], improvements: [], model: "m" },
    });
    // A call whose audio an earlier run already removed still gets its transcript blanked.
    const earlier = await storedCall(60, { filePath: null, fileSize: null, audioDeletedAt: new Date() });
    const before = await t.db.transcript.findUniqueOrThrow({ where: { callId: old.call.id } });
    await savePrivacySettings(t.db, { ...DEFAULT_PRIVACY_SETTINGS, retentionDays: 30, retentionDeleteTranscript: true });
    const r = await runRetention(t.db, t.storage);
    expect(r!.transcriptsCleared).toBeGreaterThanOrEqual(2);
    for (const id of [old.call.id, earlier.call.id]) {
      const tr = await t.db.transcript.findUniqueOrThrow({ where: { callId: id } });
      expect(tr).toMatchObject({ text: "", textEn: null, segments: null, summary: "Asked about GST.", tags: ["GST"] });
    }
    const after = await t.db.transcript.findUniqueOrThrow({ where: { callId: old.call.id } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const call = await t.db.call.findUniqueOrThrow({ where: { id: old.call.id }, include: { score: true } });
    expect(call.score?.overall).toBe(80);
    expect(call.crmSyncedAt!.getTime()).toBeGreaterThan(synced.getTime());
    // Search no longer finds the blanked text (tsv is generated from it).
    const hits = await t.db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM transcripts WHERE call_id = ${old.call.id}::uuid AND tsv @@ websearch_to_tsquery('simple', 'namaste')`;
    expect(Number(hits[0]!.n)).toBe(0);
    const row = await t.db.auditLog.findFirstOrThrow({ where: { action: "RETENTION_DELETE" }, orderBy: { createdAt: "desc" } });
    expect(row.detail).toMatchObject({ deleteTranscript: true });
  });

  it("skips a call with an open job", async () => {
    const busy = await storedCall(60);
    await t.db.job.create({ data: { callId: busy.call.id, kind: "score", status: "QUEUED" } });
    await savePrivacySettings(t.db, { ...DEFAULT_PRIVACY_SETTINGS, retentionDays: 30, retentionDeleteTranscript: true });
    await runRetention(t.db, t.storage);
    expect(exists(busy.rel)).toBe(true);
    expect((await t.db.transcript.findUniqueOrThrow({ where: { callId: busy.call.id } })).text).toBe("namaste ji");
    await savePrivacySettings(t.db, DEFAULT_PRIVACY_SETTINGS);
  });

  it("PUT /api/settings/privacy: writing days clears months", async () => {
    const h = await t.sessionFor(adminEmail);
    await t.app.inject({ method: "PUT", url: "/api/settings/privacy", headers: h, payload: { retentionMonths: 6 } });
    const res = await t.app.inject({
      method: "PUT",
      url: "/api/settings/privacy",
      headers: h,
      payload: { retentionDays: 90, retentionDeleteTranscript: true },
    });
    expect(res.json()).toMatchObject({ retentionDays: 90, retentionMonths: null, retentionDeleteTranscript: true });
    expect((await t.app.inject({ method: "PUT", url: "/api/settings/privacy", headers: h, payload: { retentionDays: 0 } })).statusCode).toBe(400);
    await savePrivacySettings(t.db, DEFAULT_PRIVACY_SETTINGS);
  });
});
