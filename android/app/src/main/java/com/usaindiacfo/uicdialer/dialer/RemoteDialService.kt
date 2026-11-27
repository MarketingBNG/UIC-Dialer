package com.usaindiacfo.uicdialer.dialer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.telecom.TelecomManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.usaindiacfo.uicdialer.MainActivity
import com.usaindiacfo.uicdialer.R
import com.usaindiacfo.uicdialer.container
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * "Calls from PC": while on, keeps a live connection to the server so a Call click on the rep's laptop makes
 * this phone dial straight away (Phone Link then carries the audio to the laptop). Runs as a small ongoing
 * notification, because Android stops background connections otherwise. Off by default; the rep turns it on in
 * Settings. The number comes from the rep's own laptop request, already checked against do-not-call by the server.
 */
class RemoteDialService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }
    /** Requests already handled (a reconnect must never dial twice). */
    private val seen = ArrayDeque<String>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel(this)
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type)
        scope.launch { listen() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            setEnabled(this, false)
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun listen() {
        val c = container
        // Heartbeat every 25 s; 70 s without bytes means the connection is dead.
        val http = c.apiClient.http.newBuilder().readTimeout(70, TimeUnit.SECONDS).build()
        var backoffMs = 2_000L
        while (currentCoroutineContext().isActive) {
            if (c.tokenStore.user.value == null) {
                delay(10_000)
                continue
            }
            val call = http.newCall(Request.Builder().url(c.apiClient.url("/api/events")).header("Accept", "text/event-stream").build())
            val handle = currentCoroutineContext()[kotlinx.coroutines.Job]?.invokeOnCompletion { call.cancel() }
            try {
                call.execute().use { res ->
                    if (!res.isSuccessful) throw java.io.IOException("HTTP ${res.code}")
                    backoffMs = 2_000L
                    val source = res.body.source()
                    var event = "message"
                    val data = StringBuilder()
                    while (true) {
                        val line = source.readUtf8Line() ?: break
                        when {
                            line.isEmpty() -> {
                                if (event == "dial") onDial(data.toString())
                                event = "message"
                                data.setLength(0)
                            }
                            line.startsWith("event:") -> event = line.substringAfter(':').trim()
                            line.startsWith("data:") -> data.append(line.substringAfter(':').trim())
                        }
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                // Offline, server restart, or stream closed (every 30 min): reconnect below.
            } finally {
                handle?.dispose()
            }
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
        }
    }

    private fun onDial(raw: String) {
        val req = runCatching { json.decodeFromString(RemoteDialRequest.serializer(), raw) }.getOrNull() ?: return
        if (req.id in seen) return
        seen.addLast(req.id)
        while (seen.size > 20) seen.removeFirst()
        // A request that waited (the phone was offline) is dropped: the laptop has fallen back to Phone Link.
        if (System.currentTimeMillis() - req.at > MAX_AGE_MS) return
        val error = placeCall(req.phone)
        scope.launch { runCatching { container.apiClient.postDialAck(req.id, error == null, error) } }
    }

    /** Null when the call was handed to the phone; otherwise why not. */
    private fun placeCall(phone: String): String? {
        val n = DialLogic.cleanNumber(phone)
        if (n.isEmpty()) return "bad number"
        if (checkSelfPermission(android.Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            return "phone permission is off in UIC Dialer"
        }
        return try {
            // Telecom places the call itself (no screen of ours), so this works with the phone locked in a pocket.
            // The phone's own dialer runs the call, so its recorder and our upload keep working.
            getSystemService(TelecomManager::class.java).placeCall(Uri.fromParts("tel", n, null), android.os.Bundle())
            DialPrefs(this).addAppDial(n, System.currentTimeMillis())
            null
        } catch (e: SecurityException) {
            "phone permission is off in UIC Dialer"
        } catch (e: Exception) {
            e.message?.take(100) ?: "could not dial"
        }
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, RemoteDialService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle("Ready for calls from your PC")
            .setContentText("Click Call in UIC Dialer on your laptop and this phone dials.")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .addAction(0, "Turn off", stop)
            .build()
    }

    @Serializable
    private data class RemoteDialRequest(val id: String, val phone: String, val at: Long)

    companion object {
        private const val CHANNEL = "remote_dial"
        private const val NOTIFICATION_ID = 9010
        private const val ACTION_STOP = "com.usaindiacfo.uicdialer.REMOTE_DIAL_STOP"
        private const val PREFS = "remote_dial"
        private const val KEY_ON = "on"
        /** The laptop waits 6 s for an answer, then uses Phone Link's dialer instead. */
        private const val MAX_AGE_MS = 15_000L

        fun isEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ON, false)

        private fun setEnabled(context: Context, on: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ON, on).apply()
        }

        /** Turns "Calls from PC" on or off (from Settings). */
        fun set(context: Context, on: Boolean) {
            setEnabled(context, on)
            if (on) start(context) else context.stopService(Intent(context, RemoteDialService::class.java))
        }

        /** Starts the service when it's on and someone is signed in (app open, boot, app update). */
        fun startIfEnabled(context: Context) {
            if (isEnabled(context) && context.container.tokenStore.user.value != null) start(context)
        }

        private fun start(context: Context) {
            // Android refuses a foreground start from some background states; the next app open retries.
            runCatching { androidx.core.content.ContextCompat.startForegroundService(context, Intent(context, RemoteDialService::class.java)) }
        }

        private fun createChannel(context: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Calls from PC", NotificationManager.IMPORTANCE_LOW)
                    .apply { description = "Shown while this phone is ready to dial for your laptop" },
            )
        }
    }
}
