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
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicdialer.BuildConfig
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.DeviceConfig
import com.usaindiacfo.uicdialer.data.api.Me
import com.usaindiacfo.uicdialer.ui.dialer.Avatar
import com.usaindiacfo.uicdialer.ui.home.SyncStatus
import com.usaindiacfo.uicdialer.update.UpdateBanner
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onOpenSetup: () -> Unit, onOpenAdmin: () -> Unit, onBack: () -> Unit) {
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
                user?.let { Text("Role: ${it.role.name.lowercase().replaceFirstChar(Char::uppercase)}") }
                me?.team?.let { Text("Team: $it") }
                OutlinedButton(
                    onClick = { confirmSignOut = true },
                    enabled = !signingOut,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text(if (signingOut) "Signing out..." else "Sign out") }
            }

            Section("Sync") { SyncStatus(onOpenSetup) }

            NavRow("Setup checks", "Permissions and phone settings the app needs", onOpenSetup)
            if (user?.canManage == true) NavRow("Admin", "Users, devices, server settings", onOpenAdmin)

            Section("Reminders") { RemindersSettings() }

            Section("My excluded numbers") {
                if (config.excludedNumbers.isEmpty()) Text("None. All calls are synced.")
                else config.excludedNumbers.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                Text(
                    "Calls with these numbers are never uploaded. Managed by your admin on the dashboard.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Section("Network") {
                Text("New calls: " + if (config.liveNetwork == "wifi") "Wi-Fi only" else "Wi-Fi or mobile data")
                Text(
                    if (config.backlogEnabled) "Older recordings (last ${config.backlogCutoffDays} days): while charging on Wi-Fi"
                    else "Older recordings: not synced",
                )
                if (config.compressAudio) Text("Audio is compressed before upload to save data.")
                if (config.businessOnly) Text("Business calls only: calls with numbers saved in your contacts are not synced, unless the number is on the company's client list.")
                Text("Set by your admin.", style = MaterialTheme.typography.bodySmall)
            }

            Section("About") {
                Text("UIC Dialer ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
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

/** Morning summary on/off and hour (IST). Follow-up reminders themselves are always on. */
@Composable
private fun RemindersSettings() {
    val context = androidx.compose.ui.platform.LocalContext.current
    val store = remember { com.usaindiacfo.uicdialer.reminders.ReminderStore(context) }
    var enabled by remember { mutableStateOf(store.summaryEnabled) }
    var hour by remember { mutableStateOf(store.summaryHour) }
    fun save() {
        store.summaryEnabled = enabled
        store.summaryHour = hour
        com.usaindiacfo.uicdialer.reminders.Reminders.scheduleMorning(context, androidx.work.ExistingWorkPolicy.REPLACE)
    }
    Text("You get a notification when it's time to call a client back.", style = MaterialTheme.typography.bodyMedium)
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Morning summary", style = MaterialTheme.typography.titleSmall)
            Text("\"You have 5 follow-ups today\"", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        androidx.compose.material3.Switch(checked = enabled, onCheckedChange = { enabled = it; save() })
    }
    if (enabled) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Time", Modifier.weight(1f))
            TextButton(onClick = { hour = (hour - 1).coerceAtLeast(5); save() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("−") }
            Text(com.usaindiacfo.uicdialer.reminders.ReminderPlan.hourText(hour), style = MaterialTheme.typography.titleSmall)
            TextButton(onClick = { hour = (hour + 1).coerceAtMost(12); save() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("+") }
        }
    }
    if (com.usaindiacfo.uicdialer.ui.setup.SetupChecks.exactAlarmApplies && !com.usaindiacfo.uicdialer.ui.setup.SetupChecks.canExactAlarms(context)) {
        Text("Reminders may come up to 10 minutes late. Allow exact times in Setup checks.", style = MaterialTheme.typography.bodySmall)
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
