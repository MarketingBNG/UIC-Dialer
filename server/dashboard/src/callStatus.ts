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

const TEXT: Record<CallStatusKey, StatusText> = {
  PENDING_UPLOAD: {
    label: "Waiting for phone",
    tone: "gray",
    explanation: "The call is logged. The recording uploads from the phone, usually on Wi-Fi.",
  },
  UPLOADED: { label: "Uploaded", tone: "blue", explanation: "The recording is here. The transcript starts soon." },
  TRANSCRIBING: { label: "Transcribing", tone: "amber", explanation: "Turning the recording into text. This takes a few minutes." },
  TRANSCRIBED: { label: "Transcript ready", tone: "green", explanation: "The recording and its transcript are ready." },
  FAILED: {
    label: "No transcript",
    tone: "red",
    explanation: "We couldn't transcribe this recording after several tries. The audio is kept.",
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
 * A call-log-only call (NO_RECORDING) says what happened instead: Missed, Rejected, Blocked or Not answered.
 * Every other status reads as callStatusText.
 */
export function callRowStatusText(
  s: CallStatusKey,
  logType?: string | null,
  direction?: string | null,
  durationS?: number | null,
): StatusText {
  if (s !== "NO_RECORDING") return TEXT[s];
  const t = logType ?? (direction === "MISSED" ? "MISSED" : null);
  const red = (label: string, explanation: string): StatusText => ({ label, tone: "red", explanation });
  if (t === "MISSED") return red("Missed", "A missed incoming call. There is no recording.");
  if (t === "REJECTED") return red("Rejected", "An incoming call that was declined. There is no recording.");
  if (t === "BLOCKED") return red("Blocked", "An incoming call from a blocked number. There is no recording.");
  if (t === "VOICEMAIL") return red("Voicemail", "The caller went to voicemail. There is no recording.");
  if ((t === "OUTGOING" || direction === "OUTGOING") && !durationS) {
    return { label: "Not answered", tone: "amber", explanation: "An outgoing call that wasn't answered. There is no recording." };
  }
  return TEXT.NO_RECORDING;
}
