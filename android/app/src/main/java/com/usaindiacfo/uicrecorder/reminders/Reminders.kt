package com.usaindiacfo.uicrecorder.reminders

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.container
import com.usaindiacfo.uicrecorder.data.api.ApiException
import com.usaindiacfo.uicrecorder.data.api.FollowUpCounts
import com.usaindiacfo.uicrecorder.data.api.FollowUpItem
import com.usaindiacfo.uicrecorder.data.api.FollowUpKind
import com.usaindiacfo.uicrecorder.data.api.FollowUpsToday
import com.usaindiacfo.uicrecorder.data.api.MissedCallItem
import com.usaindiacfo.uicrecorder.data.db.PendingMissedEntity
import com.usaindiacfo.uicrecorder.detect.CallLogMatcher
import com.usaindiacfo.uicrecorder.dialer.DialLogic
import com.usaindiacfo.uicrecorder.dialer.MissedCallLogic
import com.usaindiacfo.uicrecorder.sync.AndroidContactCheck
import com.usaindiacfo.uicrecorder.sync.PrivacyDecision
import com.usaindiacfo.uicrecorder.sync.PrivacyFilter
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Entry points for follow-up reminders, missed-call tasks and the morning summary. */
object Reminders {
    const val SYNC = "uic-reminder-sync"
    const val MORNING = "uic-morning-summary"

    /** More missed calls than this in one scan get one summary notification instead of one each. */
    private const val MAX_MISSED_NOTIFICATIONS = 3

    /** App start: channels, a refresh, and the morning summary. Cheap; safe to call often. */
    fun init(context: Context) {
        Notifications.createChannels(context)
        enqueueSync(context, ExistingWorkPolicy.KEEP)
        scheduleMorning(context, ExistingWorkPolicy.KEEP)
    }

