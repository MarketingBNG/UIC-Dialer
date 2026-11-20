package com.usaindiacfo.uicdialer.ui.calls

import com.usaindiacfo.uicdialer.data.api.CallStatus
import com.usaindiacfo.uicdialer.data.db.RecordingStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CallStatusTextTest {
    @Test fun callStatusLabels() {
        assertEquals("Waiting for phone", CallStatusText.of(CallStatus.PENDING_UPLOAD).label)
        assertEquals("Uploaded", CallStatusText.of(CallStatus.UPLOADED).label)
        assertEquals("Transcribing", CallStatusText.of(CallStatus.TRANSCRIBING).label)
        assertEquals("Transcript ready", CallStatusText.of(CallStatus.TRANSCRIBED).label)
        assertEquals("No transcript", CallStatusText.of(CallStatus.FAILED).label)
        assertEquals(StatusTone.GOOD, CallStatusText.of(CallStatus.TRANSCRIBED).tone)
        assertEquals(StatusTone.BAD, CallStatusText.of(CallStatus.FAILED).tone)
    }

    @Test fun recordingStatusLabels() {
        assertEquals("Waiting to upload", CallStatusText.of(RecordingStatus.PENDING).label)
        assertEquals("Uploading", CallStatusText.of(RecordingStatus.UPLOADING).label)
        assertEquals("Uploaded", CallStatusText.of(RecordingStatus.UPLOADED).label)
        assertEquals("Private", CallStatusText.of(RecordingStatus.SKIPPED).label)
        assertEquals("Upload failed, retrying", CallStatusText.of(RecordingStatus.FAILED).label)
    }

    @Test fun noJargonAndAlwaysExplained() {
        val all = CallStatus.entries.map(CallStatusText::of) + RecordingStatus.entries.map(CallStatusText::of)
        all.forEach {
            assertTrue(it.explanation.isNotBlank())
            listOf("Queued", "Pending", "PENDING", "_").forEach { bad -> assertTrue(bad !in it.label) }
        }
    }
}
