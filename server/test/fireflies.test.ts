import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { estimateMinutes, nextMonthStart, reserveForJob } from "../src/fireflies/budget.js";
import { DEFAULT_FIREFLIES_CONFIG, saveFirefliesState } from "../src/fireflies/settings.js";
import { MAX_IN_FLIGHT, SLOW_PREFIX, WAIT_PREFIX } from "../src/fireflies/waiting.js";
import { signWebhookPath } from "../src/fireflies/signed-url.js";
import { signAudioPath, verifyAudioSignature } from "../src/fireflies/signed-url.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let userId: string;
const SECRET = "j".repeat(40);

beforeAll(async () => {
  t = await setupTestApp();
  const u = await t.db.user.create({ data: { email: uniqueEmail("ff") } });
  userId = u.id;
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});
beforeEach(async () => {
  await t.db.firefliesReservation.deleteMany({});
  await t.db.job.updateMany({ where: { status: "WAITING_BUDGET" }, data: { status: "DONE" } });
  await saveFirefliesState(t.db, { ...DEFAULT_FIREFLIES_CONFIG, blockedUntil: null, lastError: null, lastErrorAt: null });
});

/** A call with stored audio and a job held by worker "w1". */
async function runningJob(opts: { source?: "LIVE" | "BACKLOG" | "IMPORT"; durationS?: number | null; audio?: Buffer } = {}) {
  const audio = opts.audio ?? randomBytes(1000);
  const callId = randomUUID();
  const filePath = t.storage.callPath(userId, callId, new Date(), "audio/mp4");
  await t.storage.save(Readable.from(audio), filePath, 10_000_000);
  await t.db.call.create({
    data: {
      id: callId, userId, startedAt: new Date(), originalSha256: sha256(randomBytes(8)), mimeType: "audio/mp4",
      filePath, fileSize: BigInt(audio.length), status: "TRANSCRIBING", source: opts.source ?? "LIVE",
      durationS: opts.durationS === undefined ? 600 : opts.durationS,
    },
  });
  const job = await t.db.job.create({
    data: { callId, status: "RUNNING", lockedBy: "w1", lockedAt: new Date(), attempts: 1, priority: opts.source === "LIVE" || !opts.source ? 10 : 0 },
  });
  return { callId, jobId: job.id, audio };
}

const setCfg = (patch: Partial<typeof DEFAULT_FIREFLIES_CONFIG>) =>
  saveFirefliesState(t.db, { ...DEFAULT_FIREFLIES_CONFIG, ...patch, blockedUntil: null, lastError: null, lastErrorAt: null });

const reserveHttp = (jobId: string, workerId = "w1") =>
  t.app.inject({ method: "POST", url: `/internal/fireflies/jobs/${jobId}/reserve`, headers: t.workerHeaders, payload: { workerId } });

