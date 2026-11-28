/**
 * The single place that turns a call's server state into plain words for sales reps.
 * Same words as the phone (android ui/calls/CallStatusText.kt). Self-contained (no imports) so the
 * server test suite can check it too (server/test/call-status-text.test.ts).
 */
export type CallStatusKey = "PENDING_UPLOAD" | "UPLOADED" | "TRANSCRIBING" | "TRANSCRIBED" | "FAILED" | "NO_RECORDING";
export type StatusTone = "gray" | "blue" | "amber" | "green" | "red";

export interface StatusText {
  label: string;
  tone: StatusTone;
  /** One sentence, shown as the badge tooltip. */
  explanation: string;
}

// Colours: green done, blue in progress, grey nothing to do. Red is never used here: nothing on a call row needs action.
const TEXT: Record<CallStatusKey, StatusText> = {
  PENDING_UPLOAD: {
    label: "Waiting to upload",
    tone: "gray",
    explanation: "The call is logged. The recording uploads from the phone, usually on Wi-Fi.",
  },
  UPLOADED: { label: "Working on transcript", tone: "blue", explanation: "The recording is here. The transcript starts soon." },
  TRANSCRIBING: { label: "Working on transcript", tone: "blue", explanation: "Turning the recording into text. This takes a few minutes." },
  TRANSCRIBED: { label: "Transcript ready", tone: "green", explanation: "The recording and its transcript are ready." },
  FAILED: {
    label: "No transcript – audio kept",
    tone: "gray",
    explanation: "We couldn't make a transcript of this recording. You can still play the audio.",
  },
  NO_RECORDING: {
    label: "No recording",
    tone: "gray",
    explanation: "This call is in the phone's call log but has no recording. If one turns up, it is added here.",
  },
};

export const callStatusText = (s: CallStatusKey): StatusText => TEXT[s];
export const CALL_STATUSES = Object.keys(TEXT) as CallStatusKey[];

/**
 * A call-log-only call (NO_RECORDING) says what happened instead: Missed, Rejected, Blocked, Voicemail or No answer.
 * Every other status reads as callStatusText. Pass mine=false when the viewer doesn't own the phone, so a
 * waiting upload reads "Waiting for phone" (the viewer can't do anything about it).
 */
export function callRowStatusText(
  s: CallStatusKey,
  logType?: string | null,
  direction?: string | null,
  durationS?: number | null,
  mine = true,
): StatusText {
  if (s === "PENDING_UPLOAD" && !mine) return { ...TEXT.PENDING_UPLOAD, label: "Waiting for phone" };
  if (s !== "NO_RECORDING") return TEXT[s];
  const t = logType ?? (direction === "MISSED" ? "MISSED" : null);
  const st = (label: string, tone: StatusTone, explanation: string): StatusText => ({ label, tone, explanation });
  // Missed/rejected are worth a call back (amber); blocked and voicemail need nothing (grey).
  if (t === "MISSED") return st("Missed", "amber", "A missed incoming call. There is no recording.");
  if (t === "REJECTED") return st("Rejected", "amber", "An incoming call that was declined. There is no recording.");
  if (t === "BLOCKED") return st("Blocked", "gray", "An incoming call from a blocked number. There is no recording.");
  if (t === "VOICEMAIL") return st("Voicemail", "gray", "The caller went to voicemail. There is no recording.");
  if ((t === "OUTGOING" || direction === "OUTGOING") && !durationS) {
    return st("No answer", "gray", "An outgoing call that wasn't answered. There is no recording.");
  }
  return TEXT.NO_RECORDING;
}
