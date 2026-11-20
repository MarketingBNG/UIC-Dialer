package com.usaindiacfo.uicdialer.dialer

import com.usaindiacfo.uicdialer.data.api.CallOutcome
import com.usaindiacfo.uicdialer.data.api.OutcomeDto
import com.usaindiacfo.uicdialer.data.api.OutcomeRule

/** One-tap follow-up times offered after a dated outcome ("Pick…" opens the platform picker instead). */
enum class QuickPick(val label: String) { IN_1_HOUR("In 1 hour"), TOMORROW_11("Tomorrow 11 am"), NEXT_WEEK("Next week") }

/** What the outcome sheet asks for once an outcome is chosen. */
enum class OutcomePrompt { NONE, DATE, DATE_TIME, RETRY, SAVE_NOW, CONFIRM_REMOVE }

/** Pure rules for custom outcomes (unit-tested in OutcomeRuleTest). */
object OutcomeLogic {
    /** The four seeded defaults (fixed server ids), used offline before the list was ever downloaded. */
    val DEFAULTS = listOf(
        OutcomeDto("00000000-0000-7000-8000-000000000001", "interested", "Interested", "#16A34A", 10, true, CallOutcome.INTERESTED, "NONE"),
        OutcomeDto("00000000-0000-7000-8000-000000000002", "call_back", "Call back", "#D97706", 20, true, CallOutcome.CALL_BACK, "ASK_CALLBACK"),
        OutcomeDto("00000000-0000-7000-8000-000000000003", "not_interested", "Not interested", "#DC2626", 30, true, CallOutcome.NOT_INTERESTED, "NONE"),
        OutcomeDto("00000000-0000-7000-8000-000000000004", "no_answer", "No answer", "#64748B", 40, true, CallOutcome.NO_ANSWER, "NONE"),
    )

    fun prompt(rule: OutcomeRule): OutcomePrompt = when (rule) {
        OutcomeRule.NONE -> OutcomePrompt.NONE
        OutcomeRule.ASK_FOLLOW_UP -> OutcomePrompt.DATE
        OutcomeRule.ASK_MEETING, OutcomeRule.ASK_CALLBACK -> OutcomePrompt.DATE_TIME
        OutcomeRule.RETRY -> OutcomePrompt.RETRY
        OutcomeRule.CLOSE_LEAD -> OutcomePrompt.SAVE_NOW
        OutcomeRule.REMOVE_FROM_LISTS -> OutcomePrompt.CONFIRM_REMOVE
    }

    /** True when the server would answer 400 OUTCOME_NEEDS_DATE without a follow-up time. */
    fun needsDate(def: OutcomeDto): Boolean = when (def.ruleEnum) {
        OutcomeRule.ASK_FOLLOW_UP, OutcomeRule.ASK_MEETING, OutcomeRule.ASK_CALLBACK -> true
        OutcomeRule.NONE -> def.baseOutcome == CallOutcome.CALL_BACK
        else -> false
    }

    /** True when tapping [def] can save at once (no date to pick). REMOVE_FROM_LISTS still confirms first. */
    fun savesOnTap(def: OutcomeDto): Boolean = !needsDate(def)

    /** Quick picks for [def]: none when it needs no date; date-only rules (follow-up) skip "In 1 hour". */
    fun quickPicks(def: OutcomeDto): List<QuickPick> = when {
        !needsDate(def) -> emptyList()
        prompt(def.ruleEnum) == OutcomePrompt.DATE -> listOf(QuickPick.TOMORROW_11, QuickPick.NEXT_WEEK)
        else -> QuickPick.entries
    }

    /**
     * Epoch ms for [pick] from [nowMs] in [zone]: now + 1 h (rounded up to the next 5 minutes);
     * tomorrow 11:00; next week = 7 days from today at 11:00.
     */
    fun quickPickMs(pick: QuickPick, nowMs: Long, zone: java.time.ZoneId): Long {
        val today = java.time.Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val at11 = java.time.LocalTime.of(11, 0)
        return when (pick) {
            QuickPick.IN_1_HOUR -> {
                val step = 5 * 60_000L
                val t = nowMs + 3600_000L
                (t + step - 1) / step * step
            }
            QuickPick.TOMORROW_11 -> today.plusDays(1).atTime(at11).atZone(zone).toInstant().toEpochMilli()
            QuickPick.NEXT_WEEK -> today.plusDays(7).atTime(at11).atZone(zone).toInstant().toEpochMilli()
        }
    }

    /** RETRY: the phone sets now + N h (the server recomputes it from the call time). */
    fun retryFollowUpMs(nowMs: Long, retryHours: Int?): Long? = retryHours?.takeIf { it > 0 }?.let { nowMs + it * 3600_000L }

    /** The follow-up to send for [def]: RETRY computes it, date rules use the picked time, others send none. */
    fun followUpFor(def: OutcomeDto, pickedMs: Long?, nowMs: Long): Long? = when {
        def.ruleEnum == OutcomeRule.RETRY -> retryFollowUpMs(nowMs, def.retryHours)
        needsDate(def) -> pickedMs
        else -> null
    }

    /** Null when the outcome can be saved, else the message to show. Never queue a row the server rejects for good. */
    fun validate(def: OutcomeDto?, pickedMs: Long?, nowMs: Long): String? = when {
        def == null -> "Choose an outcome"
        needsDate(def) && pickedMs == null -> if (prompt(def.ruleEnum) == OutcomePrompt.DATE) "Pick a follow-up date" else "Pick a date and time"
        needsDate(def) && pickedMs != null && pickedMs < nowMs - 60_000 -> "That time is in the past"
        else -> null
    }

    /** Active outcomes in sortOrder, then label; falls back to the defaults when the list is empty. */
    fun visible(defs: List<OutcomeDto>): List<OutcomeDto> =
        defs.filter { it.active }.sortedWith(compareBy({ it.sortOrder }, { it.label })).ifEmpty { DEFAULTS }

    /** Preselected outcome: No answer for a call that never connected (same rule as before custom outcomes). */
    fun defaultFor(durationS: Int?, defs: List<OutcomeDto>): OutcomeDto? {
        val base = DialLogic.defaultOutcome(durationS) ?: return null
        return defs.firstOrNull { it.key == "no_answer" } ?: defs.firstOrNull { it.baseOutcome == base && it.ruleEnum == OutcomeRule.NONE }
    }

    /** "#16A34A" to ARGB; null when malformed. */
    fun parseColor(hex: String?): Long? {
        val h = hex?.removePrefix("#") ?: return null
        if (h.length != 6) return null
        return h.toLongOrNull(16)?.let { 0xFF000000L or it }
    }
}
