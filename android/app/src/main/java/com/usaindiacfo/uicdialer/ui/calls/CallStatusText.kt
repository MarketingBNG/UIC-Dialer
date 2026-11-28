package com.usaindiacfo.uicdialer.ui.calls

import com.usaindiacfo.uicdialer.data.api.CallStatus
import com.usaindiacfo.uicdialer.data.api.Direction
import com.usaindiacfo.uicdialer.data.db.RecordingStatus

/**
 * Colour family of a status badge; the screen maps it to theme colours (ui/common Pill does this).
 * NEUTRAL grey, INFO blue, BUSY amber ("needs a look", not urgent), GOOD green, BAD red (someone must act now).
 */
enum class StatusTone { NEUTRAL, INFO, BUSY, GOOD, BAD }

/** What a sales rep sees for a status: a short label, a colour, and one plain sentence. */
data class StatusText(val label: String, val tone: StatusTone, val explanation: String)

/**
 * The single place that turns call / recording states into plain words. Same words as the dashboard
 * (server/dashboard/src/callStatus.ts). Red is only for things someone must act on.
 */
object CallStatusText {
    /** Transcript state of a call. [mine] = the viewer owns the phone that made it. */
    fun of(s: CallStatus, mine: Boolean = true): StatusText = when (s) {
        CallStatus.PENDING_UPLOAD -> StatusText(if (mine) "Waiting to upload" else "Waiting for phone", StatusTone.NEUTRAL,
            "The call is logged. The recording uploads from the phone, usually on Wi-Fi.")
        // Uploaded and Transcribing are one state to a rep.
        CallStatus.UPLOADED, CallStatus.TRANSCRIBING -> StatusText("Working on transcript", StatusTone.INFO,
            "The recording is here. The transcript is ready in a few minutes.")
        CallStatus.TRANSCRIBED -> StatusText("Transcript ready", StatusTone.GOOD,
            "The recording and its transcript are ready.")
        CallStatus.FAILED -> StatusText("No transcript – audio kept", StatusTone.NEUTRAL,
            "We couldn't make a transcript after several tries. You can still play the recording.")
        CallStatus.NO_RECORDING -> StatusText("No recording", StatusTone.NEUTRAL,
            "This call is in the phone's call log but has no recording. If one turns up, it is added here.")
    }

    /**
     * A list row: a call-log-only call (NO_RECORDING) says what happened instead (Missed, Rejected, Blocked,
     * Voicemail, No answer). Same words as the dashboard's callRowStatusText.
     */
    fun of(s: CallStatus, logType: String?, direction: Direction?, durationS: Int?): StatusText {
        if (s != CallStatus.NO_RECORDING) return of(s)
        return result(logType, direction, durationS) ?: of(s)
    }

    /** What happened on the call itself ("Answered 3:12", "Missed"...); null when unknown. */
    fun result(logType: String?, direction: Direction?, durationS: Int?): StatusText? {
        val t = logType ?: if (direction == Direction.MISSED) "MISSED" else null
        val d = durationS ?: 0
        return when {
            t == "MISSED" -> StatusText("Missed", StatusTone.BUSY, "A missed incoming call. Call them back.")
            t == "REJECTED" -> StatusText("Rejected", StatusTone.BUSY, "An incoming call that was declined.")
            t == "BLOCKED" -> StatusText("Blocked", StatusTone.NEUTRAL, "An incoming call from a blocked number.")
            t == "VOICEMAIL" -> StatusText("Voicemail", StatusTone.NEUTRAL, "The caller went to voicemail.")
            (t == "OUTGOING" || direction == Direction.OUTGOING) && d == 0 ->
                StatusText("No answer", StatusTone.NEUTRAL, "An outgoing call that wasn't answered.")
            d > 0 -> StatusText("Answered ${d / 60}:${(d % 60).toString().padStart(2, '0')}", StatusTone.GOOD, "The call was answered.")
            else -> null
        }
    }

    /** This phone's own copy of a recording (Home screen counts). [overADay] turns a failing upload red. */
    fun of(s: RecordingStatus, overADay: Boolean = false): StatusText = when (s) {
        RecordingStatus.PENDING -> StatusText("Waiting to upload", StatusTone.NEUTRAL,
            "Uploads on the next sync, usually on Wi-Fi.")
        RecordingStatus.UPLOADING -> StatusText("Uploading", StatusTone.INFO, "Sending the recording now.")
        RecordingStatus.UPLOADED -> StatusText("Uploaded", StatusTone.GOOD, "The recording is on the server.")
        RecordingStatus.SKIPPED -> StatusText("Private", StatusTone.NEUTRAL,
            "Not uploaded: the number is private or excluded by your company's settings.")
        RecordingStatus.FAILED -> if (overADay) StatusText("Upload not working", StatusTone.BAD,
            "This recording hasn't uploaded for over a day. Open Phone setup to fix it.")
        else StatusText("Will retry upload", StatusTone.BUSY,
            "The upload didn't go through. The app tries again automatically.")
    }
}
