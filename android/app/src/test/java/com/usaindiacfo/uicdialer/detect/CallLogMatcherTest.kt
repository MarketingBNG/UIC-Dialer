package com.usaindiacfo.uicdialer.detect

import com.usaindiacfo.uicdialer.data.api.Direction
import com.usaindiacfo.uicdialer.sync.PrivacyFilter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

// CallLog.Calls type constants (android.jar stubs aren't usable in JVM tests; values are inlined at compile time).
private const val INCOMING = 1
private const val OUTGOING = 2
private const val MISSED = 3

class CallLogMatcherTest {
    private val t0 = 1_700_000_000_000L
    private val a = CallLogEntry("+919876543210", OUTGOING, t0, 300, "Ravi")
    private val b = CallLogEntry("+911111111111", INCOMING, t0 + 600_000, 60, null)

    @Test fun matchesFileWrittenAtCallEnd() {
        assertSame(a, CallLogMatcher.bestMatch(listOf(a, b), t0 + 300_000 + 4_000, null))
    }

    @Test fun matchesNameStartTime() {
        assertSame(b, CallLogMatcher.bestMatch(listOf(a, b), t0 + 2 * 3600_000, t0 + 600_000 + 3_000))
    }

    @Test fun picksClosest() {
        assertSame(b, CallLogMatcher.bestMatch(listOf(a, b), t0 + 660_000 + 1_000, null))
    }

    @Test fun previousCallsFileDoesNotMatchNextCall() {
        // Prod case: 129 s call at 12:40:30, file named 12:40:38 but last written as the next call began at 12:42:49.
        val prev = CallLogEntry("+916304399850", INCOMING, t0, 129, null)
        val next = CallLogEntry("+916304399850", INCOMING, t0 + 139_400, 33, null)
        assertSame(prev, CallLogMatcher.bestMatch(listOf(prev, next), t0 + 140_000, t0 + 8_000))
        // Only the next call in the log: the file still must not attach to it.
        assertNull(CallLogMatcher.bestMatch(listOf(next), t0 + 140_000, t0 + 8_000))
    }

    @Test fun noMatchOutsideTolerance() {
        assertNull(CallLogMatcher.bestMatch(listOf(a), t0 + 300_000 + CallLogMatcher.TOLERANCE_MS + 1, null))
    }

    @Test fun ignoresMissedCalls() {
        val missed = CallLogEntry("123", MISSED, t0, 0, null)
        assertNull(CallLogMatcher.bestMatch(listOf(missed), t0, null))
    }

    @Test fun resolvePrefersCallLogThenName() {
        val parsed = ParsedName(phone = "999", contactName = "From Name", startedAt = t0 - 5)
        val m = CallLogMatcher.resolve(a, parsed, t0 + 300_000)
        assertEquals("+919876543210", m.phone)
        assertEquals("Ravi", m.contactName)
        assertEquals(Direction.OUTGOING, m.direction)
        assertEquals(t0, m.startedAt)
        assertEquals(300, m.durationS)

        val f = CallLogMatcher.resolve(null, parsed, t0 + 300_000)
        assertEquals("999", f.phone)
        assertEquals(Direction.UNKNOWN, f.direction)
        assertEquals(t0 - 5, f.startedAt)
        assertNull(f.durationS)
        assertEquals(t0 + 1, CallLogMatcher.resolve(null, ParsedName(), t0 + 1).startedAt)
    }

    @Test fun excludedNumbersCompareLastTenDigits() {
        assertTrue(PrivacyFilter.isExcluded("+91 98765 43210", listOf("098765-43210")))
        assertFalse(PrivacyFilter.isExcluded("+91 98765 43211", listOf("9876543210")))
        assertFalse(PrivacyFilter.isExcluded(null, listOf("9876543210")))
    }
}
