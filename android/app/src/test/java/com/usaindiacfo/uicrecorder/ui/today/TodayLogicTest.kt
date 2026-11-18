package com.usaindiacfo.uicrecorder.ui.today

import com.usaindiacfo.uicrecorder.data.api.ContactDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class TodayLogicTest {
    private fun row(key: String, due: Long, overdue: Boolean) =
        TodayRow(key = key, kind = TodayKind.FOLLOW_UP, phoneE164 = "+919876543210", dueAtMs = due, overdue = overdue)

    @Test fun splitsOverdueAndTodaySorted() {
        val (overdue, today) = splitToday(
            listOf(row("b", 300, false), row("x", 100, true), row("a", 300, false), row("y", 50, true)),
        )
        assertEquals(listOf("y", "x"), overdue.map { it.key })
        assertEquals(listOf("a", "b"), today.map { it.key })
    }

    @Test fun contactRowUsesIstDayForOverdue() {
        // 18 Nov 2026 10:00 IST
        val now = Instant.parse("2026-11-18T04:30:00Z")
        val yesterday = ContactDto(id = "1", phoneE164 = "+911", nextFollowUpAt = "2026-11-17T18:00:00Z") // 23:30 IST on 17th
        val earlyToday = ContactDto(id = "2", phoneE164 = "+912", nextFollowUpAt = "2026-11-17T18:31:00Z") // 00:01 IST on 18th
        assertTrue(yesterday.toTodayRow(now)!!.overdue)
        assertFalse(earlyToday.toTodayRow(now)!!.overdue)
        assertEquals("contact:2", earlyToday.toTodayRow(now)!!.key)
    }

    @Test fun contactWithoutFollowUpIsSkipped() {
        assertNull(ContactDto(id = "1", phoneE164 = "+911").toTodayRow())
    }

    @Test fun titleFallsBackToNumber() {
        assertEquals("+919876543210", row("k", 0, false).title)
        assertEquals("Rahul", row("k", 0, false).copy(name = "Rahul").title)
    }
}
