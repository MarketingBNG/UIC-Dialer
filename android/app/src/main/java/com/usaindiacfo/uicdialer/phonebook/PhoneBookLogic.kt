package com.usaindiacfo.uicdialer.phonebook

import com.usaindiacfo.uicdialer.dialer.DialLogic
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** How a call-log row went (CallLog.Calls.TYPE, folded into what a rep cares about). */
enum class CallKind { INCOMING, OUTGOING, MISSED, REJECTED, OTHER }

/** One row of the phone's call log. [name] is the phone's cached contact name, if any. */
data class RecentCall(
    val id: Long,
    val number: String,
    val kind: CallKind,
    val dateMs: Long,
    val durationS: Int,
    val name: String?,
)

/** One saved phone contact (one row per contact, its first/primary number). */
data class PhoneContact(
    val id: Long,
    val lookupKey: String,
    val name: String,
    val number: String,
    val starred: Boolean,
)

enum class RecentsFilter(val label: String) { ALL("All"), MISSED("Missed"), INCOMING("Incoming"), OUTGOING("Outgoing") }

/** A day header and the calls under it, newest first. */
data class DayGroup(val day: LocalDate, val calls: List<RecentCall>)

/** Pure phone-book rules (no Android APIs), unit-tested in PhoneBookLogicTest. */
object PhoneBookLogic {
    // CallLog.Calls TYPE values (copied so this stays JVM-testable).
    const val TYPE_INCOMING = 1
    const val TYPE_OUTGOING = 2
    const val TYPE_MISSED = 3
    const val TYPE_VOICEMAIL = 4
    const val TYPE_REJECTED = 5
    const val TYPE_BLOCKED = 6

    fun kindOf(type: Int): CallKind = when (type) {
        TYPE_INCOMING -> CallKind.INCOMING
        TYPE_OUTGOING -> CallKind.OUTGOING
        TYPE_MISSED -> CallKind.MISSED
        TYPE_REJECTED, TYPE_BLOCKED -> CallKind.REJECTED
        else -> CallKind.OTHER
    }

    /** Missed counts rejected calls too (they were never answered). */
    fun matchesFilter(c: RecentCall, f: RecentsFilter): Boolean = when (f) {
        RecentsFilter.ALL -> true
        RecentsFilter.MISSED -> c.kind == CallKind.MISSED || c.kind == CallKind.REJECTED
        RecentsFilter.INCOMING -> c.kind == CallKind.INCOMING
        RecentsFilter.OUTGOING -> c.kind == CallKind.OUTGOING
    }

    /** Search over name (or a resolved [nameOf]) and the number's digits. */
    fun matchesSearch(c: RecentCall, q: String, nameOf: (String) -> String? = { null }): Boolean {
        val t = q.trim()
        if (t.isEmpty()) return true
        val name = c.name ?: nameOf(c.number)
        if (name?.contains(t, ignoreCase = true) == true) return true
        val digits = t.filter(Char::isDigit)
        return digits.isNotEmpty() && t.all { it.isDigit() || it in "+-() " } &&
            c.number.filter(Char::isDigit).contains(digits)
    }

    fun filterRecents(calls: List<RecentCall>, f: RecentsFilter, q: String, nameOf: (String) -> String? = { null }) =
        calls.filter { matchesFilter(it, f) && matchesSearch(it, q, nameOf) }

    /** Groups by calendar day in [zone], newest day first, calls newest first. */
    fun groupByDay(calls: List<RecentCall>, zone: ZoneId): List<DayGroup> =
        calls.sortedByDescending { it.dateMs }
            .groupBy { Instant.ofEpochMilli(it.dateMs).atZone(zone).toLocalDate() }
            .map { (d, cs) -> DayGroup(d, cs) }

