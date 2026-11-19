package com.usaindiacfo.uicrecorder.ui.dialer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import com.usaindiacfo.uicrecorder.ui.theme.UicColors
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.ActivityDto
import com.usaindiacfo.uicrecorder.data.api.ActivityType
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.dialer.DialLogic
import com.usaindiacfo.uicrecorder.dialer.Dialer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

data class ContactDetailState(
    val loading: Boolean = true,
    val contact: ContactDto? = null,
    val activities: List<ActivityDto> = emptyList(),
    val error: String? = null,
    val message: String? = null,
    val saving: Boolean = false,
    /** On the local hashed do-not-call list (covers contacts the server doesn't know yet). */
    val localDnc: Boolean = false,
)

class ContactDetailViewModel(private val c: AppContainer, val phone: String) : ViewModel() {
    private val _state = MutableStateFlow(ContactDetailState())
    val state: StateFlow<ContactDetailState> = _state.asStateFlow()

    fun load() = viewModelScope.launch {
        _state.update { it.copy(loading = true, localDnc = c.dncCheck.isDnc(phone)) }
        try {
            val r = c.apiClient.contactByPhone(phone)
            _state.update { it.copy(loading = false, contact = r.contact, activities = r.activities, error = null) }
        } catch (e: IOException) {
            _state.update { it.copy(loading = false, error = friendlyError(e)) }
        }
    }

    fun save(name: String, company: String) {
        val id = _state.value.contact?.id ?: return
        viewModelScope.launch {
            _state.update { it.copy(saving = true) }
            try {
                val updated = c.apiClient.patchContact(id, name, company)
                _state.update { it.copy(saving = false, contact = updated, message = "Saved") }
            } catch (e: IOException) {
                _state.update { it.copy(saving = false, message = e.message ?: "Not saved") }
            }
        }
    }

    fun addNote(note: String, followUpAtMs: Long?) = viewModelScope.launch {
        c.activityRepository.log(phone, ActivityType.NOTE, note = note, followUpAtMs = followUpAtMs)
        _state.update { it.copy(message = "Note saved; it syncs when online") }
        delay(2500) // let the worker send it, then show it in the list
        load()
    }

    fun logWhatsApp() = viewModelScope.launch { c.activityRepository.log(phone, ActivityType.WHATSAPP) }

    /** POST /v1/dnc, then refresh the local hashes so every screen warns at once. */
    fun markDnc(reason: String) = viewModelScope.launch {
        try {
            c.apiClient.markDnc(_state.value.contact?.phoneE164 ?: phone, reason)
            c.deviceConfigRepository.syncDnc()
            _state.update { it.copy(message = "Marked do-not-call") }
            load()
        } catch (e: IOException) {
            _state.update { it.copy(message = friendlyError(e)) }
        }
    }
}


