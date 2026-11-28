package com.usaindiacfo.uicdialer.ui.lists

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.usaindiacfo.uicdialer.AppContainer
import com.usaindiacfo.uicdialer.data.api.ApiException
import com.usaindiacfo.uicdialer.data.api.ListItemDto
import com.usaindiacfo.uicdialer.data.api.ListProgress
import com.usaindiacfo.uicdialer.data.api.ListResult
import com.usaindiacfo.uicdialer.data.api.MyCallList
import com.usaindiacfo.uicdialer.data.api.NextResponse
import com.usaindiacfo.uicdialer.dialer.DialPrefs
import com.usaindiacfo.uicdialer.sync.SyncScheduler
import com.usaindiacfo.uicdialer.ui.dialer.friendlyError
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

enum class SessionPhase { LOADING, READY, WAIT_SHEET, WAIT_SYNC, EMPTY, PAUSED, NOT_ASSIGNED, ERROR }

data class ListSessionState(
    val list: MyCallList? = null,
    val item: ListItemDto? = null,
    val progress: ListProgress = ListProgress(),
    val results: List<ListResult> = emptyList(),
    val phase: SessionPhase = SessionPhase.LOADING,
    val error: String? = null,
    /** Outcome queued but not on the server yet for a while: show "Waiting for network". */
    val offline: Boolean = false,
    /** The next contact came after a saved outcome: the screen counts down 5 s and dials it unless cancelled. */
    val autoDial: Boolean = false,
)

/** Power-dial session over one call list: claim next, call, wait for the outcome to reach the server, advance. */
class ListSessionViewModel(private val c: AppContainer, val listId: String) : ViewModel() {
    private val _state = MutableStateFlow(ListSessionState())
    val state: StateFlow<ListSessionState> = _state.asStateFlow()

    /** clientId of the dial started from this session, until its outcome reaches the server. */
    private var awaiting: String? = null
    private var watch: Job? = null

    init {
        viewModelScope.launch {
            runCatching { c.apiClient.myCallLists().items.firstOrNull { it.id == listId } }.getOrNull()?.let { l ->
                _state.update { it.copy(list = l, progress = l.progress, results = l.results) }
            }
        }
        next()
    }

    fun next() = viewModelScope.launch {
        _state.update { it.copy(phase = if (it.item == null) SessionPhase.LOADING else it.phase, error = null) }
        apply { c.apiClient.nextInList(listId) }
    }

    /** "Cancel" on the countdown: stay on this contact and wait for the rep. */
    fun cancelAutoDial() = _state.update { it.copy(autoDial = false) }

    fun skip() {
        _state.update { it.copy(autoDial = false) }
        val item = _state.value.item ?: run { next(); return }
        awaiting = null
        watch?.cancel()
        viewModelScope.launch {
            apply {
                try {
                    c.apiClient.skipItem(item.id)
                } catch (e: ApiException) {
                    if (e.code == 409 && e.errorCode == null) c.apiClient.nextInList(listId) else throw e // lease expired
                }
            }
        }
    }

    /** Pause: drop my lease so a colleague can take the number. */
    fun pause(onDone: () -> Unit) = viewModelScope.launch {
        watch?.cancel()
        released = true
        runCatching { c.apiClient.releaseList(listId) }
        onDone()
    }

    private var released = false

    /**
     * Leaving by the back arrow, system Back or a tab switch: release the lease too, unless a dial from here is
     * still waiting for its outcome (the server needs the held item to attach it to).
     */
    override fun onCleared() {
        if (released || awaiting != null) return
        released = true
        c.appScope.launch { runCatching { c.apiClient.releaseList(listId) } }
    }

    fun onDialed(clientId: String) {
        awaiting = clientId
        _state.update { it.copy(phase = SessionPhase.WAIT_SHEET, autoDial = false) }
        watchOutcome()
    }

    /** Back from the call or the outcome sheet. */
    fun onResume() {
        if (awaiting != null) watchOutcome()
    }

    private fun watchOutcome() {
        if (watch?.isActive == true) return
        watch = viewModelScope.launch {
            var waitedMs = 0L
            var nudged = false
            while (true) {
                val id = awaiting ?: return@launch
                val pending = DialPrefs(c.appContext).pending?.clientId
                val queued = c.db.pendingActivities().observeQueued(id).first()
                val failed = !queued && c.db.pendingActivities().isFailed(id)
                when (ListSessionLogic.afterCall(id, pending, queued, failed)) {
                    SessionAction.IDLE -> return@launch
                    SessionAction.WAIT_SHEET -> _state.update { it.copy(phase = SessionPhase.WAIT_SHEET, offline = false) }
                    SessionAction.WAIT_SYNC -> {
                        if (!nudged) { SyncScheduler.enqueueActivities(c.appContext); nudged = true }
                        waitedMs += POLL_MS
                        _state.update { it.copy(phase = SessionPhase.WAIT_SYNC, offline = waitedMs >= OFFLINE_AFTER_MS) }
                    }
                    SessionAction.SYNC_FAILED -> {
                        // The server still holds this contact for me; keep it on screen so the rep can call again or skip.
                        awaiting = null
                        _state.update {
                            it.copy(
                                phase = if (it.item == null) SessionPhase.ERROR else SessionPhase.READY, offline = false,
                                error = "The outcome for this call couldn't be saved. Call again or skip to move on.",
                            )
                        }
                        return@launch
                    }
                    SessionAction.FETCH_NEXT -> {
                        awaiting = null
                        _state.update { it.copy(offline = false) }
                        val prevId = _state.value.item?.id
                        apply { c.apiClient.nextInList(listId) }
                        // Only a new contact after a finished call gets the countdown (a skipped sheet returns the same one).
                        _state.update { it.copy(autoDial = it.phase == SessionPhase.READY && it.item != null && it.item.id != prevId && it.item.contact.dnc == null) }
                        return@launch
                    }
                }
                delay(POLL_MS)
            }
        }
    }

    private suspend fun apply(call: suspend () -> NextResponse) {
        try {
            val r = call()
            _state.update {
                it.copy(
                    item = r.item, progress = r.progress, results = r.results, error = null, offline = false,
                    phase = if (r.item == null) SessionPhase.EMPTY else SessionPhase.READY,
                )
            }
        } catch (e: ApiException) {
            when {
                e.errorCode == "LIST_PAUSED" -> _state.update { it.copy(phase = SessionPhase.PAUSED) }
                e.errorCode == "NOT_ASSIGNED" || e.code == 403 -> _state.update { it.copy(phase = SessionPhase.NOT_ASSIGNED) }
                else -> _state.update { it.copy(phase = if (it.item == null) SessionPhase.ERROR else SessionPhase.READY, error = friendlyError(e)) }
            }
        } catch (e: IOException) {
            _state.update { it.copy(phase = if (it.item == null) SessionPhase.ERROR else SessionPhase.READY, error = friendlyError(e)) }
        }
    }

    private companion object {
        const val POLL_MS = 1000L
        const val OFFLINE_AFTER_MS = 4000L
    }
}
