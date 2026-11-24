package com.usaindiacfo.uicdialer.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallLogPlanTest {
    private fun row(id: Long) = CallLogRow(id, "98765$id", 3, 1_700_000_000_000 + id, 0, null, null)

    @Test fun sendsUploadsAndSkipsPrivateRowsButMovesPastThem() {
        val b = CallLogPlan.plan(listOf(
            row(1) to PrivacyDecision.Upload,
            row(2) to PrivacyDecision.Skip(PrivacyFilter.EXCLUDED),
            row(3) to PrivacyDecision.Upload,
        ))
        assertEquals(listOf(1L, 3L), b.send.map { it.id })
        assertEquals(3L, b.cursor)
        assertFalse(b.held)
    }

    @Test fun stopsBeforeAHeldRowSoItIsNeverLost() {
        val b = CallLogPlan.plan(listOf(
            row(5) to PrivacyDecision.Upload,
            row(6) to PrivacyDecision.Hold(PrivacyFilter.NEED_CONTACTS),
            row(7) to PrivacyDecision.Upload,
        ))
        assertEquals(listOf(5L), b.send.map { it.id })
        assertEquals(5L, b.cursor)
        assertTrue(b.held)

        val first = CallLogPlan.plan(listOf(row(8) to PrivacyDecision.Hold(PrivacyFilter.NEED_CLIENT_LIST)))
        assertTrue(first.send.isEmpty())
        assertNull(first.cursor)
    }

    @Test fun mapsCallLogTypes() {
        assertEquals(
            listOf("INCOMING", "OUTGOING", "MISSED", "VOICEMAIL", "REJECTED", "BLOCKED", "ANSWERED_EXTERNALLY", "UNKNOWN"),
            (1..8).map(CallLogPlan::typeName),
        )
    }

    @Test fun firstRunGoesBackToTheBacklogCutoff() {
        val now = 10L * 24 * 3600_000
        assertEquals(now - 7L * 24 * 3600_000, CallLogPlan.firstRunSince(now, 7))
        assertEquals(now, CallLogPlan.firstRunSince(now, 0))
    }
}
