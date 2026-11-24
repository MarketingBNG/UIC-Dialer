import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callLogKey } from "../src/calls/service.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 10, min, 0, 123)).toISOString();

const postLog = (headers: Record<string, string>, entries: object[]) =>
  t.app.inject({ method: "POST", url: "/v1/calls/log", headers, payload: { entries } });

async function uploadRecording(headers: Record<string, string>, meta: object) {
  const audio = randomBytes(2048);
  const created = await t.app.inject({
    method: "POST",
    url: "/v1/calls",
    headers,
    payload: { originalSha256: sha256(randomBytes(16)), ...meta },
  });
  const put = await t.app.inject({
    method: "PUT",
    url: `/v1/calls/${created.json().callId}/audio`,
    headers: { ...headers, "content-type": "audio/mp4", "x-content-sha256": sha256(audio) },
    payload: audio,
  });
  return { created, put };
}

describe("callLogKey", () => {
  it("uses the start time and the number's last 10 digits", () => {
    const d = new Date(1_700_000_000_123);
    expect(callLogKey(d, "+91 98765-43210")).toBe(callLogKey(d, "098765 43210"));
    expect(callLogKey(d, null)).toBe("1700000000123:");
  });
});

describe("POST /v1/calls/log", () => {
  it("stores missed, rejected and unanswered calls without audio, idempotently", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const entries = [
      { phoneNumber: "9876543210", type: "MISSED", startedAt: at(1), durationS: 0 },
      { phoneNumber: "9876543211", type: "REJECTED", startedAt: at(2), durationS: 0 },
      { phoneNumber: "9876543212", type: "OUTGOING", startedAt: at(3), durationS: 0, contactName: "Asha" },
      { type: "SOMETHING_NEW", startedAt: at(4) },
    ];
    const first = await postLog(s.headers, entries);
    expect(first.statusCode).toBe(200);
    const results = first.json().results as { callId: string; created: boolean }[];
    expect(results.map((r) => r.created)).toEqual([true, true, true, true]);

    const again = await postLog(s.headers, entries);
    expect(again.json().results).toEqual(results.map((r) => ({ ...r, created: false })));
    expect(await t.db.call.count({ where: { userId: s.user.id } })).toBe(4);

    const rows = await t.db.call.findMany({ where: { userId: s.user.id }, orderBy: { startedAt: "asc" }, include: { jobs: true } });
    expect(rows.map((r) => [r.status, r.direction, r.logType])).toEqual([
      ["NO_RECORDING", "MISSED", "MISSED"],
      ["NO_RECORDING", "MISSED", "REJECTED"],
      ["NO_RECORDING", "OUTGOING", "OUTGOING"],
      ["NO_RECORDING", "UNKNOWN", "UNKNOWN"],
    ]);
    // Nothing to transcribe or score.
    expect(rows.every((r) => r.jobs.length === 0 && r.filePath === null)).toBe(true);
    expect(rows[0]!.phoneE164).toBe("+919876543210");
  });

  it("attaches a later recording to the call-log row", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const [log] = (await postLog(s.headers, [{ phoneNumber: "+919811111111", type: "INCOMING", startedAt: at(10), durationS: 61 }])).json().results;
    const { created, put } = await uploadRecording(s.headers, { phoneNumber: "09811111111", direction: "INCOMING", startedAt: at(10), durationS: 61 });
    expect(created.statusCode).toBe(201);
    expect(created.json().callId).toBe(log.callId);
    expect(put.statusCode).toBe(201);

    const rows = await t.db.call.findMany({ where: { userId: s.user.id }, include: { jobs: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("UPLOADED");
    expect(rows[0]!.logType).toBe("INCOMING");
    expect(rows[0]!.jobs).toHaveLength(1);

    // The entry re-sent later still finds the same row and leaves its status alone.
    const again = (await postLog(s.headers, [{ phoneNumber: "+919811111111", type: "INCOMING", startedAt: at(10), durationS: 61 }])).json();
    expect(again.results[0]).toEqual({ callId: log.callId, created: false });
    expect((await t.db.call.findUniqueOrThrow({ where: { id: log.callId } })).status).toBe("UPLOADED");
  });

  it("does not duplicate a call whose recording arrived first", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const { created } = await uploadRecording(s.headers, { phoneNumber: "9822222222", direction: "OUTGOING", startedAt: at(20), durationS: 30 });
    const log = (await postLog(s.headers, [{ phoneNumber: "+91 98222 22222", type: "OUTGOING", startedAt: at(20), durationS: 30 }])).json();
    expect(log.results[0]).toEqual({ callId: created.json().callId, created: false });
    const rows = await t.db.call.findMany({ where: { userId: s.user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("UPLOADED");
    expect(rows[0]!.logType).toBe("OUTGOING");
  });

  it("adopts an older recording row that has no call-log key", async () => {
    const s = await t.loginDevice(uniqueEmail());
    const { created } = await uploadRecording(s.headers, { phoneNumber: "9833333333", direction: "INCOMING", startedAt: at(30), durationS: 30 });
    await t.db.call.update({ where: { id: created.json().callId }, data: { callLogKey: null } });
    const log = (await postLog(s.headers, [{ phoneNumber: "9833333333", type: "INCOMING", startedAt: at(30), durationS: 30 }])).json();
    expect(log.results[0]).toEqual({ callId: created.json().callId, created: false });
    expect(await t.db.call.count({ where: { userId: s.user.id } })).toBe(1);
  });

  it("keeps entries per user", async () => {
    const a = await t.loginDevice(uniqueEmail());
    const b = await t.loginDevice(uniqueEmail());
    const entry = { phoneNumber: "9844444444", type: "MISSED", startedAt: at(40) };
    const ra = (await postLog(a.headers, [entry])).json().results[0];
    const rb = (await postLog(b.headers, [entry])).json().results[0];
    expect(ra.created && rb.created).toBe(true);
    expect(ra.callId).not.toBe(rb.callId);
  });

  it("lists call-log calls only for clients that ask with v=2", async () => {
    const s = await t.loginDevice(uniqueEmail());
    await postLog(s.headers, [{ phoneNumber: "9855555555", type: "MISSED", startedAt: at(50) }]);
    const v1 = await t.app.inject({ method: "GET", url: "/api/calls", headers: s.headers });
    expect(v1.json().items).toHaveLength(0);
    const v2 = await t.app.inject({ method: "GET", url: "/api/calls?v=2", headers: s.headers });
    expect(v2.json().items).toHaveLength(1);
    expect(v2.json().items[0]).toMatchObject({ status: "NO_RECORDING", logType: "MISSED", direction: "MISSED" });
    const detail = await t.app.inject({ method: "GET", url: `/api/calls/${v2.json().items[0].id}`, headers: s.headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().filePath).toBeNull();
  });

  it("rejects bad batches", async () => {
    const s = await t.loginDevice(uniqueEmail());
    expect((await postLog(s.headers, [])).statusCode).toBe(400);
    expect((await postLog(s.headers, [{ type: "MISSED", startedAt: "yesterday" }])).statusCode).toBe(400);
    expect((await t.app.inject({ method: "POST", url: "/v1/calls/log", payload: { entries: [] } })).statusCode).toBe(401);
  });
});
