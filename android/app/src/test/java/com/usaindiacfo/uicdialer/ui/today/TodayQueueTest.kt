package com.usaindiacfo.uicdialer.ui.today

import com.usaindiacfo.uicdialer.data.api.ContactStatus
import org.junit.Assert.assertEquals
import org.junit.Test

class TodayQueueTest {
    private fun row(key: String, due: Long, overdue: Boolean = false, kind: TodayKind = TodayKind.FOLLOW_UP, status: ContactStatus? = null) =
        TodayRow(key = key, kind = kind, phoneE164 = "+91987654321$key".take(13), dueAtMs = due, overdue = overdue, status = status)

    @Test fun overdueThenDueTodayThenNewLeads() {
        val q = TodayQueue.order(
            listOf(
                row("lead", 1, kind = TodayKind.NEW_LEAD),
                row("today", 5),
                row("missed", 3, kind = TodayKind.MISSED_CALL),
                row("late", 9, overdue = true),
                row("later", 2, overdue = true),
            ),
        )
        assertEquals(listOf("later", "late", "missed", "today", "lead"), q.map { it.key })
    }

    @Test fun calledRowsGoToTheEnd() {
        val q = TodayQueue.order(listOf(row("a", 1, overdue = true), row("b", 2), row("c", 3)), called = setOf("a"))
        assertEquals(listOf("b", "c", "a"), q.map { it.key })
    }

    @Test fun duplicatesKeptOnce() {
        assertEquals(1, TodayQueue.order(listOf(row("a", 1), row("a", 1))).size)
    }

    @Test fun headPrefersFollowUpsOverListItem() {
        val q = TodayQueue.order(listOf(row("today", 5), row("lead", 1, kind = TodayKind.NEW_LEAD)))
        assertEquals(QueueHead.Row(q[0]), TodayQueue.head(q, emptySet(), hasListItem = true))
    }

    @Test fun headListItemBeforeNewLeadsAndCalledRows() {
        val leads = TodayQueue.order(listOf(row("lead", 1, kind = TodayKind.NEW_LEAD)))
        assertEquals(QueueHead.ListItem, TodayQueue.head(leads, emptySet(), hasListItem = true))
        val called = TodayQueue.order(listOf(row("a", 1)), setOf("a"))
        assertEquals(QueueHead.ListItem, TodayQueue.head(called, setOf("a"), hasListItem = true))
    }

    @Test fun headWithoutList() {
        assertEquals(QueueHead.Empty, TodayQueue.head(emptyList(), emptySet(), hasListItem = false))
        val leads = TodayQueue.order(listOf(row("lead", 1, kind = TodayKind.NEW_LEAD)))
        assertEquals(QueueHead.Row(leads[0]), TodayQueue.head(leads, emptySet(), hasListItem = false))
    }

    @Test fun oneLabelPerRow() {
        assertEquals("Missed call", TodayQueue.label(row("m", 1, overdue = true, kind = TodayKind.MISSED_CALL)))
        assertEquals("Overdue", TodayQueue.label(row("o", 1, overdue = true, status = ContactStatus.INTERESTED)))
        assertEquals("New lead", TodayQueue.label(row("l", 1, kind = TodayKind.NEW_LEAD)))
        assertEquals("Due today", TodayQueue.label(row("d", 1)))
    }

    @Test fun listProgressText() {
        assertEquals("12 of 40", TodayQueue.listProgress(11, 40))
        assertEquals("40 of 40", TodayQueue.listProgress(40, 40))
        assertEquals("1 of 0", TodayQueue.listProgress(0, 0))
    }

    private fun task(key: String, phone: String, due: Long, kind: TodayKind = TodayKind.MISSED_CALL, overdue: Boolean = false) =
        TodayRow(key = key, kind = kind, phoneE164 = phone, name = "Rahul Mehta", dueAtMs = due, overdue = overdue, taskId = "t-$key")

    @Test fun sameNumberMergesIntoOneEntry() {
        val rows = (1..5).map { task("m$it", "+919800000001", due = 10L + it) } + task("x", "+919800000002", 5)
        val q = TodayQueue.order(TodayQueue.merge(rows))
        assertEquals(2, q.size)
        val rahul = q.single { it.phoneE164 == "+919800000001" }
        assertEquals(5, rahul.count)
        assertEquals("5 missed calls", TodayQueue.label(rahul))
        assertEquals(11L, rahul.dueAtMs)
        assertEquals((1..5).map { "t-m$it" }, rahul.taskIds)
        assertEquals((1..5).map { "m$it" }, rahul.keys)
    }

    @Test fun mergedTakesMostImportantLabelAndEarliestDue() {
        val p = "+919800000003"
        val rows = listOf(
            task("lead", p, 1, kind = TodayKind.NEW_LEAD),
            task("m", p, 8),
            task("late", p, 9, kind = TodayKind.FOLLOW_UP, overdue = true),
        )
        val e = TodayQueue.merge(rows).single()
        assertEquals("Overdue +2 more", TodayQueue.label(e))
        assertEquals(1L, e.dueAtMs)
        assertEquals(true, e.overdue)
        assertEquals(0, TodayQueue.tier(e))
        assertEquals(3, e.taskIds.size)
    }

    @Test fun missedBeatsDueTodayAndNewLead() {
        val p = "+919800000004"
        val e = TodayQueue.merge(listOf(task("f", p, 1, kind = TodayKind.FOLLOW_UP), task("m", p, 5), task("l", p, 2, kind = TodayKind.NEW_LEAD))).single()
        assertEquals("Missed call +2 more", TodayQueue.label(e))
    }

    @Test fun singleItemUnchanged() {
        val r = task("only", "+919800000005", 3)
        assertEquals(listOf(r), TodayQueue.merge(listOf(r)))
        assertEquals("Missed call", TodayQueue.label(r))
    }

    @Test fun calledMergedEntryGoesToEnd() {
        val rows = listOf(task("a", "+919800000006", 1), task("b", "+919800000006", 2), task("c", "+919800000007", 3))
        val merged = TodayQueue.merge(rows)
        val key = merged.first { it.count == 2 }.key
        assertEquals(listOf("c", key), TodayQueue.order(merged, setOf(key)).map { it.key })
    }
}
