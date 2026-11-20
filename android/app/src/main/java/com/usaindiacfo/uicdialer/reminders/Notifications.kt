package com.usaindiacfo.uicdialer.reminders

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.usaindiacfo.uicdialer.MainActivity
import com.usaindiacfo.uicdialer.R
import com.usaindiacfo.uicdialer.dialer.MissedCall

/** Notification channels and builders for reminders, missed calls and the caller card. */
object Notifications {
    const val CH_FOLLOWUPS = "followups"
    const val CH_MISSED = "missed"
    const val CH_CALLER = "caller"

    const val SUMMARY_ID = 9001
    const val CALLER_ID = 9002
    const val MISSED_SUMMARY_ID = 9003

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CH_FOLLOWUPS, "Follow-up reminders", NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = "When it's time to call a client back, and the morning summary" },
                NotificationChannel(CH_MISSED, "Missed calls", NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = "A missed call becomes a follow-up" },
                NotificationChannel(CH_CALLER, "Caller card", NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = "Who is calling, while the phone rings" },
            ),
        )
    }

    fun canNotify(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    @android.annotation.SuppressLint("MissingPermission") // checked by canNotify
    fun notify(context: Context, id: Int, n: android.app.Notification) {
        if (canNotify(context)) runCatching { NotificationManagerCompat.from(context).notify(id, n) }
    }

    fun cancel(context: Context, id: Int) = NotificationManagerCompat.from(context).cancel(id)

    /** PendingIntents are told apart by their data Uri (extras don't count), so each gets its own. */
    private fun uri(vararg parts: String) = Uri.parse("uic://" + parts.joinToString("/") { Uri.encode(it) })

    private const val FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    /** MainActivity has intent filters, so this one is told apart by request code instead of a data Uri. */
    fun openApp(context: Context, target: String, phone: String?, tag: String): PendingIntent =
        PendingIntent.getActivity(context, "open:$target:$tag".hashCode(), MainActivity.openIntent(context, target, phone), FLAGS)

    /** Call / WhatsApp from a notification: an Activity (Android 12+ blocks starting activities from receivers). */
    fun action(context: Context, action: String, phone: String, notifId: Int, tag: String): PendingIntent =
        PendingIntent.getActivity(
            context, 0,
            Intent(context, NotificationActionActivity::class.java)
                .setData(uri("action", action, tag))
                .putExtra(NotificationActionActivity.EXTRA_ACTION, action)
                .putExtra(NotificationActionActivity.EXTRA_PHONE, phone)
                .putExtra(NotificationActionActivity.EXTRA_NOTIF_ID, notifId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            FLAGS,
        )

    fun reminderId(key: String) = key.hashCode()

    fun showReminder(context: Context, spec: ReminderSpec) {
        val id = reminderId(spec.key)
        val n = NotificationCompat.Builder(context, CH_FOLLOWUPS)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(ReminderPlan.title(spec))
            .apply { ReminderPlan.body(spec)?.let { setContentText(it).setStyle(NotificationCompat.BigTextStyle().bigText(it)) } }
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(openApp(context, "contact", spec.phone, spec.key))
            .addAction(0, "Call now", action(context, NotificationActionActivity.ACTION_CALL, spec.phone, id, spec.key))
            .addAction(0, "Snooze 15 min", ReminderReceiver.snoozeIntent(context, spec))
            .build()
        notify(context, id, n)
    }

    fun showMissed(context: Context, m: MissedCall) {
        val id = m.clientId.hashCode()
        val who = m.callerName ?: m.number
        val n = NotificationCompat.Builder(context, CH_MISSED)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle("Missed call from $who")
            .setContentText("Added to Today as a follow-up")
            .setWhen(m.dateMs).setShowWhen(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setAutoCancel(true)
            .setContentIntent(openApp(context, "today", null, m.clientId))
            .addAction(0, "Call back", action(context, NotificationActionActivity.ACTION_CALL, m.number, id, m.clientId))
            .addAction(0, "WhatsApp", action(context, NotificationActionActivity.ACTION_WHATSAPP, m.number, id, m.clientId))
            .build()
        notify(context, id, n)
    }

    /** A lead the server assigned to this rep (NEW_LEAD task); treated like a missed call. */
    fun showNewLead(context: Context, item: com.usaindiacfo.uicdialer.data.api.FollowUpItem) {
        val id = item.key.hashCode()
        val n = NotificationCompat.Builder(context, CH_MISSED)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(ReminderPlan.newLeadTitle(item))
            .apply { ReminderPlan.newLeadBody(item)?.let { setContentText(it) } ?: setContentText("Added to Today") }
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openApp(context, "today", null, item.key))
            .addAction(0, "Call now", action(context, NotificationActionActivity.ACTION_CALL, item.phoneE164, id, item.key))
            .addAction(0, "WhatsApp", action(context, NotificationActionActivity.ACTION_WHATSAPP, item.phoneE164, id, item.key))
            .build()
        notify(context, id, n)
    }

    /** Many missed calls at once (e.g. phone was off): one notification instead of a flood. */
    fun showMissedSummary(context: Context, count: Int) {
        val n = NotificationCompat.Builder(context, CH_MISSED)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle("$count missed calls")
            .setContentText("Added to Today as follow-ups")
            .setAutoCancel(true)
            .setContentIntent(openApp(context, "today", null, "missed-summary"))
            .build()
        notify(context, MISSED_SUMMARY_ID, n)
    }

    fun showSummary(context: Context, count: Int) {
        val n = NotificationCompat.Builder(context, CH_FOLLOWUPS)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(ReminderPlan.summaryText(count))
            .setContentText("Tap to see who to call")
            .setAutoCancel(true)
            .setContentIntent(openApp(context, "today", null, "summary"))
            .build()
        notify(context, SUMMARY_ID, n)
    }
}
