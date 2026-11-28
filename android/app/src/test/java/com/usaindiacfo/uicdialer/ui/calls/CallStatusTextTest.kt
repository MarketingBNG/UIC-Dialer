package com.usaindiacfo.uicdialer.ui.calls

import com.usaindiacfo.uicdialer.data.api.CallStatus
import com.usaindiacfo.uicdialer.data.api.Direction
import com.usaindiacfo.uicdialer.data.db.RecordingStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CallStatusTextTest {
    @Test fun callStatusLabels() {
        assertEquals("Waiting to upload", CallStatusText.of(CallStatus.PENDING_UPLOAD).label)
        assertEquals("Waiting for phone", CallStatusText.of(CallStatus.PENDING_UPLOAD, mine = false).label)
        assertEquals("Working on transcript", CallStatusText.of(CallStatus.UPLOADED).label)
        assertEquals("Working on transcript", CallStatusText.of(CallStatus.TRANSCRIBING).label)
        assertEquals("Transcript ready", CallStatusText.of(CallStatus.TRANSCRIBED).label)
        assertEquals("No transcript – audio kept", CallStatusText.of(CallStatus.FAILED).label)
        assertEquals(StatusTone.GOOD, CallStatusText.of(CallStatus.TRANSCRIBED).tone)
        assertEquals(StatusTone.NEUTRAL, CallStatusText.of(CallStatus.FAILED).tone)
        assertEquals("No recording", CallStatusText.of(CallStatus.NO_RECORDING).label)
    }

    @Test fun callLogOnlyRowsSayWhatHappened() {
        val nr = CallStatus.NO_RECORDING
        assertEquals("Missed", CallStatusText.of(nr, "MISSED", Direction.MISSED, 0).label)
        assertEquals("Rejected", CallStatusText.of(nr, "REJECTED", Direction.MISSED, 0).label)
        assertEquals("No answer", CallStatusText.of(nr, "OUTGOING", Direction.OUTGOING, 0).label)
        assertEquals("Answered 0:45", CallStatusText.of(nr, "INCOMING", Direction.INCOMING, 45).label)
        assertEquals("Transcript ready", CallStatusText.of(CallStatus.TRANSCRIBED, "MISSED", Direction.MISSED, 0).label)
    }

    @Test fun recordingStatusLabels() {
        assertEquals("Waiting to upload", CallStatusText.of(RecordingStatus.PENDING).label)
        assertEquals("Uploading", CallStatusText.of(RecordingStatus.UPLOADING).label)
        assertEquals("Uploaded", CallStatusText.of(RecordingStatus.UPLOADED).label)
        assertEquals("Private", CallStatusText.of(RecordingStatus.SKIPPED).label)
        assertEquals("Will retry upload", CallStatusText.of(RecordingStatus.FAILED).label)
        assertEquals(StatusTone.BAD, CallStatusText.of(RecordingStatus.FAILED, overADay = true).tone)
    }

    @Test fun noJargonAndAlwaysExplained() {
        val all = CallStatus.entries.map(CallStatusText::of) + RecordingStatus.entries.map(CallStatusText::of)
        all.forEach {
            assertTrue(it.explanation.isNotBlank())
            listOf("Queued", "Pending", "PENDING", "_").forEach { bad -> assertTrue(bad !in it.label) }
        }
    }
}
