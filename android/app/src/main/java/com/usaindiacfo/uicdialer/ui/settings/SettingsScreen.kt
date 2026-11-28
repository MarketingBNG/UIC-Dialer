package com.usaindiacfo.uicdialer.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.usaindiacfo.uicdialer.BuildConfig
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.DeviceConfig
import com.usaindiacfo.uicdialer.data.api.Me
import com.usaindiacfo.uicdialer.ui.dialer.Avatar
import com.usaindiacfo.uicdialer.ui.home.SyncStatus
import com.usaindiacfo.uicdialer.ui.setup.setupProblemCount
import com.usaindiacfo.uicdialer.update.AutoUpdate
import com.usaindiacfo.uicdialer.update.UpdateBanner
import com.usaindiacfo.uicdialer.update.UpdateStatus
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onOpenSetup: () -> Unit, onOpenGuide: () -> Unit, onOpenAdmin: () -> Unit, onBack: () -> Unit) {
    val container = appContainer()
    val auth = container.authRepository
    val scope = rememberCoroutineScope()
    val user by auth.currentUser.collectAsState()
    val config by container.deviceConfigRepository.config.collectAsState(initial = DeviceConfig())
    var me by remember { mutableStateOf<Me?>(null) }
    var confirmSignOut by remember { mutableStateOf(false) }
    var signingOut by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        me = runCatching { container.apiClient.me() }.getOrNull()
        runCatching { auth.refreshMe() }
        runCatching { container.deviceConfigRepository.refreshIfStale() }
    }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Settings") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
        )
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            UpdateBanner()

            Section("Account") {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Avatar(user?.name ?: user?.email, size = 48.dp)
                    Column(Modifier.weight(1f)) {
                        Text(user?.name ?: user?.email.orEmpty(), style = MaterialTheme.typography.titleMedium)
                        user?.let { Text(it.email, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }

            Section("My phone") {
                SetupStatusRow(config.businessOnly, onOpenSetup)
                SyncStatus(onOpenSetup)
            }

            Section("Calling") { CallsFromPcSetting() }

            Section("Reminders") { RemindersSettings(onOpenSetup) }

            Section("About") {
                Text("UIC Dialer ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium)
                UpdateStatusLines(Modifier)
            }

            OutlinedButton(
                onClick = { confirmSignOut = true },
                enabled = !signingOut,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text(if (signingOut) "Signing out..." else "Sign out") }

            // Manager tools sit last and apart so reps don't wander into them.
            if (user?.canManage == true) {
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                Text("Manager tools", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                NavRow("Team and server", "Users, devices, server settings", onOpenAdmin)
            }
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out?") },
            text = { Text("Recordings stop syncing from this phone until you sign in again.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmSignOut = false
                    signingOut = true
                    scope.launch { auth.signOut() } // navigation reacts to currentUser = null
                }) { Text("Sign out") }
            },
            dismissButton = { TextButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

/** "Calls from PC": the laptop's Call button makes this phone dial (see RemoteDialService). */
@Composable
private fun CallsFromPcSetting() {
    val context = androidx.compose.ui.platform.LocalContext.current
    var on by remember { mutableStateOf(com.usaindiacfo.uicdialer.dialer.RemoteDialService.isEnabled(context)) }
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Dial from my laptop", style = MaterialTheme.typography.bodyMedium)
            Text(
                "Click Call in UIC Dialer on your PC and this phone dials by itself. Shows a small notification while on.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = on, onCheckedChange = {
            on = it
            com.usaindiacfo.uicdialer.dialer.RemoteDialService.set(context, it)
        })
    }
}

/** "Phone setup: All good / N problems"; re-checked on resume since the fixes happen in system screens. */
@Composable
private fun SetupStatusRow(businessOnly: Boolean, onOpenSetup: () -> Unit) {
    val context = LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { tick++ }
    val problems = remember(tick, businessOnly) { setupProblemCount(context, businessOnly) }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpenSetup).heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Phone setup", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(
            when (problems) { 0 -> "All good"; 1 -> "1 problem"; else -> "$problems problems" },
            style = MaterialTheme.typography.bodyMedium,
            color = if (problems == 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
        )
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
    }
}

/** Morning follow-up list on/off and time (IST, whole hours). Follow-up reminders themselves are always on. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RemindersSettings(onOpenSetup: () -> Unit) {
    val context = LocalContext.current
    val store = remember { com.usaindiacfo.uicdialer.reminders.ReminderStore(context) }
    var enabled by remember { mutableStateOf(store.summaryEnabled) }
    var hour by remember { mutableStateOf(store.summaryHour) }
    var picking by remember { mutableStateOf(false) }
    fun save() {
        store.summaryEnabled = enabled
        store.summaryHour = hour
        com.usaindiacfo.uicdialer.reminders.Reminders.scheduleMorning(context, androidx.work.ExistingWorkPolicy.REPLACE)
    }
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Morning follow-up list", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Switch(checked = enabled, onCheckedChange = { enabled = it; save() })
    }
    if (enabled) {
        Row(
            Modifier.fillMaxWidth().clickable { picking = true }.heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Time", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            Text(com.usaindiacfo.uicdialer.reminders.ReminderPlan.hourText(hour), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
        }
    }
    if (picking) {
        val state = rememberTimePickerState(initialHour = hour, initialMinute = 0, is24Hour = false)
        AlertDialog(
            onDismissRequest = { picking = false },
            title = { Text("Morning list time") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    TimePicker(state = state)
                    // The alarm runs on the hour, so minutes are dropped.
                    Text("Comes on the hour.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = { TextButton(onClick = { hour = state.hour; picking = false; save() }) { Text("OK") } },
            dismissButton = { TextButton(onClick = { picking = false }) { Text("Cancel") } },
        )
    }
    if (com.usaindiacfo.uicdialer.ui.setup.SetupChecks.exactAlarmApplies && !com.usaindiacfo.uicdialer.ui.setup.SetupChecks.canExactAlarms(context)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Reminders may come up to 10 minutes late.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            TextButton(onClick = onOpenSetup) { Text("Fix") }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            content()
        }
    }
}

@Composable
private fun NavRow(title: String, subtitle: String, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Row(Modifier.heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
        }
    }
}

/** Shows what background auto-update last did, so a rep can tell it is working. */
@Composable
private fun UpdateStatusLines(modifier: Modifier) {
    val context = LocalContext.current
    var status by remember { mutableStateOf(UpdateStatus.read(context)) }
    // The worker writes in the background; re-read now and then so "Check now" shows its result.
    LaunchedEffect(Unit) { while (true) { delay(3_000); status = UpdateStatus.read(context) } }
    val small = MaterialTheme.typography.bodySmall
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(modifier) {
        status.updatedTo?.let { Text("Updated to v$it on ${UpdateStatus.date(status.updatedAt)}", style = small, color = muted) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (status.lastCheckAt == 0L) "Not checked yet"
                else "Last checked ${UpdateStatus.ago(status.lastCheckAt)}: ${status.lastResult.orEmpty()}",
                style = small, color = muted, modifier = Modifier.weight(1f, fill = false),
            )
            TextButton(onClick = { AutoUpdate.checkNow(context) }) { Text("Check now") }
        }
    }
}
