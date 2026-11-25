package com.usaindiacfo.uicdialer.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import com.usaindiacfo.uicdialer.R
import com.usaindiacfo.uicdialer.container
import com.usaindiacfo.uicdialer.detect.CallLogEntry
import com.usaindiacfo.uicdialer.detect.CallLogMatcher
import com.usaindiacfo.uicdialer.reminders.Notifications

/**
 * Warns the rep when the phone's call recording looks switched off: the last [CALLS] connected calls
 * (30 s+, within 2 days) produced no recording file at all. Faster than the dashboard's 7-day check.
 */
object RecordingCheck {
    const val CALLS = 3
    private const val WINDOW_MS = 2 * 24 * 3600_000L
    /** Give the recorder time to save the file after a call ends. */
    private const val GRACE_MS = 10 * 60_000L
    private const val NOTIFY_EVERY_MS = 24 * 3600_000L
    private const val CHANNEL = "recording_off"
    private const val NOTIF_ID = 9102
    private const val PREFS = "recording_check"

    /** Start time of the oldest of the last [CALLS] qualifying calls, or null if there aren't enough yet. */
    fun windowStart(entries: List<CallLogEntry>, now: Long): Long? {
        val calls = entries
            .filter { it.durationS >= DeviceHealth.MIN_CALL_S && it.dateMs >= now - WINDOW_MS }
            .filter { it.dateMs + it.durationS * 1000L + GRACE_MS <= now }
            .sortedByDescending { it.dateMs }
            .take(CALLS)
        return if (calls.size < CALLS) null else calls.last().dateMs
    }

    /** True when recording looks off. [found] counts recording files newer than a time. */
    fun looksOff(entries: List<CallLogEntry>, now: Long, found: (Long) -> Int): Boolean {
        val since = windowStart(entries, now) ?: return false
        return found(since) == 0
    }

    /** Last result, for the Today banner. */
    fun isOff(context: Context): Boolean = prefs(context).getBoolean("off", false)

    /** Re-checks, stores the result and notifies at most once a day while it stays off. */
    suspend fun run(context: Context): Boolean {
        if (!CallLogMatcher.hasPermission(context)) return false
        val now = System.currentTimeMillis()
        val entries = runCatching { CallLogMatcher.query(context, now - WINDOW_MS, now) }.getOrElse { return isOff(context) }
        val dao = context.container.db.recordings()
        val since = windowStart(entries, now)
        val off = since != null && dao.foundSince(since) == 0
        val p = prefs(context)
        p.edit().putBoolean("off", off).apply()
        if (!off) {
            Notifications.cancel(context, NOTIF_ID)
        } else if (now - p.getLong("notifiedAt", 0) > NOTIFY_EVERY_MS) {
            p.edit().putLong("notifiedAt", now).apply()
            notify(context)
        }
        return off
    }

    private fun notify(context: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Call recording off", NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = "When your recent calls weren't recorded" },
            )
        }
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle("Call recording is off")
            .setContentText(TEXT)
            .setStyle(NotificationCompat.BigTextStyle().bigText(TEXT))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(Notifications.openApp(context, "today", null, "recording-off"))
            .build()
        Notifications.notify(context, NOTIF_ID, n)
    }

    const val TEXT = "Turn on Auto record calls in Phone settings."

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
