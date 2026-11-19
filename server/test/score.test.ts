import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let userId: string;
let adminEmail: string;

beforeAll(async () => {
  t = await setupTestApp({ SUMMARIZE_ENABLED: "true", SCORE_ENABLED: "true" });
  userId = (await t.db.user.create({ data: { email: uniqueEmail("score"), name: "Ravi Staff" } })).id;
  adminEmail = uniqueEmail("scoreadmin");
  await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
});
afterAll(async () => {
  // Leave no open jobs behind for other test files (they share the database).
  await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
  await t.app.close();
  await t.db.$disconnect();
});
beforeEach(async () => {
  await t.db.job.updateMany({ where: { status: { in: ["QUEUED", "RUNNING", "WAITING_BUDGET"] } }, data: { status: "DONE" } });
  await t.db.setting.updateMany({ data: { costs: {} } });
});

const worker = (url: string, payload?: object) =>
  t.app.inject({ method: "POST", url, headers: t.workerHeaders, ...(payload ? { payload } : {}) });

async function summarizedCall(summary: string | null = "Talked GST.") {
  const call = await t.db.call.create({
    data: { userId, startedAt: new Date(), originalSha256: sha256(randomBytes(8)), status: "TRANSCRIBED", phoneE164: "+919876543210" },
  });
  await t.db.transcript.create({ data: { callId: call.id, text: "namaste", textEn: "hello", provider: "p", summary } });
  return call;
}

const SUMMARY = { model: "claude-sonnet-5-5", summary: "S", actionItems: [], sentiment: "neutral", tags: [], speakerRoles: [] };
const SCORE = {
  model: "claude-sonnet-5-5",
  overall: 72,
  scriptAdherence: 60,
  sentiment: "positive",
  objections: [{ objection: "Too expensive", handled: true }],
  nextStep: "Send the GST quote",
  strengths: ["Clear intro"],
  improvements: ["Ask for a meeting"],
  scriptId: null,
  usage: { inputTokens: 1000, outputTokens: 200, batch: false },
};

async function claim(kind: string) {
  const res = await worker("/internal/jobs/claim", { workerId: "w-score", kinds: [kind] });
  expect(res.statusCode).toBe(200);
  return res.json().jobs as Record<string, unknown>[];
}

describe("score queueing", () => {
  it("completeSummary queues a score job only when SCORE_ENABLED", async () => {
    const call = await summarizedCall(null);
    const sj = await t.db.job.create({ data: { callId: call.id, kind: "summarize", priority: 10 } });
    await claim("summarize");
    expect((await worker(`/internal/jobs/${sj.id}/summary`, { workerId: "w-score", ...SUMMARY })).statusCode).toBe(204);
    const scoreJobs = await t.db.job.findMany({ where: { callId: call.id, kind: "score" } });
    expect(scoreJobs).toHaveLength(1);
    expect(scoreJobs[0]).toMatchObject({ priority: 10, status: "QUEUED" });

    const off = await setupTestApp({ SUMMARIZE_ENABLED: "true" });
    try {
      const c2 = await summarizedCall(null);
      const j2 = await off.db.job.create({ data: { callId: c2.id, kind: "summarize", status: "RUNNING", lockedBy: "w-off", lockedAt: new Date() } });
      const res = await off.app.inject({ method: "POST", url: `/internal/jobs/${j2.id}/summary`, headers: off.workerHeaders, payload: { workerId: "w-off", ...SUMMARY } });
      expect(res.statusCode).toBe(204);
      expect(await off.db.job.count({ where: { callId: c2.id, kind: "score" } })).toBe(0);
      expect((await off.app.inject({ method: "GET", url: "/api/features", headers: await off.sessionFor(adminEmail) })).json()).toEqual({ scoring: false, summaries: true });
    } finally {
      await off.app.close();
      await off.db.$disconnect();
    }
    expect((await t.app.inject({ method: "GET", url: "/api/features", headers: await t.sessionFor(adminEmail) })).json()).toEqual({ scoring: true, summaries: true });
  });

  it("a re-summary does not queue a second score job while one is running or waiting for budget", async () => {
    for (const status of ["RUNNING", "WAITING_BUDGET"] as const) {
      const call = await summarizedCall();
      await t.db.job.create({ data: { callId: call.id, kind: "score", status } });
      const sj = await t.db.job.create({ data: { callId: call.id, kind: "summarize", status: "RUNNING", lockedBy: "w-score", lockedAt: new Date() } });
      expect((await worker(`/internal/jobs/${sj.id}/summary`, { workerId: "w-score", ...SUMMARY })).statusCode).toBe(204);
      expect(await t.db.job.count({ where: { callId: call.id, kind: "score" } })).toBe(1);
    }
  });

  it("backfill queues summarized calls without a score or an open score job", async () => {
    const a = await summarizedCall();
    const b = await summarizedCall();
    const c = await summarizedCall(null);
    await t.db.callScore.create({ data: { callId: b.id, overall: 1, sentiment: "neutral", objections: [], strengths: [], improvements: [], model: "m" } });
    const h = await t.sessionFor(adminEmail);
    const res = await t.app.inject({ method: "POST", url: "/api/admin/score-backfill", headers: h });
    expect(res.json().queued).toBeGreaterThanOrEqual(1);
    expect(await t.db.job.count({ where: { callId: a.id, kind: "score", status: "QUEUED" } })).toBe(1);
    expect(await t.db.job.count({ where: { callId: { in: [b.id, c.id] }, kind: "score" } })).toBe(0);
    await t.app.inject({ method: "POST", url: "/api/admin/score-backfill", headers: h });
    expect(await t.db.job.count({ where: { callId: a.id, kind: "score" } })).toBe(1);
  });
});

