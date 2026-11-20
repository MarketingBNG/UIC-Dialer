package com.usaindiacfo.uicdialer.ui.setup

import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
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
import kotlinx.coroutines.launch

/**
 * Guided first-time setup: one step per screen, a big button that opens the exact permission dialog or
 * system screen, automatic tick on return, then "All set". [onOpenChecks] opens the full checklist.
 */
@Composable
fun SetupGuideScreen(onFinished: () -> Unit, onOpenChecks: () -> Unit) {
    val context = LocalContext.current
    val container = appContainer()
    val scope = rememberCoroutineScope()
    val config by container.deviceConfigRepository.config.collectAsState(initial = DeviceConfig())
    val steps = remember { SetupFlow.stepsFor(Build.VERSION.SDK_INT) }
    val brand = remember { Brand.from(Build.MANUFACTURER) }

    var tick by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { tick++ }
    LaunchedEffect(Unit) { runCatching { container.deviceConfigRepository.refreshIfStale() } }
    val done = remember(tick) { steps.filter { SetupChecks.stepDone(context, it) }.toSet() }

    // Open on the first step not done or skipped earlier (null until skipped steps are loaded).
    var index by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(Unit) { index = SetupFlow.firstPending(steps, done, GuidePrefs.skipped(context)) }
    // Ask once per visit; a second tap after a denial goes to app settings (Android stops showing the dialog).
    var asked by remember { mutableStateOf(setOf<GuideStep>()) }
    var autostartOpened by remember { mutableStateOf(false) }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        tick++
        if (config.businessOnly && result[android.Manifest.permission.READ_CONTACTS] == true) {
            com.usaindiacfo.uicdialer.sync.SyncScheduler.syncNow(context)
        }
    }

    val i = index ?: return
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        if (i >= steps.size) {
            AllSet(onFinished = { scope.launch { GuidePrefs.setCompleted(context); onFinished() } }, onOpenChecks = onOpenChecks)
            return@Column
        }
        val step = steps[i]
        val isDone = step in done
        val required = SetupFlow.isRequired(step, config.businessOnly)
        val next = { index = i + 1 }

        Text(SetupFlow.progressLabel(i, steps.size), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        LinearProgressIndicator(progress = { (i + 1f) / steps.size }, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.size(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (isDone) {
                Icon(Icons.Filled.CheckCircle, contentDescription = "Done", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(28.dp))
                Spacer(Modifier.width(8.dp))
            }
            Text(SetupFlow.title(step), style = MaterialTheme.typography.headlineSmall)
        }
        Text(SetupFlow.why(step, config.businessOnly), style = MaterialTheme.typography.bodyLarge)
        if (!required) Text("Optional", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)

        StepExtras(step, brand, isDone)

        val big = Modifier.fillMaxWidth().heightIn(min = 56.dp)
        if (isDone) {
            Text("Done.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
            Button(onClick = next, modifier = big) { Text("Next") }
        } else {
            Button(
                onClick = {
                    val perms = SetupChecks.stepPermissions(step)
                    when {
                        perms.isNotEmpty() && step !in asked -> { asked = asked + step; permLauncher.launch(perms.toTypedArray()) }
                        perms.isNotEmpty() -> SetupChecks.openAppDetails(context)
                        step == GuideStep.BATTERY -> {
                            if (SetupChecks.backgroundRestricted(context)) SetupChecks.openAppDetails(context)
                            else SetupChecks.openBatterySettings(context)
                        }
                        step == GuideStep.OVERLAY -> SetupChecks.openOverlaySettings(context)
                        step == GuideStep.EXACT_ALARMS -> SetupChecks.openExactAlarmSettings(context)
                    }
                },
                modifier = big,
            ) { Text(if (SetupChecks.stepPermissions(step).isNotEmpty() && step in asked) "Open app settings" else "Allow") }

            if (step == GuideStep.BATTERY && SetupFlow.needsAutostart(brand) && SetupChecks.hasAutostartScreen) {
                OutlinedButton(onClick = { autostartOpened = true; SetupChecks.openAutostartSettings(context) }, modifier = big) {
                    Text(if (autostartOpened) "Open autostart again" else "Open autostart")
                }
            }
            if (!required) TextButton(onClick = { scope.launch { GuidePrefs.skip(context, step) }; next() }, modifier = Modifier.fillMaxWidth()) {
                Text("Skip for now")
            }
        }
        if (i > 0) TextButton(onClick = { index = i - 1 }) { Text("Back") }
    }
}

@Composable
private fun StepExtras(step: GuideStep, brand: Brand, isDone: Boolean) {
    val context = LocalContext.current
    when (step) {
        GuideStep.PHONE -> if (!isDone && SetupChecks.needsRestrictedSettings(context)) {
            Hint(
                "If Android says \"Restricted setting\": tap Allow, then Open app settings, tap ⋮ (top right), choose " +
                    "\"Allow restricted settings\", come back and tap again.",
            )
        }
        GuideStep.RECORDINGS -> {
            val dialer = remember { com.usaindiacfo.uicdialer.sync.DeviceHealth.defaultDialer(context) }
            Hint("Then turn on auto-record in your phone's dialer:\n" + SetupFlow.recordingInstructions(brand))
            if (com.usaindiacfo.uicdialer.sync.DeviceHealth.isGoogleDialer(dialer) && brand != Brand.MOTOROLA_GOOGLE) {
                Hint(SetupFlow.recordingInstructions(Brand.MOTOROLA_GOOGLE))
            }
        }
        GuideStep.BATTERY -> {
            Hint(
                if (SetupChecks.backgroundRestricted(context)) "Battery is set to \"Restricted\". In App settings > Battery choose \"Unrestricted\"."
                else "Tap Allow in the box that appears. If no box appears, choose \"All apps\", find UIC Dialer and select \"Don't optimise\".",
            )
            if (SetupFlow.needsAutostart(brand)) Hint("Also: " + SetupFlow.autostartInstructions(brand))
        }
        GuideStep.OVERLAY -> Hint("Find UIC Dialer in the list and switch on \"Display over other apps\". Without it the card comes as a notification.")
        else -> Unit
    }
}

@Composable
private fun Hint(text: String) {
    Card(Modifier.fillMaxWidth()) { Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp)) }
}

@Composable
private fun AllSet(onFinished: () -> Unit, onOpenChecks: () -> Unit) {
    Spacer(Modifier.size(32.dp))
    Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(64.dp))
    Text("All set", style = MaterialTheme.typography.headlineMedium)
    Text("Your calls will now upload automatically. Make a short test call to check recording works.", style = MaterialTheme.typography.bodyLarge)
    Button(onClick = onFinished, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("Go to Today") }
    TextButton(onClick = onOpenChecks, modifier = Modifier.fillMaxWidth()) { Text("See all setup checks") }
}
