import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nameTime, repairDuplicateRecordings } from "../src/calls/dedupe.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
const MIN = 60_000;

beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

/** a = call-log row of the next call, b = its stray recording, n = the real earlier call without recording. */
async function scenario(opts: { bStatus?: "TRANSCRIBED" | "PENDING_UPLOAD"; name?: (nStart: Date) => string } = {}) {
  const userId = (await t.db.user.create({ data: { email: uniqueEmail("dedupe") } })).id;
  const base = Date.now() - 2 * 3600_000;
  const nStart = new Date(base);
  const next = new Date(base + 5 * MIN);
  const phone = "+919876543210";
  const mk = (data: object) => t.db.call.create({ data: { userId, originalSha256: randomUUID(), ...data } as never });
  const n = await mk({ startedAt: nStart, durationS: 120, status: "NO_RECORDING", callLogKey: `k-${randomUUID()}`, phoneRaw: "9876543210", phoneE164: phone, direction: "OUTGOING" });
  await mk({ startedAt: next, status: "NO_RECORDING", callLogKey: `k-${randomUUID()}`, phoneRaw: "9876543210" });
  const b = await mk({
    startedAt: next, status: opts.bStatus ?? "TRANSCRIBED", filePath: `${userId}/x.m4a`, phoneRaw: phone,
    originalName: opts.name ? opts.name(nStart) : "call.m4a",
  });
  return { userId, n, b };
}

const istName = (d: Date) => {
  const s = new Date(d.getTime() + 5.5 * 3600_000).toISOString();
  return `Call_${s.slice(0, 10).replace(/-/g, "")}_${s.slice(11, 19).replace(/:/g, "")}.m4a`;
};

describe("nightly duplicate repair", () => {
  it("reads the IST time from a file name", () => {
    expect(nameTime("Call_20261127_143005.m4a")?.toISOString()).toBe("2026-11-27T09:00:05.000Z");
    expect(nameTime("call.m4a")).toBeNull();
  });

  it("moves the recording onto the real call and removes the empty row", async () => {
    const { n, b } = await scenario({ name: (d) => istName(new Date(d.getTime() + 10_000)) });
    await repairDuplicateRecordings(t.db);
    expect(await t.db.call.findUnique({ where: { id: n.id } })).toBeNull();
    const fixed = await t.db.call.findUniqueOrThrow({ where: { id: b.id } });
    expect(fixed.startedAt).toEqual(n.startedAt);
    expect(fixed.callLogKey).toBe(n.callLogKey);
    expect(fixed.durationS).toBe(120);
    expect(fixed.direction).toBe("OUTGOING");
    // Second run changes nothing.
    const again = await repairDuplicateRecordings(t.db);
    expect(await t.db.call.findUnique({ where: { id: b.id } })).not.toBeNull();
    expect(again.fixed).toBe(0);
  });

  it("skips a recording still uploading", async () => {
    const { n, b } = await scenario({ bStatus: "PENDING_UPLOAD" });
    await repairDuplicateRecordings(t.db);
    expect(await t.db.call.findUnique({ where: { id: n.id } })).not.toBeNull();
    expect((await t.db.call.findUniqueOrThrow({ where: { id: b.id } })).callLogKey).toBeNull();
  });

  it("skips when the file name time does not match the call", async () => {
    const { n, b } = await scenario({ name: (d) => istName(new Date(d.getTime() + 60 * MIN)) });
    await repairDuplicateRecordings(t.db);
    expect(await t.db.call.findUnique({ where: { id: n.id } })).not.toBeNull();
    expect((await t.db.call.findUniqueOrThrow({ where: { id: b.id } })).callLogKey).toBeNull();
  });

  it("skips when one empty call is claimed by two recordings", async () => {
    const s = await scenario();
    // A second stray recording at another call-log time, whose nearest empty call is the same n.
    const at = new Date(s.n.startedAt.getTime() + 2 * MIN);
    await t.db.call.create({ data: { userId: s.userId, originalSha256: randomUUID(), startedAt: at, status: "NO_RECORDING", callLogKey: `k-${randomUUID()}`, phoneRaw: "9876543210" } });
    // Make that log row not count as an owner (other number) so both b's point at n.
    await t.db.call.updateMany({ where: { userId: s.userId, startedAt: at }, data: { phoneRaw: "9000000000" } });
    const b2 = await t.db.call.create({ data: { userId: s.userId, originalSha256: randomUUID(), startedAt: at, status: "TRANSCRIBED", filePath: "x", phoneRaw: "9876543210" } });
    await repairDuplicateRecordings(t.db);
    expect(await t.db.call.findUnique({ where: { id: s.n.id } })).not.toBeNull();
    expect((await t.db.call.findUniqueOrThrow({ where: { id: s.b.id } })).callLogKey).toBeNull();
    expect((await t.db.call.findUniqueOrThrow({ where: { id: b2.id } })).callLogKey).toBeNull();
  });
});