    /** "Today" / "Yesterday" / null (caller formats the date). */
    fun dayLabel(day: LocalDate, today: LocalDate): String? = when (day) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> null
    }

    /** "1h 2m", "3m 5s", "42s"; null for an unconnected call. */
    fun formatDuration(s: Int): String? = when {
        s <= 0 -> null
        s >= 3600 -> "${s / 3600}h ${(s % 3600) / 60}m"
        s >= 60 -> "${s / 60}m ${s % 60}s"
        else -> "${s}s"
    }

    /** Key for comparing numbers: last 10 digits, or all digits for short numbers. */
    fun numberKey(raw: String?): String? {
        val d = raw?.filter(Char::isDigit).orEmpty()
        if (d.isEmpty()) return null
        return DialLogic.last10(d) ?: d
    }

    private val T9 = mapOf(
        'a' to '2', 'b' to '2', 'c' to '2', 'd' to '3', 'e' to '3', 'f' to '3',
        'g' to '4', 'h' to '4', 'i' to '4', 'j' to '5', 'k' to '5', 'l' to '5',
        'm' to '6', 'n' to '6', 'o' to '6', 'p' to '7', 'q' to '7', 'r' to '7', 's' to '7',
        't' to '8', 'u' to '8', 'v' to '8', 'w' to '9', 'x' to '9', 'y' to '9', 'z' to '9',
    )

    /** "Rahul Mehta" -> "72485 634382"-style keypad digits, one word per entry. */
    fun t9Words(name: String): List<String> =
        name.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }.map { w ->
            w.map { ch -> if (ch.isDigit()) ch else T9[ch] ?: '1' }.joinToString("")
        }

    /** True when [digits] (keypad input) starts any word of [name], or the whole name typed through. */
    fun t9Matches(name: String, digits: String): Boolean {
        if (digits.isEmpty() || digits.any { !it.isDigit() }) return false
        val words = t9Words(name)
        if (words.any { it.startsWith(digits) }) return true
        // Across words from any word start: "rahulm" for "Rahul Mehta".
        for (i in words.indices) if (words.drop(i).joinToString("").startsWith(digits)) return true
        return false
    }

    /** Typed digits appear in the number (ignoring formatting). */
    fun numberMatches(number: String, typed: String): Boolean {
        val d = typed.filter(Char::isDigit)
        return d.isNotEmpty() && number.filter(Char::isDigit).contains(d)
    }

    /** Alphabetical, case-insensitive, letters before digits/symbols ("#" section last). */
    fun sortContacts(list: List<PhoneContact>): List<PhoneContact> =
        list.sortedWith(compareBy<PhoneContact> { !(it.name.firstOrNull()?.isLetter() ?: false) }.thenBy { it.name.lowercase() })

    /** Section letter for the A–Z list. */
    fun sectionOf(name: String): String = name.firstOrNull()?.takeIf { it.isLetter() }?.uppercaseChar()?.toString() ?: "#"

    /** Name or number contains the query; digits also match T9 on the name. */
    fun contactMatches(c: PhoneContact, q: String): Boolean {
        val t = q.trim()
        if (t.isEmpty()) return true
        if (c.name.contains(t, ignoreCase = true)) return true
        val isDigits = t.all { it.isDigit() || it in "+-() " } && t.any(Char::isDigit)
        return isDigits && (numberMatches(c.number, t) || t9Matches(c.name, t.filter(Char::isDigit)))
    }

    /** One row per number key (latest name wins), so duplicate entries of one contact don't repeat. */
    fun dedupeByNumber(list: List<PhoneContact>): List<PhoneContact> =
        list.distinctBy { numberKey(it.number) ?: "id:${it.id}" }

    /** Keypad suggestion source. */
    enum class Source { PHONE, CRM, RECENT }

    data class Suggestion(val name: String?, val number: String, val source: Source)

    /**
     * Keypad suggestions for [typed]: phone contacts, then CRM, then recent numbers; one per number, at most [limit].
     * Fewer than 2 digits suggests nothing (too broad).
     */
    fun suggestions(
        typed: String,
        phone: List<PhoneContact>,
        crm: List<Pair<String?, String>>,
        recents: List<RecentCall>,
        limit: Int = 6,
    ): List<Suggestion> {
        val d = typed.filter(Char::isDigit)
        if (d.length < 2) return emptyList()
        val out = LinkedHashMap<String, Suggestion>()
        fun add(s: Suggestion) {
            val k = numberKey(s.number) ?: return
            if (k !in out) out[k] = s
        }
        phone.asSequence().filter { numberMatches(it.number, d) || t9Matches(it.name, d) }
            .forEach { add(Suggestion(it.name, it.number, Source.PHONE)) }
        crm.asSequence().filter { (n, num) -> numberMatches(num, d) || (n != null && t9Matches(n, d)) }
            .forEach { (n, num) -> add(Suggestion(n, num, Source.CRM)) }
        recents.asSequence().filter { numberMatches(it.number, d) || (it.name != null && t9Matches(it.name, d)) }
            .forEach { add(Suggestion(it.name, it.number, Source.RECENT)) }
        return out.values.take(limit)
    }
}
