package com.usaindiacfo.uicdialer.dialer

import com.usaindiacfo.uicdialer.detect.CallLogEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExternalCallPromptTest {
    private val now = 1_000_000_000_000L
    private fun e(type: Int, agoMin: Long, dur: Int = 60, n: String = "9876543210") = CallLogEntry(n, type, now - agoMin * 60_000, dur, null)

    @Test fun picksNewestConnectedCall() {
        val r = ExternalCallPrompt.pick(listOf(e(1, 10), e(2, 3)), emptyList(), 0, now)
        assertEquals(now - 3 * 60_000, r?.dateMs)
    }

    @Test fun skipsMissedUnansweredOldAndAlreadyAsked() {
        assertNull(ExternalCallPrompt.pick(listOf(e(3, 2, dur = 0), e(2, 2, dur = 0)), emptyList(), 0, now))
        assertNull(ExternalCallPrompt.pick(listOf(e(1, 30)), emptyList(), 0, now))
        assertNull(ExternalCallPrompt.pick(listOf(e(1, 5)), emptyList(), now - 5 * 60_000, now))
    }

    @Test fun skipsAppDials() {
        assertNull(ExternalCallPrompt.pick(listOf(e(2, 5)), listOf("9876543210" to now - 5 * 60_000), 0, now))
    }

    @Test fun incomingMatchesItsOwnPendingDial() {
        val inc = e(1, 5)
        assertEquals(inc, DialLogic.matchDial(listOf(inc), "9876543210", inc.dateMs))
    }
}
