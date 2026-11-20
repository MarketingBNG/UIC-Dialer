package com.usaindiacfo.uicdialer.reminders

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.usaindiacfo.uicdialer.data.api.FollowUpsToday
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/** SharedPreferences "reminders": scheduled alarms, local snoozes and the morning-summary setting. */
class ReminderStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("reminders", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
    private val specs = ListSerializer(ReminderSpec.serializer())
    private val snoozeMap = MapSerializer(String.serializer(), Long.serializer())

    var scheduled: List<ReminderSpec>
        get() = prefs.getString(KEY_SCHEDULED, null)?.let { runCatching { json.decodeFromString(specs, it) }.getOrNull() } ?: emptyList()
        set(v) = prefs.edit().putString(KEY_SCHEDULED, json.encodeToString(specs, v)).apply()

    var snoozes: Map<String, Long>
        get() = prefs.getString(KEY_SNOOZES, null)?.let { runCatching { json.decodeFromString(snoozeMap, it) }.getOrNull() } ?: emptyMap()
        set(v) = prefs.edit().putString(KEY_SNOOZES, json.encodeToString(snoozeMap, v)).apply()

    /** Alarms that already fired: key to the latest fired alarm time, so a re-sync doesn't arm them again. */
    var fired: Map<String, Long>
        get() = prefs.getString(KEY_FIRED, null)?.let { runCatching { json.decodeFromString(snoozeMap, it) }.getOrNull() } ?: emptyMap()
        set(v) = prefs.edit().putString(KEY_FIRED, json.encodeToString(snoozeMap, v)).apply()

    var summaryEnabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, true)
        set(v) = prefs.edit().putBoolean(KEY_ENABLED, v).apply()

    /** Morning summary hour, IST. */
    var summaryHour: Int
        get() = prefs.getInt(KEY_HOUR, 9).coerceIn(0, 23)
        set(v) = prefs.edit().putInt(KEY_HOUR, v.coerceIn(0, 23)).apply()

    var lastSummaryDate: String?
        get() = prefs.getString(KEY_LAST_SUMMARY, null)
        set(v) = prefs.edit().putString(KEY_LAST_SUMMARY, v).apply()

    /** Newest missed call already turned into a task (call-log time); 0 = never scanned. */
    var lastMissedScanMs: Long
        get() = prefs.getLong(KEY_MISSED_CURSOR, 0)
        set(v) = prefs.edit().putLong(KEY_MISSED_CURSOR, v).apply()

    /** NEW_LEAD keys already notified (each lead notifies once). */
    var notifiedLeads: Set<String>
        get() = prefs.getStringSet(KEY_LEADS, null)?.toSet() ?: emptySet()
        set(v) = prefs.edit().putStringSet(KEY_LEADS, v).apply()

    /** Sign-out: forget everything tied to the rep, keep the morning-summary setting. */
    fun clearSession() =
        prefs.edit().remove(KEY_SCHEDULED).remove(KEY_SNOOZES).remove(KEY_FIRED).remove(KEY_LAST_SUMMARY).remove(KEY_MISSED_CURSOR).remove(KEY_LEADS).apply()

    private companion object {
        const val KEY_SCHEDULED = "scheduled"
        const val KEY_SNOOZES = "snoozes"
        const val KEY_FIRED = "fired"
        const val KEY_ENABLED = "enabled"
        const val KEY_HOUR = "hour"
        const val KEY_LAST_SUMMARY = "lastSummaryDate"
        const val KEY_LEADS = "notified_leads"
        const val KEY_MISSED_CURSOR = "lastMissedScanMs"
    }
}

/** One AlarmManager alarm per follow-up; exact when allowed, else within a 10-minute window. */
object ReminderScheduler {
    private const val WINDOW_MS = 10 * 60_000L

    fun canExact(context: Context): Boolean =
        Build.VERSION.SDK_INT < 31 || context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()

