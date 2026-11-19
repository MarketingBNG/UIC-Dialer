package com.usaindiacfo.uicrecorder.ui.today

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.data.api.ActivityType
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.data.api.ContactStatus
import com.usaindiacfo.uicrecorder.data.api.FollowUpItem
import com.usaindiacfo.uicrecorder.data.api.FollowUpKind
import com.usaindiacfo.uicrecorder.data.api.FollowUpPatch
import com.usaindiacfo.uicrecorder.data.api.MeToday
import com.usaindiacfo.uicrecorder.data.api.MyCallList
import com.usaindiacfo.uicrecorder.reminders.ReminderScheduler
import com.usaindiacfo.uicrecorder.reminders.Reminders
import com.usaindiacfo.uicrecorder.dialer.DialLogic
import com.usaindiacfo.uicrecorder.ui.dialer.friendlyError
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException
import java.time.Instant

enum class TodayKind { FOLLOW_UP, MISSED_CALL, NEW_LEAD }

/** One Today row; same fields as the server's FollowUpItem (GET /v1/followups/today). */
data class TodayRow(
    val key: String,
    val kind: TodayKind,
    val phoneE164: String,
    val name: String? = null,
    val company: String? = null,
    val status: ContactStatus? = null,
    val dueAtMs: Long,
    val overdue: Boolean,
    val lastNote: String? = null,
    val contactId: String? = null,
    val taskId: String? = null,
    /** Lead source for NEW_LEAD rows ("New lead · Website"). */
    val source: String? = null,
) {
    val title get() = name?.takeIf { it.isNotBlank() } ?: phoneE164
}

data class TodayState(
    val overdue: List<TodayRow> = emptyList(),
    val today: List<TodayRow> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    /** GET /v1/me/today; null offline or on older servers. */
    val me: MeToday? = null,
    /** My ACTIVE/PAUSED call lists. */
    val lists: List<MyCallList> = emptyList(),
)

/** Overdue first, then today; each sorted by due time then key. */
internal fun splitToday(rows: List<TodayRow>): Pair<List<TodayRow>, List<TodayRow>> {
    val sorted = rows.sortedWith(compareBy<TodayRow>({ it.dueAtMs }, { it.key }))
    return sorted.filter { it.overdue } to sorted.filterNot { it.overdue }
}

internal fun ContactDto.toTodayRow(now: Instant = Instant.now()): TodayRow? {
    val due = DialLogic.parseInstant(nextFollowUpAt) ?: return null
    return TodayRow(
        key = "contact:$id", kind = TodayKind.FOLLOW_UP, phoneE164 = phoneE164, name = name, company = company,
        status = status, dueAtMs = due.toEpochMilli(), overdue = DialLogic.isOverdue(nextFollowUpAt, now), contactId = id,
    )
}

internal fun FollowUpItem.toTodayRow(): TodayRow? {
    val due = DialLogic.parseInstant(dueAt) ?: return null
    return TodayRow(
        key = key,
        kind = when (kind) {
            FollowUpKind.MISSED_CALL -> TodayKind.MISSED_CALL
            FollowUpKind.NEW_LEAD -> TodayKind.NEW_LEAD
            FollowUpKind.FOLLOW_UP -> TodayKind.FOLLOW_UP
        },
        phoneE164 = phoneE164, name = name, company = company, status = status, dueAtMs = due.toEpochMilli(),
        overdue = overdue, lastNote = lastNote, contactId = contactId, taskId = taskId, source = source,
    )
}

class TodayViewModel(private val c: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(TodayState())
    val state: StateFlow<TodayState> = _state.asStateFlow()

    init {
        // Outcomes are queued on the phone; reload once one reaches the server so the list updates.
        viewModelScope.launch {
            var last = Int.MAX_VALUE
            c.db.pendingActivities().observePendingCount().collect { n ->
                if (n < last) refresh()
                last = n
            }
        }
    }

    /** GET /v1/followups/today (follow-ups + missed calls); also re-arms reminders from the fresh list. */
    private suspend fun fetchRows(): List<TodayRow> {
        val today = Reminders.fetchToday(c)
        runCatching { ReminderScheduler.reschedule(c.appContext, today) }
        return today.items.mapNotNull { it.toTodayRow() }
    }

    /** Rows to show when offline. */
    private fun cachedRows(): List<TodayRow> =
        c.contactCache.today?.items?.mapNotNull { it.toTodayRow() }
            ?: c.contactCache.followUps.mapNotNull { it.toTodayRow() }

    fun refresh() = viewModelScope.launch {
        _state.update { it.copy(loading = true) }
        val (rows, error) = try {
            fetchRows() to null
        } catch (e: IOException) {
            val shown = _state.value.overdue + _state.value.today
            shown.ifEmpty { cachedRows() } to friendlyError(e)
        }
        val (overdue, today) = splitToday(rows)
        // Targets and call lists are extras: older servers (404) or offline just hide them.
        val me = runCatching { c.apiClient.meToday() }.getOrNull()
        val lists = runCatching { c.apiClient.myCallLists().items }.getOrElse { _state.value.lists }
        _state.update { TodayState(overdue = overdue, today = today, loading = false, error = error, me = me ?: it.me, lists = lists) }
    }

    /** Missed-call or new-lead task: Done (PATCH /v1/followups/:id). Hidden at once; shown again if the server refuses. */
    fun markDone(row: TodayRow) {
        removeLocally(row)
        val taskId = row.taskId ?: return
        viewModelScope.launch {
            try {
                c.apiClient.patchFollowUp(taskId, FollowUpPatch("done"))
                c.contactCache.today = c.contactCache.today?.let { t -> t.copy(items = t.items.filterNot { it.key == row.key }) }
            } catch (e: IOException) {
                _state.update { it.copy(error = friendlyError(e)) }
                refresh()
            }
        }
    }

    fun logWhatsApp(phone: String) = viewModelScope.launch { c.activityRepository.log(phone, ActivityType.WHATSAPP) }

    private fun removeLocally(row: TodayRow) =
        _state.update { s -> s.copy(overdue = s.overdue - row, today = s.today - row) }
}