@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactDetailScreen(phone: String, onBack: () -> Unit) {
    val container = appContainer()
    val vm: ContactDetailViewModel = viewModel(key = "contact-$phone", factory = viewModelFactory { initializer { ContactDetailViewModel(container, phone) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val call = rememberCaller()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.load() }

    var name by remember { mutableStateOf("") }
    var company by remember { mutableStateOf("") }
    LaunchedEffect(state.contact?.id, state.contact?.name, state.contact?.company) {
        name = state.contact?.name.orEmpty()
        company = state.contact?.company.orEmpty()
    }
    var menu by remember { mutableStateOf(false) }
    var askDnc by remember { mutableStateOf(false) }
    var dncReason by remember { mutableStateOf("") }
    var templates by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var noteFollowUp by remember { mutableStateOf<Long?>(null) }
    val contact = state.contact
    val number = contact?.phoneE164 ?: phone

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Contact") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            actions = {
                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "More") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text("Mark do-not-call") },
                        enabled = state.contact?.dnc == null && !state.localDnc,
                        onClick = { menu = false; dncReason = ""; askDnc = true },
                    )
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
        )
        if (askDnc) AlertDialog(
            onDismissRequest = { askDnc = false },
            title = { Text("Mark do-not-call") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Calls to this number will ask for confirmation, and it is left out of call lists.")
                    OutlinedTextField(dncReason, { dncReason = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Reason") }, singleLine = true)
                }
            },
            confirmButton = { TextButton(onClick = { askDnc = false; vm.markDnc(dncReason) }) { Text("Mark") } },
            dismissButton = { TextButton(onClick = { askDnc = false }) { Text("Cancel") } },
        )
        if (templates) TemplatePickerSheet(phone = number, contactName = contact?.name, onDismiss = { templates = false; vm.load() })
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (contact?.dnc != null || state.localDnc) {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                    Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("Do not call", color = UicColors.overdue, fontWeight = FontWeight.SemiBold)
                        Text(
                            contact?.dnc?.reason?.takeIf { it.isNotBlank() } ?: "This number is on the do-not-call list.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                    }
                }
            }
            // Header: avatar, name, number, status, follow-up, actions
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Avatar(contact?.name, size = 56.dp)
                        Column(Modifier.weight(1f)) {
                            Text(contact?.title ?: phone, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                            val sub = listOfNotNull(
                                number.takeIf { !contact?.name.isNullOrBlank() },
                                contact?.company?.takeIf { it.isNotBlank() },
                                contact?.city?.takeIf { it.isNotBlank() },
                            ).joinToString(" · ")
                            if (sub.isNotEmpty()) Text(sub, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    if (contact != null) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            StatusChip(contact.status)
                            formatWhen(context, contact.nextFollowUpAt)?.let { due ->
                                val overdue = DialLogic.isOverdue(contact.nextFollowUpAt)
                                Text(
                                    if (overdue) "Overdue: $due" else "Follow up: $due",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (overdue) UicColors.overdue else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    contact?.owner?.let {
                        Text("Owner: ${it.name ?: it.email}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { call(number, dnc = contact?.dnc) },
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = UicColors.callGreen, contentColor = Color.White),
                        ) { Text("Call") }
                        OutlinedButton(
                            onClick = { if (Dialer.whatsApp(context, number)) vm.logWhatsApp() },
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) { Text("WhatsApp") }
                        OutlinedButton(
                            onClick = { templates = true },
                            modifier = Modifier.weight(1f).heightIn(min = 48.dp),
                        ) { Text("Message") }
                    }
                }
            }
            if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            state.message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }

            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Add note", style = MaterialTheme.typography.titleSmall)
                    OutlinedTextField(note, { note = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text("Note") }, minLines = 2)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { pickFollowUp(context, noteFollowUp) { noteFollowUp = it } }) {
                            Text(noteFollowUp?.let { "Follow up: ${formatWhen(context, it)}" } ?: "Follow-up (optional)")
                        }
                        if (noteFollowUp != null) TextButton(onClick = { noteFollowUp = null }) { Text("Clear") }
                    }
                    Button(
                        onClick = {
                            vm.addNote(note, noteFollowUp)
                            note = ""
                            noteFollowUp = null
                        },
                        enabled = note.isNotBlank(),
                    ) { Text("Save note") }
                }
            }

            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Activity", style = MaterialTheme.typography.titleSmall)
                    if (state.activities.isEmpty() && !state.loading) Text("Nothing yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    state.activities.forEachIndexed { i, a ->
                        if (i > 0) HorizontalDivider()
                        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (a.outcomeLabel != null) ColorDot(a.outcomeColor)
                                Text(
                                    buildList {
                                        add(if (a.type == ActivityType.WHATSAPP && a.channel == "SMS") "SMS" else a.type.label)
                                        (a.outcomeLabel ?: a.outcome?.label)?.let { add(it) }
                                        formatDuration(a.durationS)?.takeIf { a.type == ActivityType.CALL }?.let(::add)
                                    }.joinToString(" · "),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                if (a.type == ActivityType.CALL) ViaChip(a.viaName)
                            }
                            Text(formatWhen(context, a.occurredAt).orEmpty(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            a.followUpAt?.let { Text("Follow up: ${formatWhen(context, it)}", style = MaterialTheme.typography.labelSmall) }
                            a.note?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                }
            }

            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Details", style = MaterialTheme.typography.titleSmall)
                    if (contact == null) {
                        Text("Name and company can be added after the first call or note.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        OutlinedTextField(name, { name = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)
                        OutlinedTextField(company, { company = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Company") }, singleLine = true)
                        Button(onClick = { vm.save(name, company) }, enabled = !state.saving) { Text("Save details") }
                    }
                }
            }
        }
    }
}
