package com.usaindiacfo.uicdialer.dialer

import com.usaindiacfo.uicdialer.data.api.CallOutcome
import com.usaindiacfo.uicdialer.data.api.OutcomeDto
import com.usaindiacfo.uicdialer.data.api.OutcomeRule
import com.usaindiacfo.uicdialer.data.api.toOutcomeRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OutcomeRuleTest {
    private val now = 1_800_000_000_000L
    private fun def(rule: String, base: CallOutcome = CallOutcome.INTERESTED, retry: Int? = null) =
        OutcomeDto(id = "x", label = "X", baseOutcome = base, rule = rule, retryHours = retry)

    @Test fun ruleToPrompt() {
        assertEquals(OutcomePrompt.NONE, OutcomeLogic.prompt(OutcomeRule.NONE))
        assertEquals(OutcomePrompt.DATE, OutcomeLogic.prompt(OutcomeRule.ASK_FOLLOW_UP))
        assertEquals(OutcomePrompt.DATE_TIME, OutcomeLogic.prompt(OutcomeRule.ASK_MEETING))
        assertEquals(OutcomePrompt.DATE_TIME, OutcomeLogic.prompt(OutcomeRule.ASK_CALLBACK))
        assertEquals(OutcomePrompt.RETRY, OutcomeLogic.prompt(OutcomeRule.RETRY))
        assertEquals(OutcomePrompt.SAVE_NOW, OutcomeLogic.prompt(OutcomeRule.CLOSE_LEAD))
        assertEquals(OutcomePrompt.CONFIRM_REMOVE, OutcomeLogic.prompt(OutcomeRule.REMOVE_FROM_LISTS))
    }

    @Test fun unknownRuleIsNone() {
        assertEquals(OutcomeRule.NONE, "SOMETHING_NEW".toOutcomeRule())
        assertEquals(OutcomeRule.NONE, null.toOutcomeRule())
        assertEquals(OutcomeRule.RETRY, "RETRY".toOutcomeRule())
    }

    @Test fun retrySetsFollowUpFromNow() {
        val d = def("RETRY", CallOutcome.NO_ANSWER, retry = 4)
        assertEquals(now + 4 * 3600_000L, OutcomeLogic.followUpFor(d, pickedMs = null, nowMs = now))
        assertNull(OutcomeLogic.validate(d, null, now))
        assertNull(OutcomeLogic.retryFollowUpMs(now, null))
    }

    @Test fun askRulesNeedADateBeforeQueueing() {
        val d = def("ASK_FOLLOW_UP")
        assertEquals("Pick a follow-up date", OutcomeLogic.validate(d, null, now))
        assertEquals("Pick a date and time", OutcomeLogic.validate(def("ASK_MEETING"), null, now))
        assertEquals("That time is in the past", OutcomeLogic.validate(d, now - 3600_000L, now))
        assertNull(OutcomeLogic.validate(d, now + 3600_000L, now))
        assertEquals(now + 3600_000L, OutcomeLogic.followUpFor(d, now + 3600_000L, now))
        // A picked date left over from another outcome is not sent for a rule without dates.
        assertNull(OutcomeLogic.followUpFor(def("CLOSE_LEAD"), now + 3600_000L, now))
    }

    @Test fun defaultsHaveFixedIdsAndCallBackAsks() {
        val d = OutcomeLogic.DEFAULTS
        assertEquals(listOf("00000000-0000-7000-8000-000000000001", "00000000-0000-7000-8000-000000000002", "00000000-0000-7000-8000-000000000003", "00000000-0000-7000-8000-000000000004"), d.map { it.id })
        assertTrue(OutcomeLogic.needsDate(d[1]))
        assertEquals(d, OutcomeLogic.visible(emptyList()))
        assertEquals("no_answer", OutcomeLogic.defaultFor(0, d)?.key)
        assertNull(OutcomeLogic.defaultFor(30, d))
    }

    @Test fun visibleIsActiveSorted() {
        val list = listOf(
            OutcomeDto("b", label = "B", sortOrder = 20), OutcomeDto("a", label = "A", sortOrder = 10),
            OutcomeDto("off", label = "Off", sortOrder = 0, active = false),
        )
        assertEquals(listOf("a", "b"), OutcomeLogic.visible(list).map { it.id })
    }

    @Test fun parsesColors() {
        assertEquals(0xFF16A34AL, OutcomeLogic.parseColor("#16A34A"))
        assertNull(OutcomeLogic.parseColor("red"))
        assertNotNull(OutcomeLogic.parseColor("64748b"))
    }
}
