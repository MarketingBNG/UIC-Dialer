package com.usaindiacfo.uicdialer.dialer

import com.usaindiacfo.uicdialer.data.api.CallOutcome
import com.usaindiacfo.uicdialer.data.api.OutcomeDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class QuickPickTest {
    private val zone = ZoneId.of("Asia/Kolkata")
    private fun ms(y: Int, mo: Int, d: Int, h: Int, mi: Int) = LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()
    private fun def(rule: String, base: CallOutcome = CallOutcome.INTERESTED) = OutcomeDto(id = "x", label = "X", baseOutcome = base, rule = rule)

    @Test fun inOneHourRoundsUpToFiveMinutes() {
        assertEquals(ms(2026, 11, 20, 15, 35), OutcomeLogic.quickPickMs(QuickPick.IN_1_HOUR, ms(2026, 11, 20, 14, 31), zone))
        assertEquals(ms(2026, 11, 20, 15, 30), OutcomeLogic.quickPickMs(QuickPick.IN_1_HOUR, ms(2026, 11, 20, 14, 30), zone))
    }

    @Test fun tomorrowAndNextWeekAt11() {
        val now = ms(2026, 11, 30, 23, 50)
        assertEquals(ms(2026, 12, 1, 11, 0), OutcomeLogic.quickPickMs(QuickPick.TOMORROW_11, now, zone))
        assertEquals(ms(2026, 12, 7, 11, 0), OutcomeLogic.quickPickMs(QuickPick.NEXT_WEEK, now, zone))
    }

    @Test fun whichOutcomesNeedADate() {
        assertTrue(OutcomeLogic.savesOnTap(def("NONE")))
        assertTrue(OutcomeLogic.savesOnTap(def("RETRY")))
        assertTrue(OutcomeLogic.savesOnTap(def("REMOVE_FROM_LISTS")))
        assertFalse(OutcomeLogic.savesOnTap(def("ASK_CALLBACK")))
        assertFalse(OutcomeLogic.savesOnTap(def("ASK_MEETING")))
        assertFalse(OutcomeLogic.savesOnTap(def("ASK_FOLLOW_UP")))
        assertFalse(OutcomeLogic.savesOnTap(def("NONE", CallOutcome.CALL_BACK)))
    }

    @Test fun picksPerRule() {
        assertEquals(emptyList<QuickPick>(), OutcomeLogic.quickPicks(def("NONE")))
        assertEquals(QuickPick.entries, OutcomeLogic.quickPicks(def("ASK_CALLBACK")))
        assertEquals(listOf(QuickPick.TOMORROW_11, QuickPick.NEXT_WEEK), OutcomeLogic.quickPicks(def("ASK_FOLLOW_UP")))
    }

    @Test fun daysAheadAtTimeSlot() {
        val now = ms(2026, 11, 28, 22, 10)
        assertEquals(ms(2026, 12, 2, 15, 0), OutcomeLogic.dayTimeMs(DayPick.IN_4.days, TimeSlot.AFTERNOON, now, zone))
        assertEquals(ms(2026, 12, 8, 10, 0), OutcomeLogic.dayTimeMs(DayPick.IN_10.days, TimeSlot.MORNING, now, zone))
        assertEquals(ms(2026, 11, 29, 18, 0), OutcomeLogic.dayTimeMs(DayPick.TOMORROW.days, TimeSlot.EVENING, now, zone))
    }

    @Test fun exactTimeOnAPickedDate() {
        assertEquals(ms(2026, 12, 5, 16, 45), OutcomeLogic.atMs(java.time.LocalDate.of(2026, 12, 5), java.time.LocalTime.of(16, 45), zone))
    }
}
