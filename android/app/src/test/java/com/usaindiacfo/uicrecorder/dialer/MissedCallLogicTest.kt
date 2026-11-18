package com.usaindiacfo.uicrecorder.dialer

import android.provider.CallLog
import com.usaindiacfo.uicrecorder.detect.CallLogEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MissedCallLogicTest {
    private val t0 = 1_762_600_000_000L
    private val now = t0 + 3600_000L

    private fun e(number: String?, type: Int, at: Long, dur: Int = 0, name: String? = null) = CallLogEntry(number, type, at, dur, name)

    @Test fun missedAndRejectedBecomeTasksWithStableIds() {
        val out = MissedCallLogic.newMissed(
            listOf(
                e("+91 98765 43210", CallLog.Calls.MISSED_TYPE, t0, name = "Rahul"),
                e("09876543211", CallLog.Calls.REJECTED_TYPE, t0 + 1000),
            ),
            sinceMs = 0, nowMs = now,
        )
        assertEquals(listOf("missed:$t0:9876543210", "missed:${t0 + 1000}:9876543211"), out.map { it.clientId })
        assertEquals("Rahul", out[0].callerName)
        assertEquals("+91 98765 43210", out[0].number)
    }

    @Test fun laterCallbackOrAnsweredCallSkipsIt() {
        val entries = listOf(
            e("9876543210", CallLog.Calls.MISSED_TYPE, t0),
            e("+919876543210", CallLog.Calls.OUTGOING_TYPE, t0 + 60_000, dur = 0), // even an unanswered callback counts
            e("9876543211", CallLog.Calls.MISSED_TYPE, t0),
            e("9876543211", CallLog.Calls.INCOMING_TYPE, t0 + 60_000, dur = 30),
            e("9876543212", CallLog.Calls.MISSED_TYPE, t0),
            e("9876543212", CallLog.Calls.INCOMING_TYPE, t0 + 60_000, dur = 0), // not answered: still open
            e("9876543213", CallLog.Calls.OUTGOING_TYPE, t0 - 60_000, dur = 10), // callback before: doesn't count
            e("9876543213", CallLog.Calls.MISSED_TYPE, t0),
        )
        assertEquals(listOf("9876543212", "9876543213"), MissedCallLogic.newMissed(entries, 0, now).map { DialLogic.last10(it.number) })
    }

    @Test fun skipsPrivateNumbersOldEntriesAndDuplicates() {
        val entries = listOf(
            e(null, CallLog.Calls.MISSED_TYPE, t0),
            e("", CallLog.Calls.MISSED_TYPE, t0),
            e("-2", CallLog.Calls.MISSED_TYPE, t0), // "private" marker some phones use
            e("9876543210", CallLog.Calls.MISSED_TYPE, t0 - 10), // at or before the cursor
            e("9876543210", CallLog.Calls.MISSED_TYPE, t0 + 5),
            e("+919876543210", CallLog.Calls.MISSED_TYPE, t0 + 5), // same entry seen twice
            e("9876543210", CallLog.Calls.MISSED_TYPE, now + 1), // in the future
        )
        val out = MissedCallLogic.newMissed(entries, sinceMs = t0, nowMs = now)
        assertEquals(listOf("missed:${t0 + 5}:9876543210"), out.map { it.clientId })
    }

    @Test fun cursorMovesToNewestMissedOnly() {
        val entries = listOf(
            e("9876543210", CallLog.Calls.MISSED_TYPE, t0),
            e("9876543210", CallLog.Calls.OUTGOING_TYPE, t0 + 500, dur = 5),
            e("9876543211", CallLog.Calls.MISSED_TYPE, t0 + 100),
        )
        assertEquals(t0 + 100, MissedCallLogic.nextCursor(entries, 0, now))
        assertEquals(t0 + 200, MissedCallLogic.nextCursor(entries, t0 + 200, now)) // never moves back
        assertEquals(t0, MissedCallLogic.nextCursor(emptyList(), t0, now))
        assertTrue(MissedCallLogic.newMissed(entries, MissedCallLogic.nextCursor(entries, 0, now), now).isEmpty())
    }
}
