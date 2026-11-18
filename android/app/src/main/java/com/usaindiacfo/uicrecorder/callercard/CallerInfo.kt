package com.usaindiacfo.uicrecorder.callercard

import com.usaindiacfo.uicrecorder.data.api.ContactByPhone
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.data.api.ContactStatus
import com.usaindiacfo.uicrecorder.data.api.FollowUpItem
import com.usaindiacfo.uicrecorder.dialer.DialLogic

/** What the caller card shows. [known] false = a number we have no contact for. */
data class CallerInfo(
    val number: String,
    val known: Boolean,
    val name: String? = null,
    val company: String? = null,
    val status: ContactStatus? = null,
    val note: String? = null,
) {
    val title get() = if (known) name?.takeIf { it.isNotBlank() } ?: number else number
    val subtitle get() = if (known) listOfNotNull(company?.takeIf { it.isNotBlank() }, status?.let(::statusText)).joinToString(" · ").ifEmpty { null }
    else "New number — save after the call"
}

/** Pure lookups, unit-tested in CallerInfoTest. */
object CallerLookup {
    /** From what the phone already has (works offline): cached contacts, then today's follow-ups. */
    fun local(number: String, contacts: List<ContactDto>, today: List<FollowUpItem>): CallerInfo? {
        val n = DialLogic.last10(number) ?: return null
        val item = today.firstOrNull { DialLogic.last10(it.phoneE164) == n && it.contactId != null }
        val c = contacts.firstOrNull { DialLogic.last10(it.phoneE164) == n }
        if (c == null && item == null) return null
        return CallerInfo(
            number = number, known = true,
            name = c?.name ?: item?.name, company = c?.company ?: item?.company,
            status = c?.status ?: item?.status, note = item?.lastNote,
        )
    }

    /** Server answer merged over the local one: AI summary of the last call, else the newest note. */
    fun merge(number: String, server: ContactByPhone?, local: CallerInfo?): CallerInfo {
        val c = server?.contact ?: return local ?: CallerInfo(number, known = false)
        val note = server.lastSummary?.takeIf { it.isNotBlank() }
            ?: server.activities.sortedByDescending { it.occurredAt }.firstNotNullOfOrNull { it.note?.takeIf(String::isNotBlank) }
            ?: local?.note
        return CallerInfo(number, known = true, name = c.name, company = c.company, status = c.status, note = note)
    }
}

internal fun statusText(s: ContactStatus) = when (s) {
    ContactStatus.NEW -> "New"
    ContactStatus.INTERESTED -> "Interested"
    ContactStatus.CALL_BACK -> "Call back"
    ContactStatus.NOT_INTERESTED -> "Not interested"
    ContactStatus.NO_ANSWER -> "No answer"
}
