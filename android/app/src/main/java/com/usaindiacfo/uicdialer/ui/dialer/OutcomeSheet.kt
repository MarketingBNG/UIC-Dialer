package com.usaindiacfo.uicdialer.ui.dialer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.ActivityType
import com.usaindiacfo.uicdialer.data.api.OutcomeDto
import com.usaindiacfo.uicdialer.dialer.OutcomeLogic
import com.usaindiacfo.uicdialer.dialer.OutcomePrompt
import com.usaindiacfo.uicdialer.data.api.ContactDto
import com.usaindiacfo.uicdialer.detect.CallLogMatcher
import com.usaindiacfo.uicdialer.dialer.DialLogic
import com.usaindiacfo.uicdialer.dialer.DialPrefs
import com.usaindiacfo.uicdialer.dialer.Dialer
import com.usaindiacfo.uicdialer.dialer.PendingDial
import com.usaindiacfo.uicdialer.ui.theme.UicColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** What the sheet asks about: the dial, and what the call log and server know about it. */
private data class OutcomeAsk(
    val dial: PendingDial,
    /** From the call log; null only without call-log permission (otherwise the sheet waits for the row). */
    val durationS: Int?,
    val startedAtMs: Long?,
    val contact: ContactDto?,
)

/**
 * Lives in AppNavigation, above every screen: when the app resumes with a pending dial, reads the call log
 * and asks for the outcome. Saving queues a CALL activity (idempotent by the dial's clientId).
 */
