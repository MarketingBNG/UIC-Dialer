package com.usaindiacfo.uicdialer.callercard

import com.usaindiacfo.uicdialer.data.api.ActivityDto
import com.usaindiacfo.uicdialer.data.api.ActivityType
import com.usaindiacfo.uicdialer.data.api.ContactByPhone
import com.usaindiacfo.uicdialer.data.api.ContactDto
import com.usaindiacfo.uicdialer.data.api.ContactStatus
import com.usaindiacfo.uicdialer.data.api.FollowUpItem
import com.usaindiacfo.uicdialer.data.api.FollowUpKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class CallerInfoTest {
    private val contact = ContactDto("c1", "+919876543210", name = "Rahul", company = "Acme", status = ContactStatus.INTERESTED)

    @Test fun localMatchesByLast10() {
        val info = CallerLookup.local("09876543210", listOf(contact), emptyList())!!
        assertEquals("Rahul", info.title)
        assertEquals("Acme · Interested", info.subtitle)
        assertNull(CallerLookup.local("9876543211", listOf(contact), emptyList()))
        assertNull(CallerLookup.local("123", listOf(contact), emptyList()))
    }

    @Test fun localUsesTodaysNoteAndIgnoresMissedTasksWithoutContact() {
        val today = listOf(
            FollowUpItem("contact:c1", FollowUpKind.FOLLOW_UP, contactId = "c1", phoneE164 = "+919876543210", dueAt = "x", lastNote = "Send quote"),
            FollowUpItem("task:t", FollowUpKind.MISSED_CALL, phoneE164 = "+919876543299", name = "Cached", dueAt = "x"),
        )
        assertEquals("Send quote", CallerLookup.local("9876543210", emptyList(), today)!!.note)
        assertNull(CallerLookup.local("9876543299", emptyList(), today))
    }

    @Test fun mergePrefersSummaryThenNewestNote() {
        fun act(note: String?, at: String) = ActivityDto("a$at", "c$at", ActivityType.NOTE, note = note, occurredAt = at)
        val server = ContactByPhone(contact, listOf(act("old", "2026-11-01T00:00:00Z"), act("new", "2026-11-02T00:00:00Z"), act(null, "2026-11-03T00:00:00Z")))
        assertEquals("new", CallerLookup.merge("9876543210", server, null).note)
        assertEquals("AI summary", CallerLookup.merge("9876543210", server.copy(lastSummary = "AI summary"), null).note)
    }

    @Test fun unknownNumberAsksToSave() {
        val info = CallerLookup.merge("+919000000000", ContactByPhone(), null)
        assertFalse(info.known)
        assertEquals("+919000000000", info.title)
        assertEquals("New number — save after the call", info.subtitle)
        // Offline: the local answer is kept.
        assertEquals("Rahul", CallerLookup.merge("9876543210", null, CallerLookup.local("9876543210", listOf(contact), emptyList())).title)
    }
}
