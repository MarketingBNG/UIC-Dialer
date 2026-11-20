package com.usaindiacfo.uicdialer.ui.home

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.db.RecordingSource
import com.usaindiacfo.uicdialer.data.db.RecordingStatus
import com.usaindiacfo.uicdialer.ui.calls.CallStatusText
import com.usaindiacfo.uicdialer.ui.setup.SetupChecks
import com.usaindiacfo.uicdialer.update.UpdateBanner

/** Old Home tab; its content now lives in Settings as the Sync section. */
@Composable
fun HomeScreen(onOpenSetup: () -> Unit) {
    var resumeTick by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { resumeTick++ }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        UpdateBanner(checkKey = resumeTick / 10) // re-check occasionally, not on every resume
        SyncStatus(onOpenSetup)
    }
}

/** Synced / pending / failed counts, backlog progress, Sync now, and a "Finish setup" banner. */
@Composable
fun SyncStatus(onOpenSetup: () -> Unit) {
    val context = LocalContext.current
    val dao = appContainer().db.recordings()
    val counts by remember { dao.observeCounts() }.collectAsState(initial = emptyList())
    val backlogLeft by remember { dao.observePendingCount(RecordingSource.BACKLOG) }.collectAsState(initial = 0)
    val lastUpload by remember { dao.observeLastUploadAt() }.collectAsState(initial = null)
    val syncInfos by remember { WorkManager.getInstance(context).getWorkInfosForUniqueWorkFlow(SyncNames.SYNC_NOW) }
        .collectAsState(initial = emptyList())
    val syncing = syncInfos.any { it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.ENQUEUED }

    var resumeTick by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { resumeTick++ }
    val permsOk = remember(resumeTick) { SetupChecks.requiredGranted(context) }
    var message by remember { mutableStateOf<String?>(null) }

    val byStatus = counts.associate { it.status to it.count }
    val uploaded = byStatus[RecordingStatus.UPLOADED] ?: 0
    val pending = (byStatus[RecordingStatus.PENDING] ?: 0) + (byStatus[RecordingStatus.UPLOADING] ?: 0)
    val failed = byStatus[RecordingStatus.FAILED] ?: 0
    val total = counts.sumOf { it.count }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (!permsOk) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                Column(Modifier.padding(16.dp)) {
                    Text("Setup incomplete: recordings can't be synced.", style = MaterialTheme.typography.titleSmall)
                    TextButton(onClick = onOpenSetup) { Text("Finish setup") }
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Stat(CallStatusText.of(RecordingStatus.UPLOADED).label, uploaded, MaterialTheme.colorScheme.primary, Modifier.weight(1f))
            Stat(CallStatusText.of(RecordingStatus.PENDING).label, pending, MaterialTheme.colorScheme.tertiary, Modifier.weight(1f))
            Stat(CallStatusText.of(RecordingStatus.FAILED).label, failed, MaterialTheme.colorScheme.error, Modifier.weight(1f))
        }

        Text(
            "Last upload: " + (lastUpload?.let {
                DateUtils.getRelativeTimeSpanString(it, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
            } ?: "never"),
            style = MaterialTheme.typography.bodyMedium,
        )

        if (backlogLeft > 0 && total > 0) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Older recordings: $backlogLeft left", style = MaterialTheme.typography.titleSmall)
                    LinearProgressIndicator(
                        progress = { (total - backlogLeft).toFloat() / total },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        "These upload while the phone is charging on Wi-Fi.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }

        Button(
            onClick = {
                message = if (SyncNames.enqueueSyncNow(context)) null else "Sync isn't available in this build."
            },
            enabled = !syncing && permsOk,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (syncing) "Syncing..." else "Sync now") }
        if (syncing) LinearProgressIndicator(Modifier.fillMaxWidth())
        message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun Stat(label: String, value: Int, color: Color, modifier: Modifier = Modifier) {
    Card(modifier) {
        Column(Modifier.padding(12.dp)) {
            Text(value.toString(), style = MaterialTheme.typography.headlineSmall, color = color)
            Text(label, style = MaterialTheme.typography.bodySmall)
        }
    }
}
