package com.usaindiacfo.uicdialer.ui.today

import com.usaindiacfo.uicdialer.ui.dialer.label

/** What the big "Next up" card shows. */
sealed interface QueueHead {
    data class Row(val row: TodayRow) : QueueHead
    /** The next item of the active call list. */
    data object ListItem : QueueHead
    data object Empty : QueueHead
}

/** Call-queue ordering for Today (pure; see TodayQueueTest). */
object TodayQueue {
    /** 0 = overdue, 1 = due today (follow-ups, missed calls), 2 = new leads. */
    fun tier(row: TodayRow): Int = when {
        row.overdue -> 0
        row.kind == TodayKind.NEW_LEAD -> 2
        else -> 1
    }

    /**
     * Overdue first, then due today, then new leads; each by due time then key. Rows already called (or snoozed
     * locally) this session in [called] go to the end so the next contact comes up after an outcome is saved.
     */
    fun order(rows: List<TodayRow>, called: Set<String> = emptySet()): List<TodayRow> =
        rows.distinctBy { it.key }.sortedWith(
            compareBy<TodayRow>({ it.key in called }, { tier(it) }, { it.dueAtMs }, { it.key }),
        )

    /**
     * Head of the queue. An active list item ranks with new leads: overdue and due-today rows come before it,
     * new leads after it. Rows already called this session never beat a list item.
     */
    fun head(ordered: List<TodayRow>, called: Set<String>, hasListItem: Boolean): QueueHead {
        val first = ordered.firstOrNull()
        return when {
            first != null && first.key !in called && tier(first) < 2 -> QueueHead.Row(first)
            hasListItem -> QueueHead.ListItem
            first != null -> QueueHead.Row(first)
            else -> QueueHead.Empty
        }
    }

    /** The one status label a row shows. */
    fun label(row: TodayRow): String = when {
        row.kind == TodayKind.MISSED_CALL -> "Missed call"
        row.overdue -> "Overdue"
        row.kind == TodayKind.NEW_LEAD -> "New lead"
        row.status != null -> row.status.label
        else -> "Due today"
    }

    /** "12 of 40" (position of the current item among all items). */
    fun listProgress(done: Int, total: Int): String = "${(done + 1).coerceAtMost(total.coerceAtLeast(1))} of $total"
}
