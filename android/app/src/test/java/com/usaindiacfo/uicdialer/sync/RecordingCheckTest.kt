package com.usaindiacfo.uicdialer.sync

import com.usaindiacfo.uicdialer.detect.CallLogEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RecordingCheckTest {
    private val now = 1_000_000_000_000L
    private val min = 60_000L
    private fun call(agoMin: Long, dur: Int = 60) = CallLogEntry("9876543210", 2, now - agoMin * min, dur, null)

    @Test fun needsThreeConnectedCalls() {
        assertNull(RecordingCheck.windowStart(listOf(call(60), call(120)), now))
        // Short calls (under 30 s) don't count.
        assertNull(RecordingCheck.windowStart(listOf(call(60), call(120), call(180, dur = 5)), now))
    }

    @Test fun ignoresCallsJustEnded() {
        assertNull(RecordingCheck.windowStart(listOf(call(2), call(120), call(180)), now))
    }

    @Test fun windowStartsAtThirdNewestCall() {
        assertEquals(now - 180 * min, RecordingCheck.windowStart(listOf(call(60), call(120), call(180), call(600)), now))
    }

    @Test fun offOnlyWhenNoRecordingsInWindow() {
        val calls = listOf(call(60), call(120), call(180))
        assertTrue(RecordingCheck.looksOff(calls, now) { 0 })
        assertFalse(RecordingCheck.looksOff(calls, now) { 1 })
        assertFalse(RecordingCheck.looksOff(calls.take(2), now) { 0 })
    }
}
