package com.usaindiacfo.uicdialer.ui.calls

import com.usaindiacfo.uicdialer.data.api.CallStatus
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
