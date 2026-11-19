package com.usaindiacfo.uicrecorder.reminders

import com.usaindiacfo.uicrecorder.data.api.FollowUpItem
import com.usaindiacfo.uicrecorder.data.api.FollowUpKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

class ReminderPlanTest {
    // 2026-11-18 10:00 IST
    private val now = Instant.parse("2026-11-18T04:30:00Z").toEpochMilli()

    private fun item(key: String, due: String, kind: FollowUpKind = FollowUpKind.FOLLOW_UP) =
        FollowUpItem(key = key, kind = kind, phoneE164 = "+919876543210", name = "Rahul", dueAt = due)

    @Test fun onlyFutureContactFollowUpsGetAlarms() {
        val plan = ReminderPlan.plan(
            listOf(
                item("contact:b", "2026-11-18T10:00:00Z"),
                item("contact:a", "2026-11-18T05:00:00Z"),
                item("contact:a", "2026-11-18T05:00:00Z"), // also in "upcoming"
                item("contact:past", "2026-11-18T04:00:00Z"),
                item("task:m", "2026-11-18T06:00:00Z", FollowUpKind.MISSED_CALL),
                item("contact:bad", "not a date"),
            ),
            emptyMap(), now,
        )
        assertEquals(listOf("contact:a", "contact:b"), plan.map { it.key })
        assertEquals(Instant.parse("2026-11-18T05:00:00Z").toEpochMilli(), plan[0].atMs)
    }

    @Test fun snoozeWinsEvenAfterDueTimePassed() {
        val snoozedTo = now + 15 * 60_000L
        val plan = ReminderPlan.plan(
            listOf(item("contact:past", "2026-11-18T04:00:00Z"), item("contact:later", "2026-11-18T10:00:00Z")),
            mapOf("contact:past" to snoozedTo, "contact:later" to now - ReminderPlan.GRACE_MS - 1), // an expired snooze is ignored
            now,
        )
        assertEquals(listOf("contact:past" to snoozedTo, "contact:later" to Instant.parse("2026-11-18T10:00:00Z").toEpochMilli()), plan.map { it.key to it.atMs })
    }

    @Test fun liveSnoozesDropsGoneAndExpired() {
        val s = mapOf("contact:a" to now + 1, "contact:gone" to now + 1, "contact:old" to now - ReminderPlan.GRACE_MS - 1)
        assertEquals(mapOf("contact:a" to now + 1), ReminderPlan.liveSnoozes(s, setOf("contact:a", "contact:old"), now))
    }

    @Test fun dueButUnfiredAlarmSurvivesResyncWithinGrace() {
        val due = Instant.parse("2026-11-18T04:27:00Z").toEpochMilli() // 3 min ago; a late setWindow alarm may not have fired
        val items = listOf(item("contact:late", "2026-11-18T04:27:00Z"), item("contact:old", "2026-11-18T03:00:00Z"))
        assertEquals(listOf("contact:late" to due), ReminderPlan.plan(items, emptyMap(), now).map { it.key to it.atMs })
        // Once it fired, it is not armed again.
        assertEquals(emptyList<String>(), ReminderPlan.plan(items, emptyMap(), now, mapOf("contact:late" to due)).map { it.key })
    }

    @Test fun firedSnoozeDoesNotReviveEarlierDueTime() {
        val due = Instant.parse("2026-11-18T04:10:00Z").toEpochMilli()
        val snoozed = due + ReminderPlan.SNOOZE_MS // fired at 4:25, snooze cleared
        val plan = ReminderPlan.plan(listOf(item("contact:a", "2026-11-18T04:10:00Z")), emptyMap(), now, mapOf("contact:a" to snoozed))
        assertEquals(emptyList<String>(), plan.map { it.key })
    }

    @Test fun rearmKeepsOverdueUnfiredButNotFired() {
        val specs = listOf(
            ReminderSpec("contact:offline", now - 2 * 60 * 60_000L, "+91"), // fell due while the phone was off
            ReminderSpec("contact:done", now - 60_000L, "+91"),
            ReminderSpec("contact:ancient", now - ReminderPlan.REARM_MAX_AGE_MS - 1, "+91"),
            ReminderSpec("contact:future", now + 60_000L, "+91"),
        )
        val kept = ReminderPlan.rearmable(specs, mapOf("contact:done" to now - 60_000L), now)
        assertEquals(listOf("contact:offline", "contact:future"), kept.map { it.key })
    }

