import { describe, expect, it } from "vitest";
import { phoneProblems, reportText } from "../src/alerts/dailyReport.js";

const now = new Date("2026-11-27T06:00:00Z");
const ok = {
  email: "a@x.com", model: "Galaxy", appVersion: "0.3.131", permissionsOk: true, pendingCount: 0,
  lastSyncAt: now, lastSeenAt: now, calls7d: 20, recordings7d: 19,
};

describe("daily phone report", () => {
  it("a healthy phone has no problems", () => {
    expect(phoneProblems(ok, "0.3.131", now)).toEqual([]);
  });
  it("flags permissions, recording off, upload backlog and old app", () => {
    const p = phoneProblems({ ...ok, permissionsOk: false, recordings7d: 2, pendingCount: 900, lastSyncAt: new Date("2026-11-24T00:00:00Z"), appVersion: "0.3.84" }, "0.3.131", now);
    expect(p.join(" | ")).toMatch(/permissions missing.*recording off.*900 waiting.*no upload since 2026-11-24.*old app 0.3.84/);
  });
  it("flags a phone still making duplicate recordings", () => {
    expect(phoneProblems({ ...ok, dupes7d: 1 }, "0.3.131", now)).toEqual([]);
    expect(phoneProblems({ ...ok, dupes7d: 3 }, "0.3.131", now)).toEqual(["3 duplicate recordings this week (update the app)"]);
  });
  it("summarizes only phones that need attention", () => {
    const t = reportText([ok, { ...ok, email: "b@x.com", permissionsOk: false }], "0.3.131", now);
    expect(t).toContain("2 phones, 1 need attention");
    expect(t).toContain("b@x.com");
    expect(t).not.toContain("a@x.com");
  });
});
