package com.usaindiacfo.uicrecorder.ui.lists

import com.usaindiacfo.uicrecorder.data.api.ListProgress
import com.usaindiacfo.uicrecorder.data.api.ListResult

/** What the session does next after the rep comes back from a call (pure, see ListSessionLogicTest). */
enum class SessionAction {
    /** Nothing dialled from this session: just show what we have. */
    IDLE,
    /** The outcome sheet for our dial is still open (or about to be). */
    WAIT_SHEET,
    /** The outcome is queued on the phone; ask for the next contact only once the server has it. */
    WAIT_SYNC,
    /** The outcome reached the server (or the sheet was skipped): ask for the next contact. */
    FETCH_NEXT,
    /** The server rejected the outcome for good: it will never arrive, so tell the rep instead of quietly re-showing the contact. */
    SYNC_FAILED,
}

object ListSessionLogic {
    /**
     * [awaiting] = clientId of the dial this session started; [pendingDial] = clientId of the dial the outcome sheet
     * still has to ask about; [rowQueued] = that activity is still in pending_activities;
     * [rowFailed] = the server rejected it permanently (lastError set).
     *
     * The server's `next` returns the item I already hold while my lease lasts, so asking before the outcome
     * arrives would show the same contact again. A skipped sheet has no row: `next` then returns the same
     * contact, which is right.
     */
    fun afterCall(awaiting: String?, pendingDial: String?, rowQueued: Boolean, rowFailed: Boolean = false): SessionAction = when {
        awaiting == null -> SessionAction.IDLE
        pendingDial == awaiting -> SessionAction.WAIT_SHEET
        rowFailed -> SessionAction.SYNC_FAILED
        rowQueued -> SessionAction.WAIT_SYNC
        else -> SessionAction.FETCH_NEXT
    }

    /** "12 of 40 done". */
    fun progressText(p: ListProgress): String = "${p.done} of ${p.total} done"

    /** "3 interested · 5 call back": outcomes with a count, largest first, at most [max]. */
    fun resultsText(results: List<ListResult>, max: Int = 3): String =
        results.filter { it.count > 0 }.sortedByDescending { it.count }.take(max)
            .joinToString(" · ") { "${it.count} ${it.label.lowercase()}" }

    /** 0..1 for the progress bar. */
    fun fraction(p: ListProgress): Float = if (p.total <= 0) 0f else (p.done.toFloat() / p.total).coerceIn(0f, 1f)
}
