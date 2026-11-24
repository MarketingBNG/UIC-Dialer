import { describe, expect, it } from "vitest";
import { CALL_STATUSES, callRowStatusText, callStatusText } from "../dashboard/src/callStatus.js";

describe("dashboard call status words", () => {
  it("maps every server state to a plain label with an explanation", () => {
    expect(CALL_STATUSES.map((s) => callStatusText(s).label)).toEqual([
      "Waiting for phone",
      "Uploaded",
      "Transcribing",
      "Transcript ready",
      "No transcript",
      "No recording",
    ]);
    for (const s of CALL_STATUSES) {
      expect(callStatusText(s).explanation.length).toBeGreaterThan(0);
      expect(callStatusText(s).label).not.toMatch(/Queued|Pending|_/);
    }
  });

  it("says what happened to a call with no recording", () => {
    expect(callRowStatusText("NO_RECORDING", "MISSED").label).toBe("Missed");
    expect(callRowStatusText("NO_RECORDING", "REJECTED").label).toBe("Rejected");
    expect(callRowStatusText("NO_RECORDING", "OUTGOING", "OUTGOING", 0).label).toBe("Not answered");
    expect(callRowStatusText("NO_RECORDING", "INCOMING", "INCOMING", 40).label).toBe("No recording");
    expect(callRowStatusText("TRANSCRIBED", "MISSED").label).toBe("Transcript ready");
  });
});
