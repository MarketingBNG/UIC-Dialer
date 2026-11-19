package com.usaindiacfo.uicrecorder.reminders

import com.usaindiacfo.uicrecorder.data.api.FollowUpItem
import com.usaindiacfo.uicrecorder.data.api.FollowUpKind
import com.usaindiacfo.uicrecorder.dialer.DialLogic
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One follow-up alarm. [key] is the server item key ("contact:<id>"). */
@Serializable
data class ReminderSpec(
    val key: String,
    val atMs: Long,
    val phone: String,
    val name: String? = null,
    val company: String? = null,
    val lastNote: String? = null,
)

/** Pure reminder rules, unit-tested in ReminderPlanTest. */
object ReminderPlan {
    const val SNOOZE_MS = 15 * 60_000L

    /**
     * How long past its time an alarm that has not fired yet is kept. Inexact (setWindow, up to 10 min) and
     * Doze-delayed alarms fire late; a re-sync in between must not cancel them.
     */
    const val GRACE_MS = 30 * 60_000L

    /** Rearm (boot): unfired alarms up to this old still show, right away. */
    const val REARM_MAX_AGE_MS = 12 * 60 * 60_000L

    /** True when an alarm at [atMs] for [key] is later than the last one that fired and is not older than the grace period. */
    fun pending(key: String, atMs: Long, fired: Map<String, Long>, nowMs: Long, graceMs: Long = GRACE_MS): Boolean =
        atMs > nowMs - graceMs && atMs > (fired[key] ?: Long.MIN_VALUE)

    /**
     * Alarms to keep: contact follow-ups due after [nowMs], or due a little earlier but not fired yet ([fired] is
     * key to the latest alarm time that fired; anything at or before it is done). A pending snooze wins over the due time, even when that has passed;
     * snoozes for items the server no longer returns are dropped.
     */
    fun plan(items: List<FollowUpItem>, snoozes: Map<String, Long>, nowMs: Long, fired: Map<String, Long> = emptyMap()): List<ReminderSpec> =
        items.asSequence()
            .filter { it.kind == FollowUpKind.FOLLOW_UP }
            .distinctBy { it.key }
            .mapNotNull { item ->
                val due = DialLogic.parseInstant(item.dueAt)?.toEpochMilli() ?: return@mapNotNull null
                val at = snoozes[item.key]?.takeIf { pending(item.key, it, fired, nowMs) }
                    ?: due.takeIf { pending(item.key, it, fired, nowMs) } ?: return@mapNotNull null
                ReminderSpec(item.key, at, item.phoneE164, item.name, item.company, item.lastNote)
            }
            .sortedBy { it.atMs }
            .toList()

    /**
     * NEW_LEAD items to notify now: new keys only ([notified] = keys already shown), like a missed call.
     * Leads are notified once; follow-up alarms stay FOLLOW_UP only.
     */
    fun newLeads(items: List<FollowUpItem>, notified: Set<String>): List<FollowUpItem> =
        items.filter { it.kind == FollowUpKind.NEW_LEAD && it.key !in notified }.distinctBy { it.key }

    /** Keys worth remembering: notified leads that the server still returns (keeps the set small). */
    fun liveLeadKeys(items: List<FollowUpItem>, notified: Set<String>): Set<String> =
        notified intersect items.filter { it.kind == FollowUpKind.NEW_LEAD }.map { it.key }.toSet()

    fun newLeadTitle(item: FollowUpItem): String = "New lead: ${item.name?.takeIf { it.isNotBlank() } ?: item.phoneE164}"

    /** "Website · company" or null. */
    fun newLeadBody(item: FollowUpItem): String? =
        listOfNotNull(item.source?.takeIf { it.isNotBlank() }, item.company?.takeIf { it.isNotBlank() }, item.lastNote?.takeIf { it.isNotBlank() })
            .joinToString(" · ").ifEmpty { null }

    /** Snoozes worth keeping: not older than the grace period and for an item that still exists. */
    fun liveSnoozes(snoozes: Map<String, Long>, keys: Set<String>, nowMs: Long): Map<String, Long> =
        snoozes.filter { (k, at) -> at > nowMs - GRACE_MS && k in keys }

    /** Stored alarms to re-arm after boot: unfired ones, including recently overdue (they fire at once). */
    fun rearmable(scheduled: List<ReminderSpec>, fired: Map<String, Long>, nowMs: Long): List<ReminderSpec> =
        scheduled.filter { pending(it.key, it.atMs, fired, nowMs, REARM_MAX_AGE_MS) }

    private val TIME = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)

    /** "3:30 pm" in IST, whatever the phone's zone or language. */
    fun timeText(atMs: Long): String = TIME.format(Instant.ofEpochMilli(atMs).atZone(DialLogic.IST)).lowercase(Locale.ENGLISH)

    fun title(spec: ReminderSpec): String = "Call ${spec.name?.takeIf { it.isNotBlank() } ?: spec.phone} at ${timeText(spec.atMs)}"

    /** "Company · last note", or null when both are empty. */
    fun body(spec: ReminderSpec): String? =
        listOfNotNull(spec.company?.takeIf { it.isNotBlank() }, spec.lastNote?.takeIf { it.isNotBlank() })
            .joinToString(" · ").ifEmpty { null }

    /** Next [hour]:00 IST strictly after [nowMs]. */
    fun nextMorningMs(nowMs: Long, hour: Int): Long {
        val now = Instant.ofEpochMilli(nowMs).atZone(DialLogic.IST)
        var at: ZonedDateTime = now.toLocalDate().atTime(hour, 0).atZone(DialLogic.IST)
        if (!at.isAfter(now)) at = at.plusDays(1)
        return at.toInstant().toEpochMilli()
    }

    /** "9:00 am" for a whole hour. */
    fun hourText(hour: Int): String = "${if (hour % 12 == 0) 12 else hour % 12}:00 ${if (hour < 12) "am" else "pm"}"

    fun istDate(nowMs: Long): String = Instant.ofEpochMilli(nowMs).atZone(DialLogic.IST).toLocalDate().toString() // LocalDate.ofInstant is API 34+

    fun summaryText(n: Int): String = if (n == 1) "You have 1 follow-up today" else "You have $n follow-ups today"
}