    @Test fun titleUsesIstTimeAndFallsBackToNumber() {
        val at = Instant.parse("2026-11-18T10:00:00Z").toEpochMilli() // 3:30 pm IST
        assertEquals("Call Rahul at 3:30 pm", ReminderPlan.title(ReminderSpec("k", at, "+919876543210", "Rahul")))
        assertEquals("Call +919876543210 at 3:30 pm", ReminderPlan.title(ReminderSpec("k", at, "+919876543210", " ")))
        assertEquals("12:05 am", ReminderPlan.timeText(Instant.parse("2026-11-17T18:35:00Z").toEpochMilli()))
    }

    @Test fun bodyJoinsCompanyAndNote() {
        assertEquals("Acme · Wants a quote", ReminderPlan.body(ReminderSpec("k", 0, "1", company = "Acme", lastNote = "Wants a quote")))
        assertEquals("Acme", ReminderPlan.body(ReminderSpec("k", 0, "1", company = "Acme", lastNote = "")))
        assertNull(ReminderPlan.body(ReminderSpec("k", 0, "1")))
    }

    @Test fun nextMorningIsNextNineIst() {
        fun ist(s: String) = Instant.parse(s).toEpochMilli()
        // 08:59 IST -> 09:00 same day
        assertEquals(ist("2026-11-18T03:30:00Z"), ReminderPlan.nextMorningMs(ist("2026-11-18T03:29:00Z"), 9))
        // exactly 09:00 IST and 09:00:01 -> tomorrow
        assertEquals(ist("2026-11-19T03:30:00Z"), ReminderPlan.nextMorningMs(ist("2026-11-18T03:30:00Z"), 9))
        assertEquals(ist("2026-11-19T03:30:00Z"), ReminderPlan.nextMorningMs(ist("2026-11-18T03:30:01Z"), 9))
        // 23:00 UTC is already the next IST day (04:30), so 09:00 that day
        assertEquals(ist("2026-11-19T03:30:00Z"), ReminderPlan.nextMorningMs(ist("2026-11-18T23:00:00Z"), 9))
        assertEquals("2026-11-19", ReminderPlan.istDate(ist("2026-11-18T23:00:00Z")))
    }

    @Test fun texts() {
        assertEquals("You have 1 follow-up today", ReminderPlan.summaryText(1))
        assertEquals("You have 5 follow-ups today", ReminderPlan.summaryText(5))
        assertEquals("9:00 am", ReminderPlan.hourText(9))
        assertEquals("12:00 pm", ReminderPlan.hourText(12))
    }

    @Test fun newLeadsNotifyOnceLikeMissedCalls() {
        val lead = FollowUpItem(key = "task:l1", kind = FollowUpKind.NEW_LEAD, phoneE164 = "+919876543210", name = "Priya Shah", dueAt = "2026-11-18T04:00:00Z", source = "Website")
        val anon = lead.copy(key = "task:l2", name = null)
        val items = listOf(lead, anon, item("contact:a", "2026-11-18T10:00:00Z"))
        assertEquals(listOf("task:l1", "task:l2"), ReminderPlan.newLeads(items, emptySet()).map { it.key })
        assertEquals(listOf("task:l2"), ReminderPlan.newLeads(items, setOf("task:l1")).map { it.key })
        assertEquals("New lead: Priya Shah", ReminderPlan.newLeadTitle(lead))
        assertEquals("New lead: +919876543210", ReminderPlan.newLeadTitle(anon))
        assertEquals("Website", ReminderPlan.newLeadBody(lead))
        // Leads never get follow-up alarms; done leads are forgotten.
        assertEquals(listOf("contact:a"), ReminderPlan.plan(items, emptyMap(), now).map { it.key })
        assertEquals(setOf("task:l1"), ReminderPlan.liveLeadKeys(items, setOf("task:l1", "task:gone")))
    }
}
