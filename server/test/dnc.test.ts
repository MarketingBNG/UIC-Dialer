import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashKey, numberKey } from "../src/privacy/clientNumbers.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: Record<string, string>;
beforeAll(async () => {
  t = await setupTestApp();
  const email = uniqueEmail("dadmin");
  await t.db.user.create({ data: { email, role: "ADMIN" } });
  admin = await t.sessionFor(email);
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

type H = Record<string, string>;
const randomMobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const inject = (method: "GET" | "POST" | "DELETE", url: string, headers: H, payload?: object) =>
  t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

describe("do-not-call list", () => {
  it("adds (upsert keeps the first row), lists, deletes, audits", async () => {
    const phone = randomMobile();
    const first = await inject("POST", "/api/dnc", admin, { phone: `+91 ${phone}`, reason: "Asked not to call" });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ phoneE164: `+91${phone}`, reason: "Asked not to call", source: "MANUAL", createdBy: { email: expect.any(String) } });
    const again = await inject("POST", "/api/dnc", admin, { phone: `0${phone}`, reason: "other" });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ id: first.json().id, reason: "Asked not to call" });
    expect((await inject("POST", "/api/dnc", admin, { phone: "12" })).statusCode).toBe(400);

    const list = await inject("GET", `/api/dnc?q=${phone.slice(-5)}`, admin);
    expect(list.json().items.map((d: { id: string }) => d.id)).toContain(first.json().id);
    expect(list.json().count).toBeGreaterThanOrEqual(1);
    const rep = await t.loginDevice(uniqueEmail("drep"));
    expect((await inject("GET", "/api/dnc", rep.headers)).statusCode).toBe(403);
    // A rep can mark from the phone.
    const fromPhone = await inject("POST", "/v1/dnc", rep.headers, { phone: randomMobile(), reason: "rude" });
    expect(fromPhone.statusCode).toBe(201);
    expect(fromPhone.json().createdBy.id).toBe(rep.user.id);

    expect((await inject("DELETE", `/api/dnc/${first.json().id}`, admin)).statusCode).toBe(204);
    expect((await inject("DELETE", `/api/dnc/${first.json().id}`, admin)).statusCode).toBe(404);
    expect(await t.db.auditLog.count({ where: { action: "DNC_CHANGE", detail: { path: ["key"], equals: phone } } })).toBe(2);
  });

  it("/api/audit hides the new actions from old apps unless ?v=2", async () => {
    await inject("POST", "/api/dnc", admin, { phone: randomMobile() });
    const v1 = await inject("GET", "/api/audit?limit=200", admin);
    expect(v1.json().items.some((r: { action: string }) => r.action === "DNC_CHANGE")).toBe(false);
    const v2 = await inject("GET", "/api/audit?v=2&limit=200", admin);
    expect(v2.json().items.some((r: { action: string }) => r.action === "DNC_CHANGE")).toBe(true);
  });

  it("imports a CSV (label = reason)", async () => {
    const a = randomMobile();
    const b = randomMobile();
    const res = await inject("POST", "/api/dnc/import", admin, { csv: `${a},Complained\n${b}\nheader\n` });
    expect(res.json()).toMatchObject({ added: 2, updated: 0, rejected: 1, rejectedSample: ["header"] });
    expect((await t.db.dncNumber.findUniqueOrThrow({ where: { key: a } })).reason).toBe("Complained");
    expect((await t.db.dncNumber.findUniqueOrThrow({ where: { key: b } })).source).toBe("IMPORT");
    const again = await inject("POST", "/api/dnc/import", admin, { csv: `${b},Now with reason\n` });
    expect(again.json()).toMatchObject({ added: 0, updated: 1 });
  });

  it("hashes: sha256 of the key with an ETag; 304 when unchanged", async () => {
    const rep = await t.loginDevice(uniqueEmail("drep"));
    const phone = randomMobile();
    await inject("POST", "/api/dnc", admin, { phone });
    const res = await inject("GET", "/v1/dnc/hashes", rep.headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().hashes).toContain(hashKey(numberKey(phone)));
    const etag = res.headers["etag"] as string;
    const cached = await t.app.inject({ method: "GET", url: "/v1/dnc/hashes", headers: { ...rep.headers, "if-none-match": etag } });
    expect(cached.statusCode).toBe(304);
    // Shared vector with the app's DncCheck.
    expect(numberKey("+91 98765 43210")).toBe("9876543210");
    expect(hashKey("9876543210")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dial intents: 409 DNC without override, 200 with it", async () => {
    const email = uniqueEmail("drep");
    await t.db.user.create({ data: { email } });
    const h = await t.sessionFor(email);
    const phone = randomMobile();
    await inject("POST", "/api/dnc", admin, { phone, reason: "Wrong number" });
    const blocked = await inject("POST", "/api/dial-intents", h, { clientId: randomUUID(), phone });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "Number is on the do-not-call list", code: "DNC" });
    const ok = await inject("POST", "/api/dial-intents", h, { clientId: randomUUID(), phone, override: true });
    expect(ok.statusCode).toBe(200);
  });

  it("contact DTOs carry dnc; activities on DNC numbers are still accepted", async () => {
    const rep = await t.loginDevice(uniqueEmail("drep"));
    const phone = randomMobile();
    await inject("POST", "/api/dnc", admin, { phone, reason: "Asked" });
    const res = await inject("POST", "/v1/activities", rep.headers, {
      clientId: randomUUID(),
      phone,
      type: "CALL",
      outcome: "NOT_INTERESTED",
      occurredAt: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().contact.dnc).toMatchObject({ reason: "Asked", createdAt: expect.any(String) });
    const list = await inject("GET", `/v1/contacts?q=${phone}`, rep.headers);
    expect(list.json().items[0].dnc).not.toBeNull();
    const other = await inject("POST", "/v1/activities", rep.headers, { clientId: randomUUID(), phone: randomMobile(), type: "WHATSAPP", occurredAt: new Date().toISOString() });
    expect(other.json().contact.dnc).toBeNull();
  });
});
