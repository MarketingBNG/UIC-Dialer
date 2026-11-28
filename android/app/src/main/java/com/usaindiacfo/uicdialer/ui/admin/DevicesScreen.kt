package com.usaindiacfo.uicdialer.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Phone
import com.usaindiacfo.uicdialer.ui.common.EmptyState
import com.usaindiacfo.uicdialer.ui.common.Pill
import com.usaindiacfo.uicdialer.ui.common.PillTone
import com.usaindiacfo.uicdialer.ui.common.colors
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.DeviceDto
import com.usaindiacfo.uicdialer.data.api.CostSettingsPatch
import com.usaindiacfo.uicdialer.data.api.FirefliesPatch
import com.usaindiacfo.uicdialer.data.api.Stats
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

private val STALE = Duration.ofHours(24)

/** Sync health: server stats header plus one card per device. Admins can revoke a device. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DevicesScreen() {
    val container = appContainer()
    val api = container.apiClient
    val me by container.authRepository.currentUser.collectAsStateWithLifecycle()
    val isAdmin = me?.isAdmin == true
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    var devices by remember { mutableStateOf<List<DeviceDto>?>(null) }
    var stats by remember { mutableStateOf<Stats?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    var confirm by remember { mutableStateOf<DeviceDto?>(null) }
    var now by remember { mutableStateOf(Instant.now()) }
    val ff = remember { FirefliesPanelState() }
    val ffSave: (FirefliesPatch, String) -> Unit = { patch, done -> ff.save(scope, api, patch, done) { snackbar.showSnackbar(it) } }
    val tr = remember { TranslationPanelState() }
    val trSave: (CostSettingsPatch) -> Unit = { patch -> tr.save(scope, api, patch) { snackbar.showSnackbar(it) } }

    LaunchedEffect(reload) {
        refreshing = true
        now = Instant.now()
        // Stats failing (e.g. disk probe) shouldn't hide the device list.
        val (d, s) = coroutineScope {
            val s = async { apiCall { api.stats() } }
            launch { ff.load(api) }
            launch { tr.load(api) }
            apiCall { api.devices() } to s.await()
        }
        s.onSuccess { stats = it }
        d.onSuccess { devices = it; error = null }
            .onFailure { e -> if (devices == null) error = e.userMessage() else snackbar.showSnackbar(e.userMessage()) }
        refreshing = false
    }

    Box(Modifier.fillMaxSize()) {
        val list = devices
        val err = error
        when {
            list == null && err != null -> ErrorState(err) { error = null; reload++ }
            list == null -> Loading()
            else -> PullToRefreshBox(isRefreshing = refreshing, onRefresh = { reload++ }, modifier = Modifier.fillMaxSize()) {
                // Active devices first, revoked ones at the bottom; server order (last seen desc) otherwise.
                val sorted = remember(list) { list.sortedBy { it.revokedAt != null } }
                LazyColumn(
                    Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    stats?.let { s -> item(key = "stats") { StatsHeader(s, offlineNames(list, now)) } }
                    item(key = "fireflies") { FirefliesPanel(isAdmin, ff, ffSave) }
                    item(key = "translation") { TranslationPanel(isAdmin, tr, trSave) }
                    if (sorted.isEmpty()) item(key = "empty") { EmptyState(Icons.Filled.Phone, "No phones yet", text = "Phones show up here after staff sign in.") }
                    items(sorted, key = { it.id }) { d ->
                        DeviceRow(d, now, onRevoke = if (isAdmin && d.revokedAt == null) ({ confirm = d }) else null)
                    }
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }
    FirefliesClearDialog(ff, ffSave)

    confirm?.let { d ->
        var busy by remember(d.id) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { if (!busy) confirm = null },
            title = { Text("Sign out this phone?") },
            text = {
                Text("${d.model ?: "This device"} (${d.user.name ?: d.user.email}) will be signed out and stop sending calls until they sign in again.")
            },
            confirmButton = {
                TextButton(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        apiCall { api.revokeDevice(d.id) }
                            .onSuccess { confirm = null; reload++; snackbar.showSnackbar("Phone signed out") }
                            .onFailure { confirm = null; snackbar.showSnackbar(it.userMessage()) }
                    }
                }) { Text("Sign out", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(enabled = !busy, onClick = { confirm = null }) { Text("Cancel") } },
        )
    }
}

/** Names of active phones not seen for a day, for the server card. */
private fun offlineNames(list: List<DeviceDto>, now: Instant): List<String> = list
    .filter { it.revokedAt == null && parseInstant(it.lastSeenAt)?.let { t -> Duration.between(t, now) > STALE } != false }
    .map { it.user.name ?: it.user.email }
    .distinct()

