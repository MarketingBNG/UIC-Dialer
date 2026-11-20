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

    /** Label importance: 0 overdue, 1 missed call, 2 due today, 3 new lead. */
    fun labelRank(row: TodayRow): Int = when {
        row.overdue -> 0
        row.kind == TodayKind.MISSED_CALL -> 1
        row.kind == TodayKind.NEW_LEAD -> 3
        else -> 2
    }

    /**
     * One entry per phone number: items for the same number merge into the most important one (by [labelRank],
     * then earliest due), with the earliest due time, overdue if any is, and every key / task id kept.
     */
    fun merge(rows: List<TodayRow>): List<TodayRow> =
        rows.distinctBy { it.key }.groupBy { it.phoneE164 }.values.map { group ->
            if (group.size == 1) return@map group[0]
            val best = group.minWith(compareBy<TodayRow>({ labelRank(it) }, { it.dueAtMs }, { it.key }))
            val rank = labelRank(best)
            val same = group.count { labelRank(it) == rank }
            val noun = when (rank) {
                0 -> "overdue"
                1 -> if (same > 1) "missed calls" else "missed call"
                3 -> if (same > 1) "new leads" else "new lead"
                else -> "due today"
            }
            val others = group.size - same
            val text = (if (same > 1) "$same $noun" else label(best)) + if (others > 0) " +$others more" else ""
            best.copy(
                key = "phone:${best.phoneE164}",
                dueAtMs = group.minOf { it.dueAtMs },
                overdue = group.any { it.overdue },
                name = best.name ?: group.firstNotNullOfOrNull { it.name },
                company = best.company ?: group.firstNotNullOfOrNull { it.company },
                contactId = best.contactId ?: group.firstNotNullOfOrNull { it.contactId },
                lastNote = best.lastNote ?: group.firstNotNullOfOrNull { it.lastNote },
                count = group.size,
                keys = group.map { it.key },
                taskIds = group.mapNotNull { it.taskId },
                mergedLabel = text,
            )
        }

    /** The one status label a row shows. */
    fun label(row: TodayRow): String = row.mergedLabel ?: when {
        row.kind == TodayKind.MISSED_CALL -> "Missed call"
        row.overdue -> "Overdue"
        row.kind == TodayKind.NEW_LEAD -> "New lead"
        row.status != null -> row.status.label
        else -> "Due today"
    }

    /** "12 of 40" (position of the current item among all items). */
    fun listProgress(done: Int, total: Int): String = "${(done + 1).coerceAtMost(total.coerceAtLeast(1))} of $total"
}
