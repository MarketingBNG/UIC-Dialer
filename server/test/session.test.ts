import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, SESSION_TTL_S } from "../src/auth/guards.js";
import { setupTestApp, uniqueEmail } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.app.close();
  await t.db.$disconnect();
});

async function sealedAt(uid: string, msAgo: number, since?: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - msAgo);
  const s = await t.tokens.seal({ typ: "session", uid, ...(since ? { since } : {}) }, SESSION_TTL_S);
  vi.useRealTimers();
  return `${SESSION_COOKIE}=${s}`;
}

const me = (cookie: string) => t.app.inject({ method: "GET", url: "/api/me", headers: { cookie } });

describe("dashboard / desktop session", () => {
  it("does not renew a fresh cookie", async () => {
    const email = uniqueEmail("rep");
    await t.loginDevice(email);
    // The first request upgrades the test cookie to a recorded session; that fresh cookie isn't renewed again.
    const first = await me((await t.sessionFor(email)).cookie);
    const res = await me(String(first.headers["set-cookie"]).split(";")[0]!);
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("renews a cookie older than an hour, keeping the original sign-in time", async () => {
    const email = uniqueEmail("rep");
    const { user } = await t.loginDevice(email);
    const since = Math.floor(Date.now() / 1000) - 5 * 24 * 3600;
    const res = await me(await sealedAt(user.id, 2 * 3600 * 1000, since));
    expect(res.statusCode).toBe(200);
    const set = String(res.headers["set-cookie"]);
    expect(set).toContain(`${SESSION_COOKIE}=`);
    expect(set).toContain(`Max-Age=${SESSION_TTL_S}`);
    const renewed = await t.tokens.unseal(set.split(";")[0]!.split("=")[1]!);
    expect(renewed["since"]).toBe(since);
  });

  it("ends 90 days after sign-in even if used every day", async () => {
    const email = uniqueEmail("rep");
    const { user } = await t.loginDevice(email);
    const since = Math.floor(Date.now() / 1000) - 91 * 24 * 3600;
    const res = await me(await sealedAt(user.id, 2 * 3600 * 1000, since));
    expect(res.statusCode).toBe(401);
  });
});

describe("computers on the Health page (web_sessions)", () => {
  const cookieFrom = (setCookie: unknown) => String(setCookie).split(";")[0]!;

  it("records the Windows app, lists it for admins, and a revoke signs it out", async () => {
    const repEmail = uniqueEmail("rep");
    const { user } = await t.loginDevice(repEmail);
    const adminEmail = uniqueEmail("admin");
    await t.loginDevice(adminEmail, "ADMIN");

    // An existing cookie from before sessions were recorded gets a record on its next request.
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 UICDialer/1.2.76";
    const first = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie: (await t.sessionFor(repEmail)).cookie, "user-agent": ua } });
    expect(first.statusCode).toBe(200);
    const desk = cookieFrom(first.headers["set-cookie"]);
    const sid = (await t.tokens.unseal(desk.split("=")[1]!))["sid"] as string;
    expect(await t.db.webSession.findUniqueOrThrow({ where: { id: sid } })).toMatchObject({ userId: user.id, kind: "desktop", label: "UIC Dialer for Windows 1.2.76" });

    const admin = await t.sessionFor(adminEmail);
    const list = await t.app.inject({ method: "GET", url: "/api/web-sessions", headers: { cookie: admin.cookie } });
    expect(list.json().items.some((s: { id: string }) => s.id === sid)).toBe(true);

    const revoke = await t.app.inject({ method: "POST", url: `/api/web-sessions/${sid}/revoke`, headers: admin });
    expect(revoke.statusCode).toBe(204);
    expect((await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie: desk } })).statusCode).toBe(401);
  });

  it("reps can't list or revoke computers", async () => {
    const email = uniqueEmail("rep");
    await t.loginDevice(email);
    const s = await t.sessionFor(email);
    expect((await t.app.inject({ method: "GET", url: "/api/web-sessions", headers: { cookie: s.cookie } })).statusCode).toBe(403);
  });

  it("signing out marks the computer signed out", async () => {
    const email = uniqueEmail("rep");
    await t.loginDevice(email);
    const first = await t.app.inject({ method: "GET", url: "/api/me", headers: { cookie: (await t.sessionFor(email)).cookie, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/142.0" } });
    const cookie = cookieFrom(first.headers["set-cookie"]);
    const sid = (await t.tokens.unseal(cookie.split("=")[1]!))["sid"] as string;
    expect((await t.db.webSession.findUniqueOrThrow({ where: { id: sid } })).label).toBe("Chrome 142 on Windows");
    const out = await t.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, origin: "http://localhost:8000" } });
    expect(out.statusCode).toBe(204);
    expect((await t.db.webSession.findUniqueOrThrow({ where: { id: sid } })).revokedAt).not.toBeNull();
  });
});
