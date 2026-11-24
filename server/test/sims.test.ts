import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isNewSim } from "../src/devices/sims.js";
import { setupTestApp, sha256, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const heartbeat = (headers: Record<string, string>, sims: unknown[]) =>
  t.app.inject({ method: "POST", url: "/v1/device/heartbeat", headers, payload: { pendingCount: 0, permissionsOk: true, sims } });

describe("SIM numbers", () => {
  it("tags calls with the SIM's number; rep fills it, admin overrides and locks it", async () => {
    const email = uniqueEmail("rep");
    const rep = await t.loginDevice(email);
    const adminEmail = uniqueEmail("admin");
    await t.loginDevice(adminEmail, "ADMIN");
    const admin = await t.sessionFor(adminEmail);

    expect((await heartbeat(rep.headers, [{ key: "1", slot: 0, carrier: "Jio" }, { key: "2", slot: 1, carrier: "Airtel", number: "9811111111" }])).statusCode).toBe(204);
    const sims = (await t.app.inject({ method: "GET", url: "/v1/device/sims", headers: rep.headers })).json().sims;
    expect(sims).toEqual([
      { key: "1", slot: 0, carrier: "Jio", number: null, numberSetBy: null },
      { key: "2", slot: 1, carrier: "Airtel", number: "+919811111111", numberSetBy: "SIM" },
    ]);

    const put = (number: string | null) => t.app.inject({ method: "PUT", url: "/v1/device/sims", headers: rep.headers, payload: { simKey: "1", number } });
    expect((await put("12")).statusCode).toBe(400);
    expect((await put("98222 22222")).statusCode).toBe(204);

    const res = await t.app.inject({
      method: "POST", url: "/v1/calls", headers: rep.headers,
      payload: { originalSha256: sha256(randomUUID()), phoneNumber: "9900000000", direction: "OUTGOING", startedAt: new Date().toISOString(), simKey: "1", simSlot: 0 },
    });
    expect(res.statusCode).toBe(201);

    const list = async () => (await t.app.inject({ method: "GET", url: "/api/calls", headers: admin })).json().items
      .find((c: { id: string }) => c.id === res.json().callId);
    expect(await list()).toMatchObject({ fromNumber: "+919822222222", simSlot: 0, simCarrier: "Jio" });
    const detail = await t.app.inject({ method: "GET", url: `/api/calls/${res.json().callId}`, headers: admin });
    expect(detail.json()).toMatchObject({ fromNumber: "+919822222222" });

    const device = (await t.app.inject({ method: "GET", url: "/api/devices", headers: admin })).json()
      .find((d: { user: { email: string } }) => d.user.email === email);
    const set = await t.app.inject({ method: "PUT", url: `/api/devices/${device.id}/sims`, headers: admin, payload: { simKey: "1", number: "9833333333" } });
    expect(set.statusCode).toBe(204);
    // Past calls follow the corrected number; the rep can no longer change it, and the SIM can't overwrite it.
    expect((await list()).fromNumber).toBe("+919833333333");
    expect((await put("9844444444")).statusCode).toBe(409);
    await heartbeat(rep.headers, [{ key: "1", slot: 0, number: "9855555555" }]);
    expect((await list()).fromNumber).toBe("+919833333333");
  });

  it("flags only a SIM reported a day or more after the device's first SIM report, for a week", () => {
    const now = new Date();
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86400_000);
    const first = daysAgo(30);
    expect(isNewSim({ reportedAt: daysAgo(2) }, first, now)).toBe(true);
    expect(isNewSim({ reportedAt: daysAgo(10) }, first, now)).toBe(false); // over a week ago
    expect(isNewSim({ reportedAt: first }, first, now)).toBe(false); // there at rollout
    expect(isNewSim({ reportedAt: null }, first, now)).toBe(false); // known only from calls
    expect(isNewSim({ reportedAt: daysAgo(2) }, null, now)).toBe(false);
  });
});
