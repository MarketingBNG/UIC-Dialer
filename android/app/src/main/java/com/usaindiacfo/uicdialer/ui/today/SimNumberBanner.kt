package com.usaindiacfo.uicdialer.ui.today

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.ApiException
import com.usaindiacfo.uicdialer.detect.Sim
import com.usaindiacfo.uicdialer.detect.SimInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Asks once for the number of each SIM in this phone that the server has no number for, so every call
 * shows which of the rep's numbers it used. Never blocks syncing; "Later" hides it until the app restarts.
 */
@Composable
fun SimNumberBanner(checkKey: Any = Unit) {
    val context = LocalContext.current
    val api = appContainer().apiClient
    val scope = rememberCoroutineScope()
    var missing by remember { mutableStateOf<List<Sim>>(emptyList()) }
    var input by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    // Phones set up before READ_PHONE_NUMBERS was added: ask once. With phone state already allowed, Android
    // usually grants it without a dialog (same permission group); then the number is read instead of typed.
    var numbersAsked by remember { mutableStateOf(0) }
    val numbersLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { numbersAsked++ }
    LaunchedEffect(Unit) {
        if (SimInfo.hasPermission(context) &&
            context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) != PackageManager.PERMISSION_GRANTED
        ) numbersLauncher.launch(Manifest.permission.READ_PHONE_NUMBERS)
    }

    LaunchedEffect(checkKey, numbersAsked) {
        missing = runCatching { missingNumbers(context, api.deviceSims().sims.associateBy { it.key }) }.getOrDefault(emptyList())
            .filterNot { it.key in dismissed }
    }
    val sim = missing.firstOrNull() ?: return
    val name = buildString {
        append(if (sim.slot >= 0) "SIM ${sim.slot + 1}" else "This SIM")
        sim.carrier?.let { append(" ($it)") }
    }

    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("What's the number of $name?", style = MaterialTheme.typography.titleSmall)
            Text("Your calls will show which of your numbers they were made from.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(
                value = input,
                onValueChange = { input = it; error = null },
                singleLine = true,
                placeholder = { Text("98xxxxxxxx") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                isError = error != null,
                supportingText = error?.let { { Text(it) } },
                modifier = Modifier.fillMaxWidth(),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { dismissed += sim.key; missing = missing.drop(1); input = "" }) { Text("Later") }
                Button(enabled = !busy && input.count(Char::isDigit) >= 10, onClick = {
                    scope.launch {
                        busy = true
                        try {
                            api.setSimNumber(sim.key, input.trim())
                            missing = missing.drop(1)
                            input = ""
                        } catch (e: ApiException) {
                            error = e.message ?: "Couldn't save"
                        } catch (e: Exception) {
                            error = "Couldn't save. Check your connection."
                        } finally {
                            busy = false
                        }
                    }
                }) { Text("Save") }
            }
        }
    }
}

/** SIMs skipped with "Later" in this app session. */
private val dismissed = mutableSetOf<String>()

private suspend fun missingNumbers(context: Context, server: Map<String, com.usaindiacfo.uicdialer.data.api.DeviceSimDto>): List<Sim> =
    withContext(Dispatchers.IO) { SimInfo.active(context) }.filter { s -> server[s.key]?.number == null && s.number == null }
