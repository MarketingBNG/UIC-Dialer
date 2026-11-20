/**
 * The single place that turns a call's server state into plain words for sales reps.
 * Same words as the phone (android ui/calls/CallStatusText.kt). Self-contained (no imports) so the
 * server test suite can check it too (server/test/call-status-text.test.ts).
 */
export type CallStatusKey = "PENDING_UPLOAD" | "UPLOADED" | "TRANSCRIBING" | "TRANSCRIBED" | "FAILED";
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
};

export const callStatusText = (s: CallStatusKey): StatusText => TEXT[s];
export const CALL_STATUSES = Object.keys(TEXT) as CallStatusKey[];
