package com.usaindiacfo.uicdialer.sync

import android.content.Context
import android.os.Build
import android.provider.MediaStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.usaindiacfo.uicdialer.container
import com.usaindiacfo.uicdialer.data.api.DeviceConfig
import java.util.concurrent.TimeUnit

/** All sync work is WorkManager jobs; nothing runs in between (no foreground service). */
object SyncScheduler {
    const val TRIGGER = "uic-new-recording"
    const val SCAN_NOW = "uic-scan-now"
    const val RECHECK = "uic-recheck"
    const val UPLOAD = "uic-upload-live"
    /** "-2": a new name so phones drop the old job, which waited for charging + Wi-Fi (KEEP would keep it). */
    const val BACKLOG = "uic-backlog-2"
    private const val OLD_BACKLOG = "uic-backlog"
    const val SWEEP = "uic-sweep"
    const val ACTIVITIES = "uic-activities"
    const val RESUME = "uic-resume"
    const val CALL_LOG_TRIGGER = "uic-call-log-trigger"
    const val CALL_LOG = "uic-call-log"

    /** Call once from Application.onCreate. Cheap: only registers jobs that aren't already scheduled. */
    fun init(context: Context) {
        enqueueTrigger(context, ExistingWorkPolicy.KEEP)
        enqueueCallLogTrigger(context, ExistingWorkPolicy.KEEP)
        enqueueCallLogSync(context)
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            SWEEP, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SweepWorker>(12, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiresCharging(true).build())
                .build(),
        )
        WorkManager.getInstance(context).cancelUniqueWork(OLD_BACKLOG)
        enqueueBacklog(context)
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            RESUME, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<ResumeWorker>(1, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build(),
        )
    }

    /**
     * Re-enqueues [name] with REPLACE when it is only waiting (backoff or constraints), so it runs now; leaves a
     * running job alone. When there is no job at all, enqueues normally via [enqueue].
     */
    fun restartIfWaiting(context: Context, name: String, enqueue: (ExistingWorkPolicy) -> Unit) {
        val infos = WorkManager.getInstance(context).getWorkInfosForUniqueWork(name).get()
        when {
            infos.any { it.state == WorkInfo.State.RUNNING } -> Unit
            infos.any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED } -> enqueue(ExistingWorkPolicy.REPLACE)
            else -> enqueue(ExistingWorkPolicy.KEEP)
        }
    }

    /** One-shot content-URI trigger on MediaStore audio; [NewRecordingWorker] re-arms it each run. */
    fun enqueueTrigger(context: Context, policy: ExistingWorkPolicy) {
        val constraints = Constraints.Builder()
            .addContentUriTrigger(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true)
            // Short waits so a new call uploads within seconds; the update delay still lets the recorder finish writing.
            .setTriggerContentUpdateDelay(2, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(10, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            TRIGGER, policy, OneTimeWorkRequestBuilder<NewRecordingWorker>().setConstraints(constraints).build(),
        )
    }

    /**
     * One-shot content-URI trigger on the call log; [CallLogWorker] re-arms it each run and queues
     * [enqueueCallLogSync]. Only armed with READ_CALL_LOG (app start and "Sync now" arm it once granted).
     */
    fun enqueueCallLogTrigger(context: Context, policy: ExistingWorkPolicy) {
        if (!com.usaindiacfo.uicdialer.detect.CallLogMatcher.hasPermission(context)) return
        val constraints = Constraints.Builder()
            .addContentUriTrigger(android.provider.CallLog.Calls.CONTENT_URI, true)
            .setTriggerContentUpdateDelay(2, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(10, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            CALL_LOG_TRIGGER, policy,
            OneTimeWorkRequestBuilder<CallLogWorker>()
                .setConstraints(constraints)
                .setInputData(workDataOf(CallLogWorker.KEY_TRIGGER to true))
                .build(),
        )
    }

    /**
     * Sends new call-log entries on any network. APPEND_OR_REPLACE so an entry logged while a run is going still
     * gets a run after it. [delaySec] lets the dialer write the entry first (after a call ends).
     */
    fun enqueueCallLogSync(context: Context, delaySec: Long = 0, policy: ExistingWorkPolicy = ExistingWorkPolicy.APPEND_OR_REPLACE) {
        val req = OneTimeWorkRequestBuilder<CallLogWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .apply {
                if (delaySec > 0) setInitialDelay(delaySec, TimeUnit.SECONDS)
                else if (Build.VERSION.SDK_INT >= 31) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            }
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(CALL_LOG, policy, req)
    }

    /** "Sync now" (home screen, after setup): scan recent files, upload them, and nudge the backlog. */
    fun syncNow(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            SCAN_NOW, ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<NewRecordingWorker>()
                .setInputData(workDataOf(NewRecordingWorker.KEY_ONE_SHOT to true, NewRecordingWorker.KEY_RESET_FAILED to true))
                .build(),
        )
        // Restart a backlog run that is only waiting out a retry delay, so "Sync now" really syncs now.
        Thread { runCatching { restartIfWaiting(context, BACKLOG) { enqueueBacklog(context, it) } } }.start()
        enqueueCallLogTrigger(context, ExistingWorkPolicy.KEEP)
        enqueueCallLogSync(context, policy = ExistingWorkPolicy.REPLACE)
    }

    /**
     * Called while the app is on screen: if older recordings are waiting and the backlog job is only waiting
     * (retry delay or constraints), start it now so its foreground notification is allowed. Never interrupts a
     * running job. Off the main thread; signed-out or disabled is a no-op.
     */
    fun kickBacklogFromForeground(context: Context) {
        val ctx = context.applicationContext
        Thread {
            runCatching {
                val c = ctx.container
                val go = c.tokenStore.user.value != null && kotlinx.coroutines.runBlocking {
                    c.deviceConfigRepository.current().backlogEnabled &&
                        c.db.recordings().pendingCount(com.usaindiacfo.uicdialer.data.db.RecordingSource.BACKLOG) > 0
                }
                if (go) restartIfWaiting(ctx, BACKLOG) { enqueueBacklog(ctx, it) }
            }
        }.start()
    }

    /** Re-scan once a file that was still being written has settled. */
    fun scheduleRecheck(context: Context, delaySec: Long = 45) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            RECHECK, ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<NewRecordingWorker>()
                .setInputData(workDataOf(NewRecordingWorker.KEY_ONE_SHOT to true))
                .setInitialDelay(delaySec, TimeUnit.SECONDS)
                .build(),
        )
    }

    /** Uploads LIVE files on the network the server allows. Expedited only on Android 12+ (below it would need a foreground service). */
    fun enqueueUpload(context: Context, cfg: DeviceConfig, policy: ExistingWorkPolicy = ExistingWorkPolicy.KEEP) {
        val network = if (cfg.liveNetwork.equals("wifi", ignoreCase = true)) NetworkType.UNMETERED else NetworkType.CONNECTED
        val req = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(network).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .apply { if (Build.VERSION.SDK_INT >= 31) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST) }
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(UPLOAD, policy, req)
    }

    /**
     * Sends queued dialer activities once online. APPEND_OR_REPLACE so a row queued while the worker is
     * running still gets a run after it (KEEP would drop that enqueue).
     */
    fun enqueueActivities(context: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.APPEND_OR_REPLACE) {
        val req = OneTimeWorkRequestBuilder<ActivityWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .apply { if (Build.VERSION.SDK_INT >= 31) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST) }
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(ACTIVITIES, policy, req)
    }

    /** Old recordings: on any network (mobile data too), unless the battery is low. */
    fun enqueueBacklog(context: Context, policy: ExistingWorkPolicy = ExistingWorkPolicy.KEEP) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            BACKLOG, policy,
            OneTimeWorkRequestBuilder<BacklogWorker>()
                .setConstraints(constraints)
                // Linear 1 min: Android stops each run after ~10 min; a doubling backoff left old recordings waiting hours.
                .setBackoffCriteria(BackoffPolicy.LINEAR, 1, TimeUnit.MINUTES)
                .build(),
        )
    }

    /** Optional on sign-out; workers no-op while signed out anyway and [init] re-arms at next start. */
    fun cancelSyncWork(context: Context) {
        val wm = WorkManager.getInstance(context)
        listOf(SCAN_NOW, RECHECK, UPLOAD, BACKLOG, ACTIVITIES, CALL_LOG).forEach(wm::cancelUniqueWork)
    }
}
