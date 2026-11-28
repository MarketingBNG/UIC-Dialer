import { describe, expect, it } from "vitest";
import { LiveCalls, ON_CALL_MAX_MS, RINGING_MAX_MS, directionCounts } from "../src/activity/live.js";

describe("LiveCalls", () => {
  it("ringing -> on a call -> idle", () => {
    const l = new LiveCalls();
    l.report("u", "ringing", 1000);
    expect(l.get("u", 2000)).toEqual({ state: "ringing", since: new Date(1000) });
    l.report("u", "answered", 5000);
    expect(l.get("u", 6000)).toEqual({ state: "onCall", since: new Date(5000) });
    l.report("u", "answered", 9000); // repeat keeps the start
    expect(l.get("u", 9000)?.since).toEqual(new Date(5000));
    l.report("u", "ended", 10_000);
    expect(l.get("u", 10_000)).toBeNull();
  });

  it("expires lost reports", () => {
    const l = new LiveCalls();
    l.report("a", "ringing", 0);
    l.report("b", "answered", 0);
    expect(l.get("a", RINGING_MAX_MS + 1)).toBeNull();
    expect(l.get("b", RINGING_MAX_MS + 1)?.state).toBe("onCall");
    expect(l.get("b", ON_CALL_MAX_MS + 1)).toBeNull();
  });
});

describe("directionCounts", () => {
  it("counts outgoing / incoming / missed, ignores unknown and other users", () => {
    const m = directionCounts(
      [
        { userId: "a", direction: "OUTGOING", n: 3 },
        { userId: "a", direction: "INCOMING", n: 2 },
        { userId: "a", direction: "MISSED", n: 1 },
        { userId: "a", direction: "UNKNOWN", n: 5 },
        { userId: "x", direction: "OUTGOING", n: 9 },
      ],
      ["a", "b"],
    );
    expect(m.get("a")).toEqual({ outgoing: 3, incoming: 2, missed: 1 });
    expect(m.get("b")).toEqual({ outgoing: 0, incoming: 0, missed: 0 });
    expect(m.has("x")).toBe(false);
  });
});
