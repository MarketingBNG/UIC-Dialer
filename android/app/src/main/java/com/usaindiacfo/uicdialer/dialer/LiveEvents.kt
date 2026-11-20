package com.usaindiacfo.uicdialer.dialer

import android.app.Activity
import android.app.Application
import android.os.Bundle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.currentCoroutineContext
import okhttp3.Call
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Live "something changed" notices from the server (GET /api/events, server-sent events), so a change made on
 * the desktop shows on the phone within a second or two. Only connected while an activity is on screen: no
 * background connection, no Firebase. Screens subscribe with [LiveRefresh] and also refresh on resume, which
 * covers anything missed while closed.
 */
class LiveEvents(
    private val api: ApiClient,
    private val scope: CoroutineScope,
    private val signedIn: () -> Boolean,
) {
    /** Topics: activity, contacts, followups, calls, lists, settings; [ALL] after a reconnect. */
    private val _changes = MutableSharedFlow<String>(extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    val changes: SharedFlow<String> = _changes

    // Heartbeat every 25 s; 70 s without bytes means the connection is dead.
    private val streamHttp = api.http.newBuilder().readTimeout(70, TimeUnit.SECONDS).build()
    private var job: Job? = null
    private var started = 0

    /** Connects while at least one activity is started. */
    fun attach(app: Application) {
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                if (started++ == 0) start()
            }
            override fun onActivityStopped(activity: Activity) {
                if (--started <= 0) {
                    started = 0
                    stop()
                }
            }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }

    internal fun start() {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) { run() }
    }

    internal fun stop() {
        job?.cancel()
        job = null
    }

    private suspend fun run() {
        var backoffMs = 2_000L
        var connectedOnce = false
        while (scope.isActive) {
            if (!signedIn()) {
                delay(5_000)
                continue
            }
            val call = streamHttp.newCall(Request.Builder().url(api.url("/api/events")).header("Accept", "text/event-stream").build())
            try {
                stream(call) { event, data ->
                    when (event) {
                        "ready" -> {
                            backoffMs = 2_000L
                            if (connectedOnce) _changes.tryEmit(ALL)
                            connectedOnce = true
                        }
                        "change" -> TOPIC.find(data)?.groupValues?.get(1)?.let { _changes.tryEmit(it) }
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                // Offline, server down, or stream closed: retry below.
            }
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
        }
    }

    /** Reads the stream until it ends; cancelling the coroutine cancels the HTTP call. */
    private suspend fun stream(call: Call, onEvent: (event: String, data: String) -> Unit) {
        val job = currentCoroutineContext()[Job]
        val handle = job?.invokeOnCompletion { call.cancel() }
        try {
            call.execute().use { res ->
                if (!res.isSuccessful) throw java.io.IOException("HTTP ${res.code}")
                val source = res.body.source()
                var event = "message"
                val data = StringBuilder()
                while (true) {
                    val line = source.readUtf8Line() ?: break
                    when {
                        line.isEmpty() -> {
                            if (data.isNotEmpty() || event != "message") onEvent(event, data.toString())
                            event = "message"
                            data.setLength(0)
                        }
                        line.startsWith(":") -> Unit
                        line.startsWith("event:") -> event = line.substringAfter(':').trim()
                        line.startsWith("data:") -> data.append(line.substringAfter(':').trim())
                    }
                }
            }
        } finally {
            handle?.dispose()
        }
    }

    companion object {
        const val ALL = "all"
        private val TOPIC = Regex("\"topic\"\\s*:\\s*\"([a-z]+)\"")
    }
}

/**
 * Calls [onChange] (debounced) when the server reports a change in one of [topics] (or after a reconnect),
 * while this screen is at least STARTED.
 */
@OptIn(FlowPreview::class)
@Composable
fun LiveRefresh(vararg topics: String, onChange: () -> Unit) {
    val live = appContainer().liveEvents
    val owner = LocalLifecycleOwner.current
    val latest = rememberUpdatedState(onChange)
    val wanted = topics.toSet()
    LaunchedEffect(live, owner, wanted) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            live.changes
                .filter { it == LiveEvents.ALL || wanted.isEmpty() || it in wanted }
                .debounce(400)
                .collect { latest.value() }
        }
    }
}