describe("score jobs", () => {
  it("claim payload includes the agent and the call list's script", async () => {
    const call = await summarizedCall();
    const script = await t.db.callScript.create({ data: { name: "Pitch", sections: [{ heading: "Open", text: "Hi" }] } });
    const contact = await t.db.contact.create({ data: { phoneE164: `+91${String(Date.now()).slice(-10)}` } });
    const list = await t.db.callList.create({ data: { name: "L", scriptId: script.id } });
    const item = await t.db.callListItem.create({ data: { listId: list.id, contactId: contact.id, position: 0 } });
    await t.db.activity.create({
      data: { clientId: randomUUID(), contactId: contact.id, userId, type: "CALL", occurredAt: new Date(), callId: call.id, callListItemId: item.id },
    });
    const plain = await summarizedCall();
    await t.db.job.create({ data: { callId: call.id, kind: "score", priority: 5 } });
    await t.db.job.create({ data: { callId: plain.id, kind: "score", priority: 4 } });
    const jobs = await claim("score");
    const withScript = jobs.find((j) => j["callId"] === call.id)!;
    expect(withScript).toMatchObject({ kind: "score", agentName: "Ravi Staff", scriptId: script.id, script: { name: "Pitch", sections: [{ heading: "Open", text: "Hi" }] } });
    // The claim's limit is 1 by default: claim the other one too.
    const more = jobs.length === 1 ? await claim("score") : jobs;
    const without = [...jobs, ...more].find((j) => j["callId"] === plain.id)!;
    expect(without).toMatchObject({ scriptId: null, script: null, agentName: "Ravi Staff" });
  });

  it("stores the score (409 when the lock is lost), records the cost, and the call detail shows it", async () => {
    const call = await summarizedCall();
    const job = await t.db.job.create({ data: { callId: call.id, kind: "score" } });
    const h = await t.sessionFor(adminEmail);
    const pending = (await t.app.inject({ method: "GET", url: `/api/calls/${call.id}`, headers: h })).json();
    expect(pending).toMatchObject({ score: null, scorePending: true });

    await claim("score");
    expect((await worker(`/internal/jobs/${job.id}/score`, { workerId: "someone-else", ...SCORE })).statusCode).toBe(409);
    expect((await worker(`/internal/jobs/${job.id}/score`, { workerId: "w-score", ...SCORE, overall: 101 })).statusCode).toBe(400);
    expect((await worker(`/internal/jobs/${job.id}/score`, { workerId: "w-score", ...SCORE })).statusCode).toBe(204);
    const row = await t.db.callScore.findUniqueOrThrow({ where: { callId: call.id } });
    expect(row).toMatchObject({ overall: 72, scriptAdherence: 60, nextStep: "Send the GST quote", inputTokens: 1000 });
    expect((await t.db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("DONE");
    expect((await t.db.job.findUniqueOrThrow({ where: { id: job.id } })).costUsd).toBeGreaterThan(0);

    const detail = (await t.app.inject({ method: "GET", url: `/api/calls/${call.id}`, headers: h })).json();
    expect(detail.scorePending).toBe(false);
    expect(detail.score).toMatchObject({
      overall: 72,
      scriptAdherence: 60,
      sentiment: "positive",
      objections: [{ objection: "Too expensive", handled: true }],
      nextStep: "Send the GST quote",
      strengths: ["Clear intro"],
      improvements: ["Ask for a meeting"],
      model: "claude-sonnet-5-5",
    });
    const list = (await t.app.inject({ method: "GET", url: `/api/calls?userId=${userId}&limit=100`, headers: h })).json();
    expect(list.items.find((c: { id: string }) => c.id === call.id).score).toBe(72);
  });
});