    /** Replaces all alarms with the plan for [today]. */
    @Synchronized
    fun reschedule(context: Context, today: FollowUpsToday, nowMs: Long = System.currentTimeMillis()) {
        val store = ReminderStore(context)
        val items = today.items + today.upcoming
        val snoozes = ReminderPlan.liveSnoozes(store.snoozes, items.map { it.key }.toSet(), nowMs)
        val keys = items.map { it.key }.toSet()
        val fired = store.fired.filter { (k, at) -> k in keys && at > nowMs - ReminderPlan.REARM_MAX_AGE_MS }
        apply(context, store, ReminderPlan.plan(items, snoozes, nowMs, fired))
        store.snoozes = snoozes
        store.fired = fired
    }

    /** Re-arms what is stored (boot, exact-alarm permission change) without the network. */
    @Synchronized
    fun rearm(context: Context, nowMs: Long = System.currentTimeMillis()) {
        val store = ReminderStore(context)
        apply(context, store, ReminderPlan.rearmable(store.scheduled, store.fired, nowMs))
    }

    /** Local snooze: alarm again at [atMs]; reschedules keep it while the follow-up is still open. */
    @Synchronized
    fun snooze(context: Context, spec: ReminderSpec, atMs: Long) {
        val store = ReminderStore(context)
        store.snoozes = store.snoozes + (spec.key to atMs)
        apply(context, store, store.scheduled.filter { it.key != spec.key } + spec.copy(atMs = atMs))
    }

    @Synchronized
    fun cancelAll(context: Context) {
        val store = ReminderStore(context)
        store.scheduled.forEach { cancel(context, it.key) }
        store.clearSession()
    }

    /** The alarm for [spec] fired: remember it so later re-syncs within the grace period don't re-arm it. */
    @Synchronized
    fun markFired(context: Context, spec: ReminderSpec) {
        val store = ReminderStore(context)
        store.fired = store.fired + (spec.key to maxOf(spec.atMs, store.fired[spec.key] ?: Long.MIN_VALUE))
        store.snoozes = store.snoozes - spec.key
    }

    /** Android caps alarms per app (500); the soonest are the ones that matter. */
    private const val MAX_ALARMS = 100

    private fun apply(context: Context, store: ReminderStore, all: List<ReminderSpec>) {
        val plan = all.sortedBy { it.atMs }.take(MAX_ALARMS)
        val keys = plan.map { it.key }.toSet()
        store.scheduled.filter { it.key !in keys }.forEach { cancel(context, it.key) }
        plan.forEach { set(context, it) }
        store.scheduled = plan
    }

    private fun set(context: Context, spec: ReminderSpec) {
        val am = context.getSystemService(AlarmManager::class.java)
        val pi = fireIntent(context, spec)
        try {
            if (canExact(context)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, spec.atMs, pi)
            else am.setWindow(AlarmManager.RTC_WAKEUP, spec.atMs, WINDOW_MS, pi)
        } catch (_: SecurityException) { // exact-alarm access revoked between the check and the call
            runCatching { am.setWindow(AlarmManager.RTC_WAKEUP, spec.atMs, WINDOW_MS, pi) }
        } catch (_: IllegalStateException) { // too many alarms
        }
    }

    private fun cancel(context: Context, key: String) {
        context.getSystemService(AlarmManager::class.java).cancel(fireIntent(context, ReminderSpec(key, 0, "")))
    }

    private fun fireIntent(context: Context, spec: ReminderSpec): PendingIntent =
        PendingIntent.getBroadcast(
            context, spec.key.hashCode(),
            Intent(context, ReminderReceiver::class.java)
                .setAction(ReminderReceiver.ACTION_FIRE)
                .setData(Uri.parse("uic://reminder/" + Uri.encode(spec.key)))
                .putExtra(ReminderReceiver.EXTRA_SPEC, Json.encodeToString(ReminderSpec.serializer(), spec)),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}