@Composable
fun PendingDialHost() {
    val context = LocalContext.current
    val c = appContainer()
    var tick by remember { mutableIntStateOf(0) }
    var ask by remember { mutableStateOf<OutcomeAsk?>(null) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { tick++ }

    LaunchedEffect(tick) {
        if (tick == 0 || ask != null) return@LaunchedEffect
        val prefs = DialPrefs(context)
        val dial = prefs.pending ?: return@LaunchedEffect
        val now = System.currentTimeMillis()
        if (now - dial.dialedAtMs > Dialer.MAX_PENDING_AGE_MS || dial.dialedAtMs > now + 60_000) {
            prefs.pending = null
            return@LaunchedEffect
        }
        // The call log row is often written a moment after the call screen closes.
        var entry: com.usaindiacfo.uicdialer.detect.CallLogEntry? = null
        val canReadLog = CallLogMatcher.hasPermission(context)
        if (canReadLog) {
            repeat(4) { i ->
                if (entry != null) return@repeat
                if (i > 0) delay(1000)
                entry = withContext(Dispatchers.IO) {
                    DialLogic.matchDial(CallLogMatcher.query(context, dial.dialedAtMs, System.currentTimeMillis()), dial.number, dial.dialedAtMs)
                }
            }
            // No row yet: the call is still live (rep switched back mid-call) or was never placed (backed out of
            // the dialer). Keep the dial pending and ask on a later resume once the row exists; a dial that never
            // happens expires after MAX_PENDING_AGE_MS or is replaced by the next one. Never log a phantom call.
            if (entry == null) return@LaunchedEffect
        }
        if (DialPrefs(context).pending?.clientId != dial.clientId) return@LaunchedEffect // handled meanwhile
        // Only to know whether to ask for a name; don't keep the rep waiting when offline.
        val contact = withTimeoutOrNull(3000) { runCatching { c.apiClient.contactByPhone(dial.number).contact }.getOrNull() }
        ask = OutcomeAsk(dial, entry?.durationS, entry?.dateMs, contact)
    }

    ask?.let { a ->
        OutcomeSheet(a, onDone = { ask = null })
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun OutcomeSheet(a: OutcomeAsk, onDone: () -> Unit) {
    val context = LocalContext.current
    val c = appContainer()
    val repo = c.activityRepository
    val scope = rememberCoroutineScope()
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var defs by remember { mutableStateOf(c.outcomeCatalog.outcomes) }
    var selected by remember { mutableStateOf(OutcomeLogic.defaultFor(a.durationS, defs)) }
    LaunchedEffect(Unit) {
        c.outcomeCatalog.refresh()
        defs = c.outcomeCatalog.outcomes
        selected = selected?.let { s -> defs.firstOrNull { it.id == s.id } ?: s }
    }
    var followUpAt by remember { mutableStateOf<Long?>(null) }
    var note by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var company by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmRemove by remember { mutableStateOf(false) }
    var messageAfter by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
    val askName = a.contact?.name.isNullOrBlank()
    val askCompany = a.contact?.company.isNullOrBlank()

    fun skip() {
        DialPrefs(context).pending = null
        onDone()
    }

    fun save(def: OutcomeDto, withMessage: Boolean, confirmed: Boolean = false) {
        val now = System.currentTimeMillis()
        error = OutcomeLogic.validate(def, followUpAt, now)
        if (error != null) return
        if (OutcomeLogic.prompt(def.ruleEnum) == OutcomePrompt.CONFIRM_REMOVE && !confirmed) {
            messageAfter = withMessage
            confirmRemove = true
            return
        }
        messageAfter = withMessage
        scope.launch {
            repo.log(
                phone = a.dial.number,
                type = ActivityType.CALL,
                occurredAtMs = a.startedAtMs ?: a.dial.dialedAtMs,
                clientId = a.dial.clientId,
                outcome = def.baseOutcome,
                outcomeId = def.id,
                note = note,
                followUpAtMs = OutcomeLogic.followUpFor(def, followUpAt, now),
                durationS = a.durationS,
                name = if (askName) name else null,
                company = if (askCompany) company else null,
                callListItemId = a.dial.callListItemId,
            )
            DialPrefs(context).pending = null
            saved = true
            if (!withMessage) onDone()
        }
    }

    fun choose(def: OutcomeDto) {
        selected = def
        error = null
        if (followUpAt != null && !OutcomeLogic.needsDate(def)) followUpAt = null
        when (OutcomeLogic.prompt(def.ruleEnum)) {
            OutcomePrompt.DATE -> pickFollowUpDate(context, followUpAt) { followUpAt = it; error = null }
            OutcomePrompt.DATE_TIME -> pickFollowUp(context, followUpAt) { followUpAt = it; error = null }
            OutcomePrompt.SAVE_NOW -> save(def, withMessage = false)
            else -> if (OutcomeLogic.needsDate(def)) pickFollowUp(context, followUpAt) { followUpAt = it; error = null }
        }
    }

    // After "Save + message": the outcome is queued; offer the template picker for this number.
    if (saved && messageAfter) {
        TemplatePickerSheet(phone = a.dial.number, contactName = a.contact?.name ?: name.takeIf { it.isNotBlank() }, onDismiss = onDone)
        return
    }

    if (confirmRemove) {
        val def = selected
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text(def?.label ?: "Remove") },
            text = { Text(if (def?.addToDnc == true) "Remove this number from all call lists and mark do-not-call?" else "Remove this number from all call lists?") },
            confirmButton = {
                TextButton(onClick = {
                    confirmRemove = false
                    if (def != null) save(def, messageAfter, confirmed = true)
                }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { confirmRemove = false; messageAfter = false }) { Text("Cancel") } },
        )
    }

    ModalBottomSheet(onDismissRequest = ::skip, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Avatar(a.contact?.name)
                Text("How did the call go?", style = MaterialTheme.typography.titleMedium, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
            }
            Text(
                buildString {
                    append(a.contact?.title ?: a.dial.number)
                    when {
                        a.durationS == null -> append(" · duration unknown")
                        a.durationS == 0 -> append(" · not connected")
                        else -> append(" · ${formatDuration(a.durationS)}")
                    }
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                defs.forEach { d ->
                    FilterChip(
                        selected = selected?.id == d.id, onClick = { choose(d) }, label = { Text(d.label) },
                        leadingIcon = { ColorDot(d.color) },
                        modifier = Modifier.heightIn(min = 48.dp),
                    )
                }
            }
            selected?.let { d ->
                when (OutcomeLogic.prompt(d.ruleEnum)) {
                    OutcomePrompt.RETRY -> Text(
                        d.retryHours?.let { "Retry in $it h" } ?: "Retry later",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutcomePrompt.DATE -> OutlinedButton(onClick = { pickFollowUpDate(context, followUpAt) { followUpAt = it; error = null } }) {
                        Text(followUpAt?.let { "Follow up: ${formatDate(context, it)}" } ?: "Pick follow-up date")
                    }
                    OutcomePrompt.DATE_TIME -> OutlinedButton(onClick = { pickFollowUp(context, followUpAt) { followUpAt = it; error = null } }) {
                        val what = if (d.ruleEnum == com.usaindiacfo.uicdialer.data.api.OutcomeRule.ASK_MEETING) "Meeting" else "Call back"
                        Text(followUpAt?.let { "$what: ${formatWhen(context, it)}" } ?: "Pick ${what.lowercase()} date and time")
                    }
                    else -> if (OutcomeLogic.needsDate(d)) OutlinedButton(onClick = { pickFollowUp(context, followUpAt) { followUpAt = it; error = null } }) {
                        Text(followUpAt?.let { "Call back: ${formatWhen(context, it)}" } ?: "Pick call-back date and time")
                    }
                }
            }
            OutlinedTextField(
                value = note, onValueChange = { note = it.take(2000) },
                label = { Text("Note (optional)") }, modifier = Modifier.fillMaxWidth(), minLines = 2,
            )
            if (askName) OutlinedTextField(name, { name = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Name (optional)") }, singleLine = true)
            if (askCompany) OutlinedTextField(company, { company = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Company (optional)") }, singleLine = true)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, androidx.compose.ui.Alignment.End)) {
                TextButton(onClick = ::skip, modifier = Modifier.heightIn(min = 48.dp)) { Text("Skip") }
                OutlinedButton(
                    modifier = Modifier.heightIn(min = 48.dp),
                    onClick = { selected?.let { save(it, withMessage = true) } ?: run { error = "Choose an outcome" } },
                ) { Text("Save + message") }
                Button(
                    modifier = Modifier.heightIn(min = 48.dp),
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = UicColors.callGreen, contentColor = androidx.compose.ui.graphics.Color.White),
                    onClick = { selected?.let { save(it, withMessage = false) } ?: run { error = "Choose an outcome" } },
                ) { Text("Save") }
            }
        }
    }
}

/** Small colour dot for an outcome ("#RRGGBB"). */
@Composable
fun ColorDot(hex: String?, size: androidx.compose.ui.unit.Dp = 10.dp) {
    val color = OutcomeLogic.parseColor(hex)?.let { androidx.compose.ui.graphics.Color(it) } ?: MaterialTheme.colorScheme.outline
    Box(Modifier.size(size).background(color, CircleShape))
}
