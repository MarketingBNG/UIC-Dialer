import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
let admin: { cookie: string; origin: string };
let adminEmail: string;

beforeAll(async () => {
  t = await setupTestApp({ ALLOWED_DOMAIN: "usaindiacfo.com" });
  adminEmail = uniqueEmail("admin");
  await t.db.user.create({ data: { email: adminEmail, role: "ADMIN" } });
  admin = await t.sessionFor(adminEmail);
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

const headers = () => ({ cookie: admin.cookie, origin: admin.origin });
const block = (email: string, reason?: string) =>
  t.app.inject({ method: "POST", url: "/api/blocked-emails", headers: headers(), payload: { email, reason } });
const phoneLogin = async (email: string) =>
  t.app.inject({
    method: "POST",
    url: "/v1/auth/google",
    payload: { idToken: await t.googleToken({ email, hd: "usaindiacfo.com" }), device: { installId: randomUUID(), model: "Test" } },
  });

describe("blocked emails", () => {
  it("blocks an email that never signed in, even from the allowed domain", async () => {
    const email = uniqueEmail("new");
    expect((await block(email.toUpperCase(), "left the company")).statusCode).toBe(201);
    expect((await phoneLogin(email)).statusCode).toBe(403);
    expect(await t.db.user.findUnique({ where: { email } })).toBeNull();
    const list = (await t.app.inject({ method: "GET", url: "/api/blocked-emails", headers: headers() })).json();
    expect(list.find((r: { email: string }) => r.email === email)).toMatchObject({ reason: "left the company", user: null, blockedBy: { email: adminEmail } });
    // Adding the account by hand is refused too.
    expect((await t.app.inject({ method: "POST", url: "/api/users", headers: headers(), payload: { email } })).statusCode).toBe(409);
  });

  it("signs an existing user out everywhere, and unblocking lets them back in", async () => {
    const email = uniqueEmail("agent");
    const phone = await t.loginDevice(email);
    expect((await t.app.inject({ method: "GET", url: "/v1/me/today", headers: phone.headers })).statusCode).toBe(200);
    expect((await block(email)).statusCode).toBe(201);
    expect((await t.app.inject({ method: "GET", url: "/v1/me/today", headers: phone.headers })).statusCode).toBe(401);
    expect((await t.db.user.findUniqueOrThrow({ where: { email } })).active).toBe(false);
    expect((await phoneLogin(email)).statusCode).toBe(403);

    const del = await t.app.inject({ method: "DELETE", url: `/api/blocked-emails/${encodeURIComponent(email)}`, headers: headers() });
    expect(del.statusCode).toBe(204);
    expect((await phoneLogin(email)).statusCode).toBe(200);
  });

  it("admins only, and never yourself", async () => {
    expect((await block(adminEmail)).statusCode).toBe(400);
    const mgr = uniqueEmail("mgr");
    await t.db.user.create({ data: { email: mgr, role: "MANAGER" } });
    const s = await t.sessionFor(mgr);
    const res = await t.app.inject({ method: "POST", url: "/api/blocked-emails", headers: { cookie: s.cookie, origin: s.origin }, payload: { email: uniqueEmail() } });
    expect(res.statusCode).toBe(403);
  });
});
