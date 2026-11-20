import { describe, expect, it } from "vitest";
import { CALL_STATUSES, callStatusText } from "../dashboard/src/callStatus.js";

describe("dashboard call status words", () => {
  it("maps every server state to a plain label with an explanation", () => {
    expect(CALL_STATUSES.map((s) => callStatusText(s).label)).toEqual([
      "Waiting for phone",
      "Uploaded",
      "Transcribing",
      "Transcript ready",
      "No transcript",
    ]);
    for (const s of CALL_STATUSES) {
      expect(callStatusText(s).explanation.length).toBeGreaterThan(0);
      expect(callStatusText(s).label).not.toMatch(/Queued|Pending|_/);
    }
  });
});
