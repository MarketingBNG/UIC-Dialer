import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestApp } from "./helpers.js";

let t: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.app.close();
  await t.db.$disconnect();
});

describe("public downloads", () => {
  it("lists the Windows installer from GitHub without sign-in and redirects to it", async () => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith("https://api.github.com/")) {
        return new Response(JSON.stringify({
          tag_name: "v9.9.9",
          assets: [
            { name: "latest.yml", browser_download_url: "https://x/latest.yml", size: 1 },
            { name: "UIC-Dialer-Setup-9.9.9.exe", browser_download_url: "https://x/setup.exe", size: 90_000_000 },
          ],
        }), { status: 200 });
      }
      return real(url, init);
    });
    const res = await t.app.inject({ url: "/api/downloads" });
    expect(res.statusCode).toBe(200);
    expect(res.json().windows).toEqual({ version: "9.9.9", sizeBytes: 90_000_000, url: "/download/windows" });
    const go = await t.app.inject({ url: "/download/windows" });
    expect(go.statusCode).toBe(302);
    expect(go.headers.location).toBe("https://x/setup.exe");
  });
});
