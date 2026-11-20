package com.usaindiacfo.uicdialer.dialer

import android.provider.CallLog
import com.usaindiacfo.uicdialer.data.api.CallOutcome
import com.usaindiacfo.uicdialer.detect.CallLogEntry
import java.time.Instant
import java.time.ZoneId

/** Pure dialer rules (no Android APIs beyond constants), unit-tested in DialLogicTest. */
object DialLogic {
    /** "Today" for follow-ups is the India calendar day, whatever the phone's zone. */
    val IST: ZoneId = ZoneId.of("Asia/Kolkata")

    /** The call log entry may be stamped slightly before we stored the dial. */
    const val DIAL_SLACK_MS = 5_000L

    /** Last 10 digits, so +91 98765 43210, 098765-43210 and 9876543210 compare equal. Null if fewer than 6 digits. */
    fun last10(raw: String?): String? {
        val digits = raw?.filter { it.isDigit() } ?: return null
        if (digits.length < 6) return null
        return digits.takeLast(10)
    }

    fun sameNumber(a: String?, b: String?): Boolean {
        val x = last10(a) ?: return false
        return x == last10(b)
    }

    /** The outgoing call the rep made after tapping Call: same number, at or after the dial (earliest first). */
    fun matchDial(entries: List<CallLogEntry>, number: String, dialedAtMs: Long): CallLogEntry? =
        entries.asSequence()
            .filter { it.type == CallLog.Calls.OUTGOING_TYPE }
            .filter { it.dateMs >= dialedAtMs - DIAL_SLACK_MS }
            .filter { sameNumber(it.number, number) }
            .minByOrNull { it.dateMs }

    /** How long after tapping Call the call log entry may start and still count as dialled from the app. */
    const val APP_DIAL_WINDOW_MS = 10 * 60_000L

    /**
     * True when the rep tapped Call in the app for [number] shortly before [callStartMs]
     * ([dials] = number to tap time). Same rule as [matchDial], bounded to [APP_DIAL_WINDOW_MS].
     */
    fun isAppDial(dials: List<Pair<String, Long>>, number: String?, callStartMs: Long): Boolean {
        val n = last10(number) ?: return false
        return dials.any { (d, at) ->
            last10(d) == n && callStartMs >= at - DIAL_SLACK_MS && callStartMs <= at + APP_DIAL_WINDOW_MS
        }
    }

    /**
     * wa.me wants the full international number as digits only. A bare 10-digit number (or 0 + 10 digits)
     * is Indian, so it gets 91; a "00" international prefix is dropped. Null if nothing usable.
     */
    fun whatsAppUrl(raw: String, text: String? = null): String? {
        val trimmed = raw.trim()
        var digits = trimmed.filter { it.isDigit() }
        if (digits.isEmpty()) return null
        if (!trimmed.startsWith("+")) {
            digits = when {
                digits.startsWith("00") -> digits.drop(2)
                digits.length == 10 -> "91$digits"
                digits.length == 11 && digits.startsWith("0") -> "91${digits.drop(1)}"
                else -> digits
            }
        }
        if (digits.length !in 8..15) return null
        if (text.isNullOrEmpty()) return "https://wa.me/$digits"
        // URLEncoder writes spaces as "+", which WhatsApp shows literally; wa.me wants %20.
        return "https://wa.me/$digits?text=" + java.net.URLEncoder.encode(text, "UTF-8").replace("+", "%20")
    }

    /** What a typed or pasted number keeps: digits, plus a leading + if it had one. */
    fun cleanNumber(raw: String): String {
        val t = raw.trim()
        val digits = t.filter { it.isDigit() }
        return if (t.startsWith("+") && digits.isNotEmpty()) "+$digits" else digits
    }

    /** Null when valid, else the message to show. Call back needs a follow-up time that isn't in the past. */
    fun validateOutcome(outcome: CallOutcome?, followUpAtMs: Long?, nowMs: Long): String? = when {
        outcome == null -> "Choose an outcome"
        outcome == CallOutcome.CALL_BACK && followUpAtMs == null -> "Pick a date and time to call back"
        outcome == CallOutcome.CALL_BACK && followUpAtMs != null && followUpAtMs < nowMs - 60_000 -> "Call-back time is in the past"
        else -> null
    }

    /** No answer when the call log shows the call never connected. */
    fun defaultOutcome(durationS: Int?): CallOutcome? = if (durationS == 0) CallOutcome.NO_ANSWER else null

    /** Follow-up due before today (IST). */
    fun isOverdue(followUpIso: String?, now: Instant = Instant.now()): Boolean {
        val at = parseInstant(followUpIso) ?: return false
        return at.isBefore(now.atZone(IST).toLocalDate().atStartOfDay(IST).toInstant())
    }

    fun parseInstant(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    /** App-dial log storage: one "number|ms" per line; entries older than 24 h are dropped. */
    fun encodeDials(dials: List<Pair<String, Long>>): String = dials.joinToString("\n") { "${it.first}|${it.second}" }

    fun decodeDials(raw: String?, nowMs: Long): List<Pair<String, Long>> =
        raw.orEmpty().lineSequence().mapNotNull { line ->
            val i = line.lastIndexOf('|')
            if (i <= 0) return@mapNotNull null
            val at = line.substring(i + 1).toLongOrNull() ?: return@mapNotNull null
            (line.substring(0, i) to at).takeIf { nowMs - at < 24 * 3600_000L }
        }.toList()
}
