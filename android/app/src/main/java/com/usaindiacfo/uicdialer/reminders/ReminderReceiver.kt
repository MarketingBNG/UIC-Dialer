package com.usaindiacfo.uicdialer.reminders

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.usaindiacfo.uicdialer.container
import kotlinx.serialization.json.Json

/** Alarm fired (show the reminder) or Snooze tapped (alarm again in 15 minutes, on this phone only). */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val spec = intent.getStringExtra(EXTRA_SPEC)
            ?.let { runCatching { Json.decodeFromString(ReminderSpec.serializer(), it) }.getOrNull() } ?: return
        if (context.container.tokenStore.user.value == null) return
        when (intent.action) {
            ACTION_FIRE -> {
                ReminderScheduler.markFired(context, spec)
                Notifications.showReminder(context, spec)
            }
            ACTION_SNOOZE -> {
                Notifications.cancel(context, Notifications.reminderId(spec.key))
                ReminderScheduler.snooze(context, spec, System.currentTimeMillis() + ReminderPlan.SNOOZE_MS)
            }
        }
    }

    companion object {
        const val ACTION_FIRE = "com.usaindiacfo.uicdialer.REMINDER_FIRE"
        const val ACTION_SNOOZE = "com.usaindiacfo.uicdialer.REMINDER_SNOOZE"
        const val EXTRA_SPEC = "spec"

        fun snoozeIntent(context: Context, spec: ReminderSpec): PendingIntent =
            PendingIntent.getBroadcast(
                context, 0,
                Intent(context, ReminderReceiver::class.java)
                    .setAction(ACTION_SNOOZE)
                    .setData(Uri.parse("uic://snooze/" + Uri.encode(spec.key)))
                    .putExtra(EXTRA_SPEC, Json.encodeToString(ReminderSpec.serializer(), spec)),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
    }
}

/** Boot, app update and exact-alarm permission changes: re-arm stored alarms, then refresh from the server. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> {
                if (context.container.tokenStore.user.value == null) return
                ReminderScheduler.rearm(context)
                Reminders.enqueueSync(context)
                Reminders.scheduleMorning(context)
                com.usaindiacfo.uicdialer.dialer.RemoteDialService.startIfEnabled(context)
            }
        }
    }
}
