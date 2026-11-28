import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
  const email = uniqueEmail("ceadmin");
  await t.db.user.create({ data: { email, role: "ADMIN" } });
  admin = await t.sessionFor(email);
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

describe("client errors", () => {
  it("needs sign-in", async () => {
    const res = await t.app.inject({ method: "POST", url: "/v1/client-errors", payload: { kind: "x", message: "y" } });
    expect(res.statusCode).toBe(401);
  });

  it("stores a phone's report, trims the message, admins list it, reps cannot", async () => {
    const rep = await t.loginDevice(uniqueEmail("cerep"));
    const res = await t.app.inject({ method: "POST", url: "/v1/client-errors", headers: rep.headers, payload: { kind: "upload_failed", message: "m".repeat(500) } });
    expect(res.statusCode).toBe(201);
    const row = await t.db.clientError.findFirstOrThrow({ where: { userId: rep.user.id } });
    expect(row).toMatchObject({ source: "android", kind: "upload_failed" });
    expect(row.message).toHaveLength(300);
    expect(row.deviceId).not.toBeNull();

    // A failed laptop dial is saved too.
    const ack = await t.app.inject({ method: "POST", url: "/v1/remote-dial/ack", headers: rep.headers, payload: { id: randomUUID(), ok: false, error: "No SIM" } });
    expect(ack.statusCode).toBe(200);

    const list = await t.app.inject({ method: "GET", url: "/api/client-errors?days=7", headers: admin });
    expect(list.statusCode).toBe(200);
    const mine = list.json().items.filter((i: { user: { id: string } }) => i.user.id === rep.user.id);
    expect(mine.map((i: { kind: string }) => i.kind)).toEqual(["remote_dial_failed", "upload_failed"]);
    expect(mine[0]).toMatchObject({ message: "No SIM", source: "android", user: { name: expect.any(String) } });

    expect((await t.app.inject({ method: "GET", url: "/api/client-errors", headers: rep.headers })).statusCode).toBe(403);
  });
});
