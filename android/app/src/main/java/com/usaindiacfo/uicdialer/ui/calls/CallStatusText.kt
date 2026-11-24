package com.usaindiacfo.uicdialer.ui.calls

import com.usaindiacfo.uicdialer.data.api.CallStatus
import com.usaindiacfo.uicdialer.data.api.Direction
import com.usaindiacfo.uicdialer.data.db.RecordingStatus

/** Colour family of a status badge; the screen maps it to theme colours. */
enum class StatusTone { NEUTRAL, INFO, BUSY, GOOD, BAD }

/** What a sales rep sees for a status: a short label, a colour, and one plain sentence. */
data class StatusText(val label: String, val tone: StatusTone, val explanation: String)

/**
 * The single place that turns call / recording states into plain words. Same words as the dashboard
 * (server/dashboard/src/format.ts callStatusText).
 */
object CallStatusText {
    /** Server-side state of a call (what the Calls list and call detail show). */
    fun of(s: CallStatus): StatusText = when (s) {
        CallStatus.PENDING_UPLOAD -> StatusText("Waiting for phone", StatusTone.NEUTRAL,
            "The call is logged. The recording uploads from the phone, usually on Wi-Fi.")
        CallStatus.UPLOADED -> StatusText("Uploaded", StatusTone.INFO,
            "The recording is here. The transcript starts soon.")
        CallStatus.TRANSCRIBING -> StatusText("Transcribing", StatusTone.BUSY,
            "Turning the recording into text. This takes a few minutes.")
        CallStatus.TRANSCRIBED -> StatusText("Transcript ready", StatusTone.GOOD,
            "The recording and its transcript are ready.")
        CallStatus.FAILED -> StatusText("No transcript", StatusTone.BAD,
            "We couldn't transcribe this recording after several tries. The audio is kept.")
        CallStatus.NO_RECORDING -> StatusText("No recording", StatusTone.NEUTRAL,
            "This call is in the phone's call log but has no recording. If one turns up, it is added here.")
    }

    /**
     * A list row: a call-log-only call (NO_RECORDING) says what happened instead (Missed, Rejected, Blocked,
     * Not answered). Same words as the dashboard's callRowStatusText.
     */
    fun of(s: CallStatus, logType: String?, direction: Direction?, durationS: Int?): StatusText {
        if (s != CallStatus.NO_RECORDING) return of(s)
        val t = logType ?: if (direction == Direction.MISSED) "MISSED" else null
        fun bad(label: String, explanation: String) = StatusText(label, StatusTone.BAD, explanation)
        return when {
            t == "MISSED" -> bad("Missed", "A missed incoming call. There is no recording.")
            t == "REJECTED" -> bad("Rejected", "An incoming call that was declined. There is no recording.")
            t == "BLOCKED" -> bad("Blocked", "An incoming call from a blocked number. There is no recording.")
            t == "VOICEMAIL" -> bad("Voicemail", "The caller went to voicemail. There is no recording.")
            (t == "OUTGOING" || direction == Direction.OUTGOING) && (durationS ?: 0) == 0 ->
                StatusText("Not answered", StatusTone.BUSY, "An outgoing call that wasn't answered. There is no recording.")
            else -> of(s)
        }
    }

    /** This phone's own copy of a recording (Home screen counts). */
    fun of(s: RecordingStatus): StatusText = when (s) {
        RecordingStatus.PENDING -> StatusText("Waiting to upload", StatusTone.NEUTRAL,
            "Uploads on the next sync, usually on Wi-Fi.")
        RecordingStatus.UPLOADING -> StatusText("Uploading", StatusTone.BUSY, "Sending the recording now.")
        RecordingStatus.UPLOADED -> StatusText("Uploaded", StatusTone.GOOD, "The recording is on the server.")
        RecordingStatus.SKIPPED -> StatusText("Private", StatusTone.NEUTRAL,
            "Not uploaded: the number is private or excluded by your company's settings.")
        RecordingStatus.FAILED -> StatusText("Upload failed, retrying", StatusTone.BAD,
            "The upload didn't go through. The app tries again automatically.")
    }
}