    /** Missed-call scan + today's follow-ups + reschedule. [delaySec] lets the call log settle after a call. */
    fun enqueueSync(context: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.REPLACE, delaySec: Long = 0) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            SYNC, policy,
            OneTimeWorkRequestBuilder<ReminderSyncWorker>().setInitialDelay(delaySec, TimeUnit.SECONDS).build(),
        )
    }

    /** Next morning summary at the configured hour (IST). REPLACE after a settings change. */
    fun scheduleMorning(context: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.KEEP) {
        val store = ReminderStore(context)
        val wm = WorkManager.getInstance(context)
        if (!store.summaryEnabled) { wm.cancelUniqueWork(MORNING); return }
        val delay = ReminderPlan.nextMorningMs(System.currentTimeMillis(), store.summaryHour) - System.currentTimeMillis()
        wm.enqueueUniqueWork(
            MORNING, policy,
            OneTimeWorkRequestBuilder<MorningSummaryWorker>().setInitialDelay(delay.coerceAtLeast(0), TimeUnit.MILLISECONDS).build(),
        )
    }

    /** Signed out: no reminders, no queued missed calls for the next rep. */
    suspend fun clearSession(context: Context) {
        ReminderScheduler.cancelAll(context)
        runCatching { context.container.db.pendingMissed().deleteAll() }
        WorkManager.getInstance(context).cancelUniqueWork(SYNC)
    }

    /**
     * GET /v1/followups/today, cached for offline use. On a server without it (404) falls back to the old
     * contact follow-ups list. Throws IOException when offline.
     */
    suspend fun fetchToday(c: AppContainer): FollowUpsToday {
        val today = try {
            c.apiClient.followupsToday()
        } catch (e: ApiException) {
            if (e.code != 404 || !e.fromServer) throw e
            val list = c.apiClient.followups().items
            c.contactCache.followUps = list
            val items = list.mapNotNull { ct ->
                val due = ct.nextFollowUpAt ?: return@mapNotNull null
                FollowUpItem(
                    key = "contact:${ct.id}", kind = FollowUpKind.FOLLOW_UP, contactId = ct.id, phoneE164 = ct.phoneE164,
                    name = ct.name, company = ct.company, status = ct.status, dueAt = due, overdue = DialLogic.isOverdue(due),
                )
            }
            FollowUpsToday(items, emptyList(), FollowUpCounts(items.count { it.overdue }, items.count { !it.overdue }))
        }
        c.contactCache.today = today
        return today
    }

    /** Fetches today and re-arms alarms; false when offline. */
    suspend fun refresh(context: Context): Boolean {
        val c = context.container
        if (c.tokenStore.user.value == null) return true
        return try {
            val today = fetchToday(c)
            ReminderScheduler.reschedule(context, today)
            notifyNewLeads(context, today.items)
            true
        } catch (_: IOException) {
            false
        } catch (_: kotlinx.serialization.SerializationException) { // e.g. a proxy page with status 200
            false
        }
    }

    /** "New lead: <name>" once per NEW_LEAD task (the server assigned the lead to this rep). */
    fun notifyNewLeads(context: Context, items: List<FollowUpItem>) {
        val store = ReminderStore(context)
        val notified = store.notifiedLeads
        val fresh = ReminderPlan.newLeads(items, notified)
        fresh.forEach { Notifications.showNewLead(context, it) }
        store.notifiedLeads = ReminderPlan.liveLeadKeys(items, notified) + fresh.map { it.key }
    }

    /**
     * Finds new missed calls in the call log, queues and notifies them, then sends the queue. The first scan
     * after sign-in queues the last 48 h without notifying. Returns false when sending must be retried.
     */
    suspend fun scanMissed(context: Context): Boolean {
        val c = context.container
        if (c.tokenStore.user.value == null || !CallLogMatcher.hasPermission(context)) return true
        val store = ReminderStore(context)
        val now = System.currentTimeMillis()
        val since = store.lastMissedScanMs
        val from = maxOf(since, now - MissedCallLogic.LOOKBACK_MS)
        val entries = CallLogMatcher.query(context, from, now)
        val found = MissedCallLogic.newMissed(entries, from, now)
        val cfg = c.deviceConfigRepository.current()
        val contacts = AndroidContactCheck(context, c.db.clientHashes())
        val dao = c.db.pendingMissed()
        val fresh = found.filter { m ->
            // Same privacy rules as recordings: excluded numbers and personal contacts (business-only) never leave the phone.
            val keep = PrivacyFilter.decide(m.number, cfg, contacts) == PrivacyDecision.Upload
            keep && dao.insert(PendingMissedEntity(m.clientId, m.number, m.dateMs, m.callerName)) != -1L
        }
        store.lastMissedScanMs = MissedCallLogic.nextCursor(entries, from, now)
        if (since > 0) {
            if (fresh.size > MAX_MISSED_NOTIFICATIONS) Notifications.showMissedSummary(context, fresh.size)
            else fresh.forEach { Notifications.showMissed(context, it) }
        }
        return sendMissed(c)
    }

    /** POSTs queued missed calls in batches of 50. Per-item ok/4xx rows are removed; others stay for retry. */
    private suspend fun sendMissed(c: AppContainer): Boolean {
        val dao = c.db.pendingMissed()
        while (true) {
            val batch = dao.nextBatch()
            if (batch.isEmpty()) return true
            val results = try {
                c.apiClient.postMissed(
                    batch.map { MissedCallItem(it.clientId, it.phone, Instant.ofEpochMilli(it.occurredAtMs).toString(), it.callerName?.take(200)) },
                ).results
            } catch (_: IOException) {
                return false // includes a 404 from a server without this endpoint: keep the rows
            }
            val byId = results.associateBy { it.clientId }
            val done = batch.filter { row ->
                val r = byId[row.clientId] ?: return@filter false
                r.ok || (r.status ?: 0) in 400..499
            }.map { it.clientId }
            if (done.isEmpty()) return false
            dao.delete(done)
        }
    }
}

/** Missed-call scan, then today's follow-ups and alarms. Enqueued at start, boot, after calls and hourly. */
class ReminderSyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        if (ctx.container.tokenStore.user.value == null) return Result.success()
        val sent = runCatching { Reminders.scanMissed(ctx) }.getOrDefault(false)
        val fetched = Reminders.refresh(ctx)
        return if (sent && fetched) Result.success() else if (runAttemptCount < 3) Result.retry() else Result.success()
    }
}

/** "You have N follow-ups today", at most once per IST day, then re-arms itself for the next morning. */
class MorningSummaryWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val c = ctx.container
        val store = ReminderStore(ctx)
        val date = ReminderPlan.istDate(System.currentTimeMillis())
        try {
            if (store.summaryEnabled && c.tokenStore.user.value != null && store.lastSummaryDate != date) {
                val today = runCatching { Reminders.fetchToday(c).also { ReminderScheduler.reschedule(ctx, it) } }.getOrNull() ?: c.contactCache.today
                val n = today?.counts?.let { it.overdue + it.today } ?: 0
                if (n > 0) {
                    Notifications.showSummary(ctx, n)
                    store.lastSummaryDate = date
                }
            }
        } finally {
            // KEEP would be dropped while this run is active; APPEND_OR_REPLACE queues the next one after it.
            Reminders.scheduleMorning(ctx, ExistingWorkPolicy.APPEND_OR_REPLACE)
        }
        return Result.success()
    }
}
