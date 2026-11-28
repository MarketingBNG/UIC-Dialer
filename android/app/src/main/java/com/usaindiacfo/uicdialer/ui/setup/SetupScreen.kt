package com.usaindiacfo.uicdialer.ui.setup

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.DeviceConfig
import com.usaindiacfo.uicdialer.sync.DeviceHealth
import kotlinx.coroutines.launch

/**
 * Required setup items whose state can be read right away (the recorder folder needs a scan, so it is left out).
 * Settings shows "All good" / "N problems" from this.
 */
fun setupProblemCount(context: Context, businessOnly: Boolean): Int = listOf(
    SetupChecks.requiredGranted(context),
    SetupChecks.callPhoneGranted(context),
    SetupChecks.ignoringBatteryOptimizations(context) && !SetupChecks.backgroundRestricted(context),
    !businessOnly || SetupChecks.granted(context, Manifest.permission.READ_CONTACTS),
).count { !it }

/** One row on the Phone setup screen. [fix] null = no button (info only). */
private class Item(
    val key: String,
    val title: String,
    val body: String,
    val done: Boolean,
    val fixLabel: String = "Fix",
    val fix: (() -> Unit)? = null,
    val extra: (@Composable () -> Unit)? = null,
    /** Shown even when done (e.g. folder ticks and "Change folder"). */
    val keepExtra: Boolean = false,
)