/** Call states in plain words; Uploaded and Transcribing are one step to a manager. */
internal fun callStatusLabel(status: String): String = when (status) {
    "PENDING_UPLOAD" -> "Waiting to upload"
    "UPLOADED", "TRANSCRIBING" -> "Working on transcript"
    "TRANSCRIBED" -> "Transcript ready"
    "FAILED" -> "No transcript, audio kept"
    "NO_RECORDING" -> "No recording"
    else -> status.lowercase().replace('_', ' ')
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatsHeader(s: Stats, offline: List<String>) {
    val amber = PillTone.WARNING.colors().fg
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Server", style = MaterialTheme.typography.titleSmall)
            if (s.calls.isNotEmpty()) StatLine("Calls", s.calls, ::callStatusLabel)
            if (s.jobs.isNotEmpty()) StatLine("Transcript jobs", s.jobs, ::jobStatusLabel)
            // Red only when the disk is nearly full (act now); amber as an early warning.
            val diskColor = when {
                s.disk.usedPct > 95 -> PillTone.DANGER.colors().fg
                s.disk.usedPct > 80 -> amber
                else -> MaterialTheme.colorScheme.primary
            }
            Text(
                "Storage ${s.disk.usedPct}% used · ${formatBytes(s.disk.freeBytes)} free of ${formatBytes(s.disk.totalBytes)}",
                style = MaterialTheme.typography.bodySmall,
            )
            LinearProgressIndicator(
                progress = { s.disk.usedPct.coerceIn(0, 100) / 100f },
                color = diskColor,
                modifier = Modifier.fillMaxWidth(),
            )
            s.compression?.let { c ->
                Text(
                    "Space saved by shrinking audio: ${formatBytes(c.bytesSaved)} (${c.compressedCalls} calls)",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            s.throughput?.let { t ->
                Text(
                    "Transcripts that didn't work (24 h): ${t.failureRatePct}%",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (t.failureRatePct > 5) amber else Color.Unspecified,
                )
                Text(
                    "Calls still to do: ${t.backlogCalls} (${t.backlogMinutes} min) · done in about ${t.etaText()}",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Text(
                when {
                    s.staleDevices == 0 -> "All phones checked in today"
                    offline.isNotEmpty() -> "Phones offline for more than a day: ${offline.joinToString(", ")}"
                    else -> "Phones offline for more than a day: ${s.staleDevices}"
                },
                style = MaterialTheme.typography.bodySmall,
                color = if (s.staleDevices > 0) amber else Color.Unspecified,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatLine(label: String, counts: Map<String, Int>, name: (String) -> String) {
    // Several raw states can share one plain word, so add them up.
    val merged = remember(counts) {
        counts.entries.sortedBy { it.key }.groupingBy { name(it.key) }.fold(0) { acc, e -> acc + e.value }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("$label:", style = MaterialTheme.typography.labelMedium)
        merged.forEach { (k, v) -> Text("$k $v", style = MaterialTheme.typography.bodySmall) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DeviceRow(d: DeviceDto, now: Instant, onRevoke: (() -> Unit)?) {
    val revoked = d.revokedAt != null
    val lastSeen = parseInstant(d.lastSeenAt)
    val stale = !revoked && (lastSeen == null || Duration.between(lastSeen, now) > STALE)
    val amber = PillTone.WARNING.colors().fg
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.user.name ?: d.user.email, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        listOfNotNull(d.model, d.androidVersion?.let { "Android $it" }, d.appVersion?.let { "App $it" }).joinToString(" · ").ifEmpty { "Unknown phone" },
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                if (onRevoke != null) TextButton(onClick = onRevoke) { Text("Sign out") }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                when {
                    revoked -> Pill("Signed out ${formatDate(d.revokedAt)}", PillTone.NEUTRAL)
                    stale -> Pill("Offline", PillTone.WARNING)
                    else -> Pill("Online", PillTone.SUCCESS)
                }
                if (!d.permissionsOk && !revoked) Pill("Needs permission", PillTone.WARNING)
            }
            if (!revoked) {
                Text("Last seen ${ago(d.lastSeenAt, now)}", style = MaterialTheme.typography.bodySmall)
            }
            Text("Last sent calls ${ago(d.lastSyncAt, now)}", style = MaterialTheme.typography.bodySmall)
            Text(
                "Waiting to upload ${d.pendingCount} · Phone space free ${formatBytes(d.freeBytes?.toLongOrNull())}",
                style = MaterialTheme.typography.bodySmall,
            )
            if (!d.permissionsOk && !revoked) {
                Text("App can't read recordings. Open the app on this phone and tap Fix.", color = amber, style = MaterialTheme.typography.bodySmall)
            }
            deviceHealthLines(d).forEach { (text, warn) ->
                Text(text, color = if (warn && !revoked) amber else Color.Unspecified, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** Extra heartbeat lines (M4), same facts as the dashboard Health page. Pair = text to "is a warning". */
internal fun deviceHealthLines(d: DeviceDto): List<Pair<String, Boolean>> = buildList {
    if (d.calls7d != null) {
        val tail = if (d.callsWithoutRecordings) " (calls but no recordings)" else ""
        add(Pair("Calls / recordings (7 days): ${d.calls7d} / ${d.recordings7d ?: "-"}$tail", d.callsWithoutRecordings))
    }
    d.standbyBucketName?.let { add(Pair("Battery limit: $it" + (if (d.throttled) " (app slowed down)" else ""), d.throttled)) }
    d.lastStopReason?.let { add("Last background stop: ${com.usaindiacfo.uicdialer.sync.DeviceHealth.stopReasonLabel(it)}" to false) }
    d.defaultDialer?.let {
        val google = com.usaindiacfo.uicdialer.sync.DeviceHealth.isGoogleDialer(it)
        add(Pair("Phone app: " + (if (google) "Google Phone (recordings not readable)" else it), google))
    }
    d.autostartIntent?.let { add("Auto-start setting: ${it.substringBefore('/')}" to false) }
}
