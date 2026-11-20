package com.usaindiacfo.uicdialer.dialer

import android.provider.CallLog
import com.usaindiacfo.uicdialer.detect.CallLogEntry

/** A missed call that should become a follow-up task. */
data class MissedCall(val clientId: String, val number: String, val dateMs: Long, val callerName: String?)

/** Pure missed-call rules, unit-tested in MissedCallLogicTest. */
object MissedCallLogic {
    const val LOOKBACK_MS = 48 * 3600_000L

    /** Stable per call-log entry, so re-scans and retries never make a second task. */
    fun clientId(dateMs: Long, last10: String) = "missed:$dateMs:$last10"

    /**
     * Missed or rejected calls after [sinceMs] (up to [nowMs]) that nobody has followed up yet: no later
     * outgoing call, and no later answered incoming call, to the same number. Private numbers are skipped.
     */
    fun newMissed(entries: List<CallLogEntry>, sinceMs: Long, nowMs: Long): List<MissedCall> {
        val handledAfter = HashMap<String, Long>() // last10 -> latest follow-up call time
        for (e in entries) {
            val n = DialLogic.last10(e.number) ?: continue
            val followUp = e.type == CallLog.Calls.OUTGOING_TYPE ||
                (e.type == CallLog.Calls.INCOMING_TYPE && e.durationS > 0)
            if (followUp) handledAfter.merge(n, e.dateMs, ::maxOf)
        }
        return entries.asSequence()
            .filter { it.type == CallLog.Calls.MISSED_TYPE || it.type == CallLog.Calls.REJECTED_TYPE }
            .filter { it.dateMs > sinceMs && it.dateMs <= nowMs }
            .mapNotNull { e ->
                val n = DialLogic.last10(e.number) ?: return@mapNotNull null
                if ((handledAfter[n] ?: Long.MIN_VALUE) > e.dateMs) return@mapNotNull null
                MissedCall(clientId(e.dateMs, n), e.number!!.trim(), e.dateMs, e.cachedName?.takeIf { it.isNotBlank() })
            }
            .distinctBy { it.clientId }
            .sortedBy { it.dateMs }
            .toList()
    }

    /** New scan cursor: the newest missed/rejected entry seen (never moves back). */
    fun nextCursor(entries: List<CallLogEntry>, sinceMs: Long, nowMs: Long): Long =
        entries.asSequence()
            .filter { it.type == CallLog.Calls.MISSED_TYPE || it.type == CallLog.Calls.REJECTED_TYPE }
            .map { it.dateMs }.filter { it <= nowMs }
            .maxOrNull()?.coerceAtLeast(sinceMs) ?: sinceMs
}
