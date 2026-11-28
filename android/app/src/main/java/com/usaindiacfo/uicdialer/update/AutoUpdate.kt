package com.usaindiacfo.uicdialer.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.usaindiacfo.uicdialer.R
import com.usaindiacfo.uicdialer.container
import com.usaindiacfo.uicdialer.reminders.Notifications
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Background auto-update. Every few hours: check -> download -> install.
 * Android 12+: installs silently (after the first update, once this app is the installer of record).
 * Android 8-11, or when Android still wants a tap: a notification "Update ready - tap to install".
 */
object AutoUpdate {
    private const val WORK = "uic-auto-update"
    private const val CHANNEL = "app_update"
    private const val NOTIF_ID = 9104
    const val ACTION_STATUS = "com.usaindiacfo.uicdialer.UPDATE_STATUS"

    fun schedule(context: Context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WORK, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<AutoUpdateWorker>(4, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).setRequiresBatteryNotLow(true).build())
                .build(),
        )
    }

    /** "Check now" in Settings: one run of the worker, any network. */
    fun checkNow(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            "$WORK-now", ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<AutoUpdateWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build(),
        )
    }

    /** Silent install through a PackageInstaller session; the result arrives at [UpdateStatusReceiver]. */
    fun installSession(context: Context, apk: File) {
        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        if (Build.VERSION.SDK_INT >= 34) params.setPackageSource(PackageInstaller.PACKAGE_SOURCE_OTHER)
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            s.openWrite("app.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; s.fsync(out) }
            val status = PendingIntent.getBroadcast(
                context, id, Intent(context, UpdateStatusReceiver::class.java).setAction(ACTION_STATUS),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            s.commit(status.intentSender)
        }
    }

    /** "Update ready - tap to install", opening [tap] (the system installer). */
    fun notifyReady(context: Context, tap: Intent) {
        if (Build.VERSION.SDK_INT >= 26) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = "When a new version is ready to install" },
            )
        }
        val pending = PendingIntent.getActivity(
            context, NOTIF_ID, tap.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle("Update ready")
            .setContentText("Tap to install the new version of UIC Dialer.")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        Notifications.notify(context, NOTIF_ID, n)
    }

    fun viewIntent(context: Context, apk: File): Intent =
        Intent(Intent.ACTION_VIEW)
            .setDataAndType(FileProvider.getUriForFile(context, AppUpdater.authority(context), apk), "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
}

class AutoUpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        UpdateStatus.noteCurrentVersion(ctx)
        val updater = AppUpdater(ctx, ctx.container.apiClient)
        val latest = runCatching { updater.check() }.getOrElse {
            UpdateStatus.record(ctx, "Check failed: ${it.message ?: "no connection"}")
            return Result.success()
        }
        if (latest == null) {
            UpdateStatus.record(ctx, "Up to date")
            return Result.success()
        }
        val v = "v${latest.versionName ?: latest.versionCode}"
        UpdateStatus.record(ctx, "Downloading $v")
        val apk = runCatching { updater.download(latest) }.getOrElse {
            UpdateStatus.record(ctx, "Download of $v failed: ${it.message ?: "error"}")
            return Result.retry()
        }
        val waiting = "$v ready, waiting for you to tap Install"
        when {
            !updater.canInstall() -> {
                UpdateStatus.record(ctx, "$v ready, allow installs from this app")
                AutoUpdate.notifyReady(ctx, ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return Result.success())
            }
            Build.VERSION.SDK_INT >= 31 -> runCatching { AutoUpdate.installSession(ctx, apk) }
                .onSuccess { UpdateStatus.record(ctx, "Installing $v") }
                .onFailure { UpdateStatus.record(ctx, waiting); AutoUpdate.notifyReady(ctx, AutoUpdate.viewIntent(ctx, apk)) }
            else -> {
                UpdateStatus.record(ctx, waiting)
                AutoUpdate.notifyReady(ctx, AutoUpdate.viewIntent(ctx, apk))
            }
        }
        return Result.success()
    }
}

/** Android needs a tap for this install (first update, or it refused silent): show the "Update ready" notification. */
class UpdateStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999) != PackageInstaller.STATUS_PENDING_USER_ACTION) return
        @Suppress("DEPRECATION")
        val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
        // From the Update button the app is on screen, so the install prompt opens right away; in the background
        // Android blocks that, and the notification is the way in.
        UpdateStatus.record(context, "Update ready, waiting for you to tap Install")
        runCatching { context.startActivity(Intent(confirm).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        AutoUpdate.notifyReady(context, confirm)
    }
}
