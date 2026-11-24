package com.usaindiacfo.uicdialer.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import com.usaindiacfo.uicdialer.MainActivity
import com.usaindiacfo.uicdialer.R

/** The "Uploading old recordings: 193 of 5,589" notification shown while the backlog uploads (like WhatsApp backup). */
object BacklogNotification {
    private const val CHANNEL = "backlog_upload"
    const val ID = 9101

    /** Pure text, for tests and the notification. */
    fun text(done: Int, total: Int): String = "%,d of %,d uploaded".format(done, total)

    fun foregroundInfo(context: Context, done: Int, total: Int): ForegroundInfo {
        if (Build.VERSION.SDK_INT >= 26) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Uploading old recordings", NotificationManager.IMPORTANCE_LOW)
                    .apply { description = "Progress while older call recordings upload" },
            )
        }
        val open = PendingIntent.getActivity(
            context, 9101, Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle("Uploading old recordings")
            .setContentText(text(done, total))
            .setProgress(total.coerceAtLeast(1), done.coerceIn(0, total.coerceAtLeast(1)), total == 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(open)
            .build()
        return if (Build.VERSION.SDK_INT >= 29) ForegroundInfo(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else ForegroundInfo(ID, n)
    }
}
