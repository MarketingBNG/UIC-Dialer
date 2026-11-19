package com.usaindiacfo.uicrecorder.ui.dialer

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.DncInfo
import com.usaindiacfo.uicrecorder.dialer.Dialer
import kotlinx.coroutines.launch

/** One app-started dial. [onSkip] is set inside a list session ("Skip" replaces "Call anyway" on a DNC number). */
data class DialRequest(
    val number: String,
    val dnc: DncInfo? = null,
    val callListItemId: String? = null,
    val onSkip: (() -> Unit)? = null,
    /** Called with the dial's clientId once the phone app was opened. */
    val onDialed: (String) -> Unit = {},
)

/** `call(number)` from any screen; every dial passes the do-not-call guard first. */
class Caller internal constructor(private val start: (DialRequest) -> Unit) {
    operator fun invoke(
        number: String,
        dnc: DncInfo? = null,
        callListItemId: String? = null,
        onSkip: (() -> Unit)? = null,
        onDialed: (String) -> Unit = {},
    ) = start(DialRequest(number, dnc, callListItemId, onSkip, onDialed))
}

/**
 * Returns a "call this number" action. The first tap asks for CALL_PHONE so later calls start directly;
 * if the rep refuses, the call falls back to opening the phone's dialer with the number filled in.
 *
 * DncGuard: when the contact carries `dnc` or the number is on the local do-not-call list, an AlertDialog
 * "Do not call" asks first (Cancel / Call anyway, or Cancel / Skip in a list session).
 */
@Composable
fun rememberCaller(): Caller {
    val context = LocalContext.current
    val dncCheck = appContainer().dncCheck
    val scope = rememberCoroutineScope()
    var waiting by remember { mutableStateOf<DialRequest?>(null) }
    var warn by remember { mutableStateOf<DialRequest?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        waiting?.let { r -> Dialer.call(context, r.number, r.callListItemId)?.let(r.onDialed) }
        waiting = null
    }
    val place: (DialRequest) -> Unit = { r ->
        if (context.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) {
            Dialer.call(context, r.number, r.callListItemId)?.let(r.onDialed)
        } else {
            waiting = r
            launcher.launch(Manifest.permission.CALL_PHONE)
        }
    }
    val placeNow by rememberUpdatedState(place)

    warn?.let { r ->
        AlertDialog(
            onDismissRequest = { warn = null },
            title = { Text("Do not call") },
            text = {
                Text(
                    r.dnc?.reason?.takeIf { it.isNotBlank() }?.let { "This number is on the do-not-call list: $it" }
                        ?: "This number is on the do-not-call list.",
                )
            },
            confirmButton = {
                val skip = r.onSkip
                if (skip != null) TextButton(onClick = { warn = null; skip() }) { Text("Skip") }
                else TextButton(onClick = { warn = null; placeNow(r) }) { Text("Call anyway") }
            },
            dismissButton = { TextButton(onClick = { warn = null }) { Text("Cancel") } },
        )
    }

    return remember {
        Caller { r ->
            if (r.dnc != null) warn = r
            else scope.launch { if (dncCheck.isDnc(r.number)) warn = r else placeNow(r) }
        }
    }
}
