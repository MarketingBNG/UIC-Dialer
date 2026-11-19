package com.usaindiacfo.uicrecorder.ui.lists

import com.usaindiacfo.uicrecorder.data.api.ListProgress
import com.usaindiacfo.uicrecorder.data.api.ListResult
import org.junit.Assert.assertEquals
import org.junit.Test

class ListSessionLogicTest {
    @Test fun progressText() {
        assertEquals("12 of 40 done", ListSessionLogic.progressText(ListProgress(total = 40, done = 12)))
        assertEquals(0.3f, ListSessionLogic.fraction(ListProgress(total = 40, done = 12)), 0.0001f)
        assertEquals(0f, ListSessionLogic.fraction(ListProgress()), 0f)
    }

    @Test fun resultsText() {
        val r = listOf(ListResult("a", "Interested", count = 3), ListResult("b", "Call back", count = 5), ListResult("c", "Wrong number", count = 0))
        assertEquals("5 call back · 3 interested", ListSessionLogic.resultsText(r))
        assertEquals("", ListSessionLogic.resultsText(emptyList()))
    }

    /** Auto-advance: dial -> sheet open -> outcome queued -> sent -> next. */
    @Test fun autoAdvanceStateMachine() {
        assertEquals(SessionAction.IDLE, ListSessionLogic.afterCall(null, null, false))
        // Sheet not answered yet (or the call is still live).
        assertEquals(SessionAction.WAIT_SHEET, ListSessionLogic.afterCall("d1", "d1", false))
        // Outcome saved but still in the phone's queue: asking now would return the same contact.
        assertEquals(SessionAction.WAIT_SYNC, ListSessionLogic.afterCall("d1", null, true))
        // The server has it.
        assertEquals(SessionAction.FETCH_NEXT, ListSessionLogic.afterCall("d1", null, false))
        // Sheet skipped (no row): next returns the same held item, which is right.
        assertEquals(SessionAction.FETCH_NEXT, ListSessionLogic.afterCall("d1", null, false))
        // A newer dial from elsewhere replaced ours: ours can't be pending any more.
        assertEquals(SessionAction.WAIT_SYNC, ListSessionLogic.afterCall("d1", "d2", true))
        // The server rejected the outcome (400/422/409): say so rather than re-showing the same contact.
        assertEquals(SessionAction.SYNC_FAILED, ListSessionLogic.afterCall("d1", null, false, rowFailed = true))
    }
}
