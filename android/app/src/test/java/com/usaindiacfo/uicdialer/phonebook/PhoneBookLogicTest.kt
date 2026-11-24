package com.usaindiacfo.uicdialer.phonebook

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class PhoneBookLogicTest {
    private val ist = ZoneId.of("Asia/Kolkata")
    private fun ms(d: String, h: Int) = LocalDate.parse(d).atTime(h, 0).atZone(ist).toInstant().toEpochMilli()
    private fun call(id: Long, kind: CallKind, at: Long, number: String = "+919876543210", name: String? = null) =
        RecentCall(id, number, kind, at, 30, name)

    @Test fun kindMapping() {
        assertEquals(CallKind.INCOMING, PhoneBookLogic.kindOf(1))
        assertEquals(CallKind.OUTGOING, PhoneBookLogic.kindOf(2))
        assertEquals(CallKind.MISSED, PhoneBookLogic.kindOf(3))
        assertEquals(CallKind.REJECTED, PhoneBookLogic.kindOf(5))
        assertEquals(CallKind.REJECTED, PhoneBookLogic.kindOf(6))
        assertEquals(CallKind.OTHER, PhoneBookLogic.kindOf(4))
    }

    @Test fun filterMissedIncludesRejected() {
        val calls = listOf(
            call(1, CallKind.INCOMING, 1), call(2, CallKind.OUTGOING, 2),
            call(3, CallKind.MISSED, 3), call(4, CallKind.REJECTED, 4),
        )
        assertEquals(listOf(3L, 4L), PhoneBookLogic.filterRecents(calls, RecentsFilter.MISSED, "").map { it.id })
        assertEquals(listOf(1L), PhoneBookLogic.filterRecents(calls, RecentsFilter.INCOMING, "").map { it.id })
        assertEquals(listOf(2L), PhoneBookLogic.filterRecents(calls, RecentsFilter.OUTGOING, "").map { it.id })
        assertEquals(4, PhoneBookLogic.filterRecents(calls, RecentsFilter.ALL, "").size)
    }

    @Test fun searchByNameResolvedNameAndDigits() {
        val a = call(1, CallKind.INCOMING, 1, name = "Rahul Mehta")
        val b = call(2, CallKind.INCOMING, 2, number = "080-1234 5678")
        assertTrue(PhoneBookLogic.matchesSearch(a, "rahul"))
        assertTrue(PhoneBookLogic.matchesSearch(a, "98765 43"))
        assertTrue(PhoneBookLogic.matchesSearch(b, "acme") { "Acme Corp" })
        assertTrue(PhoneBookLogic.matchesSearch(b, "1234-56"))
        assertFalse(PhoneBookLogic.matchesSearch(b, "999"))
        assertFalse(PhoneBookLogic.matchesSearch(a, "x1"))
    }

    @Test fun groupsByDayNewestFirst() {
        val calls = listOf(
            call(1, CallKind.INCOMING, ms("2026-11-23", 10)),
            call(2, CallKind.OUTGOING, ms("2026-11-24", 9)),
            call(3, CallKind.MISSED, ms("2026-11-24", 18)),
        )
        val g = PhoneBookLogic.groupByDay(calls, ist)
        assertEquals(listOf(LocalDate.parse("2026-11-24"), LocalDate.parse("2026-11-23")), g.map { it.day })
        assertEquals(listOf(3L, 2L), g[0].calls.map { it.id })
        val today = LocalDate.parse("2026-11-24")
        assertEquals("Today", PhoneBookLogic.dayLabel(today, today))
        assertEquals("Yesterday", PhoneBookLogic.dayLabel(today.minusDays(1), today))
        assertNull(PhoneBookLogic.dayLabel(today.minusDays(2), today))
    }

    @Test fun durations() {
        assertNull(PhoneBookLogic.formatDuration(0))
        assertEquals("42s", PhoneBookLogic.formatDuration(42))
        assertEquals("3m 5s", PhoneBookLogic.formatDuration(185))
        assertEquals("1h 2m", PhoneBookLogic.formatDuration(3720))
    }

    @Test fun numberKeyNormalizes() {
        assertEquals("9876543210", PhoneBookLogic.numberKey("+91 98765-43210"))
        assertEquals("9876543210", PhoneBookLogic.numberKey("098765 43210"))
        assertEquals("121", PhoneBookLogic.numberKey("121"))
        assertNull(PhoneBookLogic.numberKey("abc"))
    }

    @Test fun t9() {
        assertEquals(listOf("72485", "63482"), PhoneBookLogic.t9Words("Rahul Mehta"))
        assertTrue(PhoneBookLogic.t9Matches("Rahul Mehta", "724"))
        assertTrue(PhoneBookLogic.t9Matches("Rahul Mehta", "634"))     // second word
        assertTrue(PhoneBookLogic.t9Matches("Rahul Mehta", "724856"))  // across words
        assertFalse(PhoneBookLogic.t9Matches("Rahul Mehta", "999"))
        assertFalse(PhoneBookLogic.t9Matches("Rahul Mehta", ""))
    }

    @Test fun contactsSortedAndSearchable() {
        val list = listOf(
            PhoneContact(1, "k1", "zoe", "111111", false),
            PhoneContact(2, "k2", "Amit", "98765 43210", true),
            PhoneContact(3, "k3", "123 Taxi", "222222", false),
        )
        assertEquals(listOf("Amit", "zoe", "123 Taxi"), PhoneBookLogic.sortContacts(list).map { it.name })
        assertEquals("A", PhoneBookLogic.sectionOf("amit"))
        assertEquals("#", PhoneBookLogic.sectionOf("123 Taxi"))
        assertTrue(PhoneBookLogic.contactMatches(list[1], "ami"))
        assertTrue(PhoneBookLogic.contactMatches(list[1], "8765"))
        assertTrue(PhoneBookLogic.contactMatches(list[1], "264")) // T9 "ami"
        assertFalse(PhoneBookLogic.contactMatches(list[0], "ami"))
    }

    @Test fun suggestionsMergeSourcesOnePerNumber() {
        val phone = listOf(PhoneContact(1, "k", "Rahul Mehta", "+91 98765 43210", false))
        val crm = listOf("Rahul (CRM)" to "9876543210", "Ravi" to "9812345678")
        val recents = listOf(call(9, CallKind.MISSED, 1, number = "9872000000"))
        val s = PhoneBookLogic.suggestions("987", phone, crm, recents)
        assertEquals(listOf(PhoneBookLogic.Source.PHONE, PhoneBookLogic.Source.RECENT), s.map { it.source })
        val t9 = PhoneBookLogic.suggestions("728", phone, crm, recents) // "rav"
        assertEquals(listOf("Ravi"), t9.map { it.name })
        assertTrue(PhoneBookLogic.suggestions("9", phone, crm, recents).isEmpty())
    }
}
