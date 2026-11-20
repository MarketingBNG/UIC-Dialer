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
}