/**
 * The one "Phone setup" screen (used to be a step-by-step guide plus a checklist): progress header, required
 * steps first with one Fix button each, optional steps collapsed, finished steps just ticked.
 * Done marks first-time setup finished, so sign-in stops sending the rep here.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SetupScreen(onDone: () -> Unit) {
    val context = LocalContext.current
    val container = appContainer()
    val scope = rememberCoroutineScope()
    val config by container.deviceConfigRepository.config.collectAsState(initial = DeviceConfig())
    val safUri by remember { SetupPrefs.safTreeUri(context) }.collectAsState(initial = null)
    val brand = remember { Brand.from(Build.MANUFACTURER) }

    // Bumped on resume / permission results so checks re-run after returning from system settings.
    var tick by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { tick++ }
    LaunchedEffect(Unit) { runCatching { container.deviceConfigRepository.refreshIfStale() } }

    val requiredOk = remember(tick) { SetupChecks.requiredGranted(context) }
    val contactsOk = remember(tick) { SetupChecks.granted(context, Manifest.permission.READ_CONTACTS) }
    val notifOk = remember(tick) { SetupChecks.notificationsGranted(context) }
    val phoneStateOk = remember(tick) { SetupChecks.phoneStateGranted(context) }
    val callPhoneOk = remember(tick) { SetupChecks.callPhoneGranted(context) }
    val overlayOk = remember(tick) { SetupChecks.canDrawOverlays(context) }
    val exactOk = remember(tick) { SetupChecks.canExactAlarms(context) }
    val batteryOk = remember(tick) { SetupChecks.ignoringBatteryOptimizations(context) }
    val restricted = remember(tick) { SetupChecks.backgroundRestricted(context) }
    val needsRestrictedSettings = remember(tick) { SetupChecks.needsRestrictedSettings(context) }
    val dialer = remember(tick) { DeviceHealth.defaultDialer(context) }
    var folderFound by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(tick, requiredOk, config.recorderFolders) {
        folderFound = if (requiredOk) SetupChecks.recorderFolderFound(context, config.recorderFolders) else null
    }

    // Whole-phone scan: once after audio access is granted (auto-picks the folders), and again on "Scan again".
    val discovery by remember { SetupPrefs.discovery(context) }
        .collectAsState(initial = SetupPrefs.Discovery(ran = true, folders = emptyList(), unticked = emptySet()))
    val scanning by SetupPrefs.scanning.collectAsState()
    LaunchedEffect(requiredOk, discovery.ran) { if (requiredOk && !discovery.ran) SetupPrefs.startDiscovery(context, config.recorderFolders) }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        tick++
        // Business-only recordings held for the Contacts permission can go now instead of after the retry backoff.
        if (config.businessOnly && result[Manifest.permission.READ_CONTACTS] == true) {
            com.usaindiacfo.uicdialer.sync.SyncScheduler.syncNow(context)
        }
    }
    val treeLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri != null) scope.launch {
            runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            SetupPrefs.setSafTreeUri(context, uri)
        }
    }
    // Ask once per visit; a second tap after a denial goes to App info (Android stops showing the dialog).
    var asked by remember { mutableStateOf(setOf<String>()) }
    fun ask(key: String, perms: List<String>) {
        if (key !in asked) { asked = asked + key; permLauncher.launch(perms.toTypedArray()) } else SetupChecks.openAppDetails(context)
    }
    fun askLabel(key: String) = if (key in asked) "Open app settings" else "Fix"

    val enabled = discovery.enabled
    val folderOk = !scanning && (enabled.isNotEmpty() || folderFound == true || safUri != null)

    val required = buildList {
        add(Item(
            key = "access",
            title = "Allow call log and recordings",
            body = "Needed to find call recordings and match them to the right call.",
            done = requiredOk,
            fixLabel = askLabel("access"),
            fix = { ask("access", SetupChecks.requiredPermissions) },
            extra = if (needsRestrictedSettings) {
                { Hint("If Android says \"Restricted setting\": tap Fix, then Open app settings, tap ⋮ (top right), choose \"Allow restricted settings\", come back and tap Fix again.") }
            } else null,
        ))
        add(Item(
            key = "call",
            title = "Make calls",
            body = "Lets Call on your laptop and in the app dial straight away.",
            done = callPhoneOk,
            fixLabel = askLabel("call"),
            fix = { ask("call", listOf(Manifest.permission.CALL_PHONE)) },
        ))
        // Business-only mode needs Contacts to tell personal calls apart; those recordings wait until it is allowed.
        if (config.businessOnly) add(Item(
            key = "contacts",
            title = "Allow contacts",
            body = "Your admin chose business calls only. Allow Contacts so personal calls are skipped; until then most calls wait to upload.",
            done = contactsOk,
            fixLabel = askLabel("contacts"),
            fix = { ask("contacts", listOf(Manifest.permission.READ_CONTACTS)) },
        ))
        add(Item(
            key = "battery",
            title = "Let the app run in the background",
            body = if (restricted) "Battery is set to \"Restricted\". In App settings > Battery choose \"Unrestricted\"."
            else "Otherwise the phone stops uploads. Tap Allow in the box that appears; if none appears, choose \"All apps\", find UIC Dialer and pick \"Don't optimise\".",
            done = batteryOk && !restricted,
            fix = { if (restricted) SetupChecks.openAppDetails(context) else SetupChecks.openBatterySettings(context) },
        ))
        add(Item(
            key = "folder",
            title = "Find call recordings",
            body = when {
                !requiredOk -> "Allow call log and recordings first."
                scanning -> "Looking for call recordings on this phone..."
                discovery.folders.isNotEmpty() -> "Found recordings in these folders. Untick any that aren't call recordings."
                safUri != null -> "Using the folder you picked."
                folderFound == true -> "Call recordings found."
                folderFound == null -> "Checking..."
                else -> "No call recordings yet. Turn on auto-record (below), make a test call, then tap Scan again."
            },
            done = folderOk,
            keepExtra = true,
            extra = if (!requiredOk || scanning) null else {
                {
                    discovery.folders.forEach { f ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = f.folder in enabled, onCheckedChange = { on -> scope.launch { SetupPrefs.setTicked(context, f.folder, on) } })
                            Text("${f.folder} (${f.files} files)", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    if (!folderOk) Hint("Turn on auto-record in your phone's dialer:\n" + SetupFlow.recordingInstructions(brand))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { SetupPrefs.startDiscovery(context, config.recorderFolders) }) { Text("Scan again") }
                        if (enabled.isEmpty() || safUri != null) {
                            TextButton(onClick = { runCatching { treeLauncher.launch(null) } }) { Text(if (safUri == null) "Choose folder" else "Change folder") }
                        }
                        if (safUri != null) TextButton(onClick = { scope.launch { SetupPrefs.setSafTreeUri(context, null) } }) { Text("Clear") }
                    }
                }
            },
        ))
    }

    val optional = buildList {
        if (!config.businessOnly) add(Item(
            key = "contacts",
            title = "Contacts",
            body = "Show names instead of numbers.",
            done = contactsOk,
            fixLabel = askLabel("contacts"),
            fix = { ask("contacts", listOf(Manifest.permission.READ_CONTACTS)) },
        ))
        add(Item(
            key = "notif",
            title = "Notifications",
            body = "Reminders for follow-ups and missed calls.",
            done = notifOk,
            fixLabel = if (Build.VERSION.SDK_INT >= 33) askLabel("notif") else "Fix",
            fix = {
                if (Build.VERSION.SDK_INT >= 33) ask("notif", listOf(Manifest.permission.POST_NOTIFICATIONS))
                else SetupChecks.openNotificationSettings(context)
            },
        ))
        add(Item(
            key = "card",
            title = "Caller card",
            body = when {
                !phoneStateOk -> "See the client's name and last note while the phone rings."
                !overlayOk -> "Allow \"Display over other apps\" to show the card on the ringing screen. Without it the card comes as a notification."
                else -> "Shows on the ringing screen."
            },
            done = phoneStateOk && overlayOk,
            fixLabel = if (!phoneStateOk) askLabel("phoneState") else "Fix",
            fix = {
                if (!phoneStateOk) ask("phoneState", listOf(Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_PHONE_NUMBERS))
                else SetupChecks.openOverlaySettings(context)
            },
        ))
        if (SetupChecks.exactAlarmApplies) add(Item(
            key = "exact",
            title = "Reminders on time",
            body = "Without it, reminders can come up to 10 minutes late.",
            done = exactOk,
            fix = { SetupChecks.openExactAlarmSettings(context) },
        ))
    }

    val requiredDone = required.count { it.done }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Phone setup", style = MaterialTheme.typography.headlineSmall)
        Text(
            if (requiredDone == required.size) "All required steps done" else "$requiredDone of ${required.size} required done",
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary,
        )
        LinearProgressIndicator(progress = { requiredDone.toFloat() / required.size }, modifier = Modifier.fillMaxWidth())

        // Can't be fixed with a button, so it sits on top where the rep sees it.
        if (DeviceHealth.isGoogleDialer(dialer)) {
            Hint(
                "Your Phone app is Google Phone. Its recordings are private, so UIC Dialer can't read them. " +
                    "Switch to your phone maker's dialer (Settings > Apps > Default apps > Phone app) and turn on its auto-record.",
                warning = true,
            )
        }

        // Unfinished first, so the next thing to do is always at the top.
        required.sortedBy { it.done }.forEach { ItemRow(it) }

        // Autostart can't be read back, so it is a plain helper, not a counted step.
        if (SetupChecks.hasAutostartScreen) {
            ItemRow(Item(
                key = "autostart",
                title = "Allow autostart",
                body = autostartHint(SetupChecks.manufacturer),
                done = false,
                fixLabel = "Open",
                fix = { SetupChecks.openAutostartSettings(context) },
            ), info = true)
        }

        var showOptional by remember { mutableStateOf(false) }
        val optionalDone = optional.count { it.done }
        Row(
            Modifier.fillMaxWidth().clickable { showOptional = !showOptional }.heightIn(min = 48.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Optional ($optionalDone of ${optional.size} done)", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
            Icon(if (showOptional) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, contentDescription = if (showOptional) "Hide" else "Show")
        }
        if (showOptional) optional.forEach { ItemRow(it, info = true) }

        Spacer(Modifier.size(8.dp))
        Button(
            onClick = { scope.launch { GuidePrefs.setCompleted(context); onDone() } },
            enabled = requiredOk,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        ) { Text("Done") }
        if (!requiredOk) {
            Text("Allow call log and recordings to continue.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
    }
}

private fun autostartHint(maker: String) = when (maker) {
    "xiaomi", "redmi", "poco" -> "Security > Autostart: turn on UIC Dialer. Also set Battery saver to \"No restrictions\"."
    "oppo", "realme", "oneplus" -> "Allow UIC Dialer to auto-launch / run in background."
    "vivo", "iqoo" -> "Allow background startup for UIC Dialer (i Manager > App manager)."
    "samsung" -> "Battery: make sure UIC Dialer isn't in \"Sleeping apps\" or \"Deep sleeping apps\"."
    else -> "Allow UIC Dialer to start automatically and run in the background."
}

@Composable
private fun ItemRow(item: Item, info: Boolean = false) {
    val c = MaterialTheme.colorScheme
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.Top) {
            val (icon, tint) = when {
                item.done -> Icons.Filled.CheckCircle to c.primary
                info -> Icons.Filled.Info to c.onSurfaceVariant
                else -> Icons.Filled.Warning to c.error
            }
            Icon(icon, contentDescription = if (item.done) "Done" else null, tint = tint, modifier = Modifier.size(24.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(item.title, style = MaterialTheme.typography.titleSmall)
                // Finished steps stay short: title and tick only.
                if (!item.done || item.keepExtra) {
                    Text(item.body, style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                    item.extra?.invoke()
                }
                if (!item.done && item.fix != null) {
                    if (info) OutlinedButton(onClick = item.fix) { Text(item.fixLabel) }
                    else Button(onClick = item.fix) { Text(item.fixLabel) }
                }
            }
        }
    }
}

@Composable
private fun Hint(text: String, warning: Boolean = false) {
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
            if (warning) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(text, style = MaterialTheme.typography.bodySmall)
        }
    }
}