describe("signed audio URL", () => {
  it("serves only the signed call, and only before expiry", async () => {
    const a = await runningJob();
    const b = await runningJob();
    const res = await t.app.inject({ method: "GET", url: `/internal/fireflies/audio-url/${a.callId}`, headers: t.workerHeaders });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().url);
    expect(url.pathname).toBe(`/public/audio/${a.callId}.m4a`);

    const ok = await t.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("audio/mp4");
    expect(Buffer.compare(ok.rawPayload, a.audio)).toBe(0);

    const ranged = await t.app.inject({ method: "GET", url: url.pathname + url.search, headers: { range: "bytes=10-19" } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.rawPayload.length).toBe(10);

    // Same signature, other call -> 404.
    const other = await t.app.inject({ method: "GET", url: `/public/audio/${b.callId}.m4a${url.search}` });
    expect(other.statusCode).toBe(404);

    // Tampered signature / expiry.
    const sig = url.searchParams.get("sig")!;
    const exp = url.searchParams.get("exp")!;
    const badSig = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect((await t.app.inject({ method: "GET", url: `${url.pathname}?exp=${exp}&sig=${badSig}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: `${url.pathname}?exp=${Number(exp) + 1}&sig=${sig}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: `${url.pathname}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: "GET", url: `/public/audio/..%2F..%2Fetc%2Fpasswd?exp=${exp}&sig=${sig}` })).statusCode).toBe(404);

    // The internal endpoint needs the worker token.
    expect((await t.app.inject({ method: "GET", url: `/internal/fireflies/audio-url/${a.callId}` })).statusCode).toBe(401);
  });

  it("rejects expired signatures", async () => {
    const callId = randomUUID();
    const past = Date.now() - 25 * 3600_000;
    const { path } = signAudioPath(SECRET, callId, ".m4a", past);
    const q = new URL(path, "http://x").searchParams;
    expect(verifyAudioSignature(SECRET, callId, q.get("exp")!, q.get("sig")!, past)).toBe(true);
    expect(verifyAudioSignature(SECRET, callId, q.get("exp")!, q.get("sig")!)).toBe(false);
    expect(verifyAudioSignature("x".repeat(40), callId, q.get("exp")!, q.get("sig")!, past)).toBe(false);
  });
});

describe("budget reservation", () => {
  it("rounds minutes up and estimates from size", () => {
    expect(estimateMinutes(61, null)).toBe(2);
    expect(estimateMinutes(0, 240_000)).toBe(2); // 120 s at 2 kB/s
    expect(estimateMinutes(null, null)).toBe(1);
  });

  it("reserves within budget and defers live calls past it until next month", async () => {
    await setCfg({ budgetMinutes: 25 });
    const a = await runningJob({ durationS: 600 });
    const r1 = await reserveHttp(a.jobId);
    expect(r1.json()).toMatchObject({ status: "reserved", minutes: 10, uploaded: false, deleteAfterFetch: true });
    // Retry of the same job reuses the reservation.
    expect((await reserveHttp(a.jobId)).json().reservationId).toBe(r1.json().reservationId);

    const b = await runningJob({ durationS: 600 });
    expect((await reserveHttp(b.jobId)).json().status).toBe("reserved");
    const c = await runningJob({ durationS: 600 });
    const r3 = (await reserveHttp(c.jobId)).json();
    expect(r3).toMatchObject({ status: "refused", reason: "BUDGET" });
    expect(new Date(r3.retryAt).getTime()).toBe(nextMonthStart().getTime());
    const job = await t.db.job.findUniqueOrThrow({ where: { id: c.jobId } });
    expect(job).toMatchObject({ status: "WAITING_BUDGET", attempts: 0, lockedBy: null });

    const usage = await t.app.inject({ method: "GET", url: "/api/fireflies/usage", headers: await adminSession() });
    expect(usage.json()).toMatchObject({ budgetMinutes: 25, reservedMinutes: 20, usedMinutes: 0, pct: 80, thresholds: [50, 80] });
  });

  it("finalize: uploaded counts actual minutes, not-uploaded releases", async () => {
    await setCfg({ budgetMinutes: 100 });
    const a = await runningJob({ durationS: 600 });
    const ra = (await reserveHttp(a.jobId)).json();
    await t.app.inject({ method: "POST", url: `/internal/fireflies/reservations/${ra.reservationId}/uploaded`, headers: t.workerHeaders, payload: {} });
    await t.app.inject({ method: "POST", url: `/internal/fireflies/reservations/${ra.reservationId}/finalize`, headers: t.workerHeaders, payload: { actualMinutes: 7 } });
    const b = await runningJob({ durationS: 600 });
    const rb = (await reserveHttp(b.jobId)).json();
    await t.app.inject({ method: "POST", url: `/internal/fireflies/reservations/${rb.reservationId}/finalize`, headers: t.workerHeaders, payload: {} });
    const usage = (await t.app.inject({ method: "GET", url: "/api/fireflies/usage", headers: await adminSession() })).json();
    expect(usage).toMatchObject({ usedMinutes: 7, reservedMinutes: 0 });
  });

  it("never re-uploads a call whose uploaded reservation was settled meanwhile", async () => {
    await setCfg({ budgetMinutes: 100 });
    const a = await runningJob({ durationS: 600 });
    const ra = (await reserveHttp(a.jobId)).json();
    await t.app.inject({ method: "POST", url: `/internal/fireflies/reservations/${ra.reservationId}/uploaded`, headers: t.workerHeaders, payload: {} });
    // Simulate the stale settle (or a hard-stop park until next month).
    await t.db.firefliesReservation.update({ where: { id: ra.reservationId }, data: { status: "COMMITTED" } });
    const again = (await reserveHttp(a.jobId)).json();
    expect(again).toMatchObject({ status: "reserved", reservationId: ra.reservationId, uploaded: true });
    expect(await t.db.firefliesReservation.count({ where: { callId: a.callId } })).toBe(1);
    await t.app.inject({ method: "POST", url: `/internal/fireflies/reservations/${ra.reservationId}/finalize`, headers: t.workerHeaders, payload: { actualMinutes: 4 } });
    const usage = (await t.app.inject({ method: "GET", url: "/api/fireflies/usage", headers: await adminSession() })).json();
    expect(usage).toMatchObject({ usedMinutes: 4, reservedMinutes: 0 });
  });

  it("re-uploads once when Fireflies never returned a transcript for an old upload", async () => {
    await setCfg({ budgetMinutes: 100 });
    const a = await runningJob({ durationS: 60 });
    const ra = (await reserveHttp(a.jobId)).json();
    await t.app.inject({ method: "POST", url: `/internal/fireflies/reservations/${ra.reservationId}/uploaded`, headers: t.workerHeaders, payload: {} });
    // Recent upload: the retry only polls.
    expect((await reserveHttp(a.jobId)).json()).toMatchObject({ reservationId: ra.reservationId, uploaded: true });
    const old = new Date(Date.now() - 7 * 3600_000);
    await t.db.firefliesReservation.update({ where: { id: ra.reservationId }, data: { uploadedAt: old } });
    const fresh = (await reserveHttp(a.jobId)).json();
    expect(fresh).toMatchObject({ status: "reserved", uploaded: false });
    expect(fresh.reservationId).not.toBe(ra.reservationId);
    expect(await t.db.firefliesReservation.findUnique({ where: { id: ra.reservationId } })).toMatchObject({ status: "COMMITTED", uploadedAt: null });
    // The re-upload is lost too: no third upload.
    await t.app.inject({ method: "POST", url: `/internal/fireflies/reservations/${fresh.reservationId}/uploaded`, headers: t.workerHeaders, payload: {} });
    await t.db.firefliesReservation.update({ where: { id: fresh.reservationId }, data: { uploadedAt: old } });
    expect((await reserveHttp(a.jobId)).json()).toMatchObject({ reservationId: fresh.reservationId, uploaded: true });
    expect(await t.db.firefliesReservation.count({ where: { callId: a.callId } })).toBe(2);
  });

  it("hands an uploaded job back to wait, and the webhook makes it runnable at once", async () => {
    await setCfg({ budgetMinutes: 100 });
    const a = await runningJob({ durationS: 60 });
    const ra = (await reserveHttp(a.jobId)).json();
    await t.app.inject({ method: "POST", url: `/internal/fireflies/reservations/${ra.reservationId}/uploaded`, headers: t.workerHeaders, payload: {} });
    const wait = await t.app.inject({ method: "POST", url: `/internal/fireflies/jobs/${a.jobId}/wait`, headers: t.workerHeaders, payload: { workerId: "w1" } });
    expect(wait.json()).toEqual({ status: "waiting" });
    let job = await t.db.job.findUniqueOrThrow({ where: { id: a.jobId } });
    expect(job).toMatchObject({ status: "WAITING_BUDGET", lockedBy: null, attempts: 0 });
    expect(job.lastError?.startsWith(WAIT_PREFIX)).toBe(true);
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    // Wrong worker / not held: 409.
    expect((await t.app.inject({ method: "POST", url: `/internal/fireflies/jobs/${a.jobId}/wait`, headers: t.workerHeaders, payload: { workerId: "w1" } })).statusCode).toBe(409);

    // A bad signature changes nothing but still answers 200.
    const bad = await t.app.inject({ method: "POST", url: `/public/fireflies/webhook/${a.callId}?sig=nope`, payload: {} });
    expect(bad.statusCode).toBe(200);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: a.jobId } })).runAfter.getTime()).toBeGreaterThan(Date.now());
    const good = await t.app.inject({ method: "POST", url: signWebhookPath(t.config.JWT_SECRET, a.callId), payload: { meetingId: "m1" } });
    expect(good.statusCode).toBe(200);
    job = await t.db.job.findUniqueOrThrow({ where: { id: a.jobId } });
    expect(job.runAfter.getTime()).toBeLessThanOrEqual(Date.now());
    expect(job.status).toBe("WAITING_BUDGET");
  });

  it("never times out: a day after the upload it keeps waiting hourly, outside the in-flight limit", async () => {
    await setCfg({ budgetMinutes: 100 });
    const a = await runningJob({ durationS: 60 });
    const ra = (await reserveHttp(a.jobId)).json();
    await t.app.inject({ method: "POST", url: `/internal/fireflies/reservations/${ra.reservationId}/uploaded`, headers: t.workerHeaders, payload: {} });
    await t.db.firefliesReservation.update({ where: { id: ra.reservationId }, data: { uploadedAt: new Date(Date.now() - 25 * 3600_000) } });
    const wait = await t.app.inject({ method: "POST", url: `/internal/fireflies/jobs/${a.jobId}/wait`, headers: t.workerHeaders, payload: { workerId: "w1" } });
    expect(wait.json()).toEqual({ status: "waiting" });
    const job = await t.db.job.findUniqueOrThrow({ where: { id: a.jobId } });
    expect(job.status).toBe("WAITING_BUDGET");
    expect(job.lastError?.startsWith(SLOW_PREFIX)).toBe(true);
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(await t.db.job.count({ where: { callId: a.callId, lastError: { startsWith: WAIT_PREFIX } } })).toBe(0); // not counted
    // The webhook still brings it back at once.
    await t.app.inject({ method: "POST", url: signWebhookPath(t.config.JWT_SECRET, a.callId), payload: {} });
    expect((await t.db.job.findUniqueOrThrow({ where: { id: a.jobId } })).runAfter.getTime()).toBeLessThanOrEqual(Date.now());
    await t.db.job.update({ where: { id: a.jobId }, data: { status: "DONE" } });
  });

  it("stops new uploads while MAX_IN_FLIGHT calls are with Fireflies, but still checks uploaded ones", async () => {
    await setCfg({ budgetMinutes: 100_000 });
    // Parked far in the future so other test files' claims never pick these up.
    const later = new Date(Date.now() + 86_400_000);
    const parked = await runningJob({ durationS: 60 });
    await t.db.job.update({ where: { id: parked.jobId }, data: { status: "WAITING_BUDGET", lastError: `${WAIT_PREFIX}: x`, lockedBy: null, runAfter: later } });
    const extra = Array.from({ length: MAX_IN_FLIGHT - 1 }, () => ({ callId: parked.callId, kind: "transcribe", status: "WAITING_BUDGET" as const, lastError: `${WAIT_PREFIX}: x`, runAfter: later }));
    await t.db.job.createMany({ data: extra });
    const b = await runningJob({ durationS: 60 });
    expect((await reserveHttp(b.jobId)).json()).toMatchObject({ status: "refused", reason: "IN_FLIGHT" });
    await t.db.job.deleteMany({ where: { callId: parked.callId } });
  });

  it("keeps the live reserve away from backlog calls", async () => {
    await setCfg({ budgetMinutes: 100, liveReservePct: 10 });
    for (let i = 0; i < 9; i++) {
      const j = await runningJob({ source: "BACKLOG", durationS: 600 });
      expect((await reserveHttp(j.jobId)).json().status).toBe("reserved");
    }
    const backlog = await runningJob({ source: "IMPORT", durationS: 60 });
    expect((await reserveHttp(backlog.jobId)).json()).toMatchObject({ status: "refused", reason: "BUDGET" });
    const live = await runningJob({ source: "LIVE", durationS: 600 });
    expect((await reserveHttp(live.jobId)).json().status).toBe("reserved");
  });

  it("batch gate pauses backlog after approvedBacklogCount, live unaffected, admin can raise it", async () => {
    await setCfg({ approvedBacklogCount: 2 });
    for (let i = 0; i < 2; i++) {
      const j = await runningJob({ source: "BACKLOG", durationS: 60 });
      expect((await reserveHttp(j.jobId)).json().status).toBe("reserved");
    }
    const third = await runningJob({ source: "BACKLOG", durationS: 60 });
    const r = (await reserveHttp(third.jobId)).json();
    expect(r).toMatchObject({ status: "refused", reason: "BATCH_GATE" });
    expect(new Date(r.retryAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    const live = await runningJob({ durationS: 60 });
    expect((await reserveHttp(live.jobId)).json().status).toBe("reserved");

    const headers = await adminSession();
    const put = await t.app.inject({ method: "PUT", url: "/api/settings/fireflies", headers, payload: { approvedBacklogCount: 3 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ approvedBacklogCount: 3, backlogSent: 2 });
    const job = await t.db.job.findUniqueOrThrow({ where: { id: third.jobId } });
    expect(job.runAfter.getTime()).toBeLessThanOrEqual(Date.now());

    // Managers can read, not write.
    const mgr = await managerSession();
    expect((await t.app.inject({ method: "GET", url: "/api/fireflies/usage", headers: mgr })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "PUT", url: "/api/settings/fireflies", headers: mgr, payload: { budgetMinutes: 1 } })).statusCode).toBe(403);
  });

  it("starts a fresh budget in a new UTC month", async () => {
    await setCfg({ budgetMinutes: 10 });
    const a = await runningJob({ durationS: 600 });
    expect((await reserveForJob(t.db, a.jobId, "w1")).status).toBe("reserved");
    const b = await runningJob({ durationS: 600 });
    expect((await reserveForJob(t.db, b.jobId, "w1")).status).toBe("refused");
    const c = await runningJob({ durationS: 600 });
    const r = await reserveForJob(t.db, c.jobId, "w1", nextMonthStart());
    expect(r.status).toBe("reserved");
  });

  it("never overspends under concurrent reservations", async () => {
    await setCfg({ budgetMinutes: 50 });
    const jobs = await Promise.all(Array.from({ length: 10 }, () => runningJob({ durationS: 600 })));
    const results = await Promise.all(jobs.map((j) => reserveForJob(t.db, j.jobId, "w1")));
    expect(results.filter((r) => r.status === "reserved")).toHaveLength(5);
    expect(results.filter((r) => r.status === "refused")).toHaveLength(5);
  });

  it("hard stop blocks sends until cleared, and shows in stats", async () => {
    const a = await runningJob();
    const block = await t.app.inject({
      method: "POST", url: "/internal/fireflies/block", headers: t.workerHeaders,
      payload: { error: "paid_required: plan limit", jobId: a.jobId, workerId: "w1" },
    });
    expect(block.statusCode).toBe(200);
    expect((await t.db.job.findUniqueOrThrow({ where: { id: a.jobId } })).status).toBe("WAITING_BUDGET");

    const b = await runningJob();
    expect((await reserveHttp(b.jobId)).json()).toMatchObject({ status: "refused", reason: "BLOCKED" });

    const headers = await adminSession();
    const stats = (await t.app.inject({ method: "GET", url: "/api/stats", headers })).json();
    expect(stats.fireflies).toMatchObject({ blocked: true, lastError: "paid_required: plan limit" });
    expect(stats.jobs.WAITING_BUDGET).toBeGreaterThanOrEqual(2);

    const put = await t.app.inject({ method: "PUT", url: "/api/settings/fireflies", headers, payload: { clearBlock: true } });
    expect(put.json().blocked).toBe(false);
    const c = await runningJob();
    expect((await reserveHttp(c.jobId)).json().status).toBe("reserved");
  });

  it("disabled refuses everything", async () => {
    await setCfg({ enabled: false });
    const a = await runningJob();
    expect((await reserveHttp(a.jobId)).json()).toMatchObject({ status: "refused", reason: "DISABLED" });
    expect((await reserveHttp(a.jobId)).statusCode).toBe(409); // no longer held by the worker
  });
});

async function adminSession() {
  const email = uniqueEmail("admin");
  await t.db.user.create({ data: { email, role: "ADMIN" } });
  const s = await t.sessionFor(email);
  return { cookie: s.cookie, origin: s.origin };
}

async function managerSession() {
  const email = uniqueEmail("mgr");
  await t.db.user.create({ data: { email, role: "MANAGER" } });
  const s = await t.sessionFor(email);
  return { cookie: s.cookie, origin: s.origin };
}
