package com.usaindiacfo.uicdialer.dialer

import android.content.Context
import android.provider.CallLog
import androidx.core.app.NotificationCompat
import com.usaindiacfo.uicdialer.R
import com.usaindiacfo.uicdialer.detect.CallLogEntry
import com.usaindiacfo.uicdialer.detect.CallLogMatcher
import com.usaindiacfo.uicdialer.reminders.Notifications
import java.util.UUID

/**
 * Calls made in the phone's own dialer, and incoming calls, get the same "how did it go?" sheet as app dials:
 * after a connected call ends, it becomes the pending dial and a notification opens the sheet.
 */
object ExternalCallPrompt {
    private const val RECENT_MS = 15 * 60_000L
    private const val NOTIF_ID = 9103

    /** The newest connected call (incoming or outgoing) in the last 15 minutes that wasn't dialled from the app. */
    fun pick(entries: List<CallLogEntry>, appDials: List<Pair<String, Long>>, lastAskedMs: Long, now: Long): CallLogEntry? =
        entries.asSequence()
            .filter { it.type == CallLog.Calls.INCOMING_TYPE || it.type == CallLog.Calls.OUTGOING_TYPE }
            .filter { it.durationS > 0 && it.dateMs > lastAskedMs && it.dateMs >= now - RECENT_MS }
            .filter { !it.number.isNullOrBlank() && DialLogic.last10(it.number) != null }
            .filter { !(it.type == CallLog.Calls.OUTGOING_TYPE && DialLogic.isAppDial(appDials, it.number, it.dateMs)) }
            .maxByOrNull { it.dateMs }

    fun run(context: Context) {
        if (!CallLogMatcher.hasPermission(context)) return
        val prefs = DialPrefs(context)
        if (prefs.pending != null) return // an app dial is still waiting to be asked about
        val sp = context.getSharedPreferences("external_prompt", Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val entries = runCatching { CallLogMatcher.query(context, now - RECENT_MS, now) }.getOrNull() ?: return
        val call = pick(entries, prefs.recentAppDials, sp.getLong("last", 0), now) ?: return
        sp.edit().putLong("last", call.dateMs).apply()
        val number = call.number!!
        prefs.pending = PendingDial(DialLogic.cleanNumber(number), call.dateMs, UUID.randomUUID().toString())
        val who = call.cachedName?.takeIf { it.isNotBlank() } ?: number
        val n = NotificationCompat.Builder(context, Notifications.CH_FOLLOWUPS)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle("How did the call with $who go?")
            .setContentText("Tap to add the outcome and a note")
            .setAutoCancel(true)
            .setContentIntent(Notifications.openApp(context, "today", null, "outcome-${call.dateMs}"))
            .build()
        Notifications.notify(context, NOTIF_ID, n)
    }
}
