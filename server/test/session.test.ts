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
    const res = await me((await t.sessionFor(email)).cookie);
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
