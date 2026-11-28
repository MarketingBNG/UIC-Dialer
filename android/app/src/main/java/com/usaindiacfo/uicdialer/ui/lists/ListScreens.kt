package com.usaindiacfo.uicdialer.ui.lists

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.ListItemDto
import com.usaindiacfo.uicdialer.data.api.MyCallList
import com.usaindiacfo.uicdialer.data.api.ScriptDto
import com.usaindiacfo.uicdialer.ui.dialer.Avatar
import com.usaindiacfo.uicdialer.ui.dialer.ColorDot
import com.usaindiacfo.uicdialer.ui.dialer.friendlyError
import com.usaindiacfo.uicdialer.ui.dialer.rememberCaller
import com.usaindiacfo.uicdialer.ui.dialer.title
import com.usaindiacfo.uicdialer.ui.common.EmptyState
import com.usaindiacfo.uicdialer.ui.common.Pill
import com.usaindiacfo.uicdialer.ui.common.PillTone
import com.usaindiacfo.uicdialer.ui.theme.UicColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException

/** "Call lists": the rep's ACTIVE and PAUSED lists. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListsScreen(onOpenList: (id: String) -> Unit, onBack: () -> Unit) {
    val c = appContainer()
    val scope = rememberCoroutineScope()
    // Start from the last saved lists so the screen opens instantly; refresh in the background.
    var lists by remember { mutableStateOf<List<MyCallList>?>(c.contactCache.myLists?.items) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun load() = scope.launch {
        loading = true
        try {
            val fresh = c.apiClient.myCallLists()
            lists = fresh.items
            c.contactCache.myLists = fresh
            error = null
        } catch (e: IOException) {
            error = friendlyError(e)
        }
        loading = false
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { load() }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Call lists", fontWeight = FontWeight.SemiBold) },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
        )
        if (loading && lists == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp)) }
        if (lists?.isEmpty() == true) {
            EmptyState(Icons.Filled.Call, "No call lists yet", text = "Lists your manager gives you show up here.")
        }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(lists.orEmpty(), key = { it.id }) { l ->
                Card(
                    Modifier.fillMaxWidth().clickable { onOpenList(l.id) },
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                ) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(l.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            if (l.state == "PAUSED") Pill("Paused", PillTone.WARNING)
                        }
                        l.createdBy?.let { Text("Assigned by ${it.name ?: it.email}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        Row {
                            Text(ListSessionLogic.progressText(l.progress), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Text(ListSessionLogic.resultsText(l.results), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        LinearProgressIndicator(progress = { ListSessionLogic.fraction(l.progress) }, modifier = Modifier.fillMaxWidth())
                    }
                }
            }
        }
    }
}

/** Power-dial session (PowerDial mockup): next contact, Call now / Skip / Details, the script, auto-advance. */
@Composable
fun ListSessionScreen(listId: String, onBack: () -> Unit, onOpenContact: (phone: String) -> Unit) {
    val c = appContainer()
    val vm: ListSessionViewModel = viewModel(key = "list-$listId", factory = viewModelFactory { initializer { ListSessionViewModel(c, listId) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val call = rememberCaller()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.onResume() }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        // Header
        Card(
            shape = androidx.compose.foundation.shape.RoundedCornerShape(0.dp),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.fillMaxWidth().padding(start = 4.dp, end = 16.dp, top = 8.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                    Column(Modifier.weight(1f)) {
                        Text(
                            "Call list" + (state.list?.createdBy?.let { " · assigned by ${it.name?.substringBefore(' ') ?: it.email}" } ?: ""),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(state.list?.name ?: "Call list", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    }
                    OutlinedButton(onClick = { vm.pause(onBack) }, modifier = Modifier.heightIn(min = 40.dp)) { Text("Pause") }
                }
                Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row {
                        Text(ListSessionLogic.progressText(state.progress), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        Text(ListSessionLogic.resultsText(state.results), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    LinearProgressIndicator(progress = { ListSessionLogic.fraction(state.progress) }, modifier = Modifier.fillMaxWidth().heightIn(min = 8.dp))
                }
            }
        }

        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            when (state.phase) {
                SessionPhase.LOADING -> LinearProgressIndicator(Modifier.fillMaxWidth())
                SessionPhase.PAUSED -> Message("This list is paused by your admin", "You can come back to it once it is active again.")
                SessionPhase.NOT_ASSIGNED -> Message("This list isn't assigned to you", "Ask your manager to add you to it.")
                SessionPhase.EMPTY -> DoneCard(state)
                SessionPhase.ERROR -> {
                    Message("Couldn't load the next number", null)
                    Button(onClick = { vm.next() }) { Text("Try again") }
                }
                else -> state.item?.let { item ->
                    NextUpCard(
                        item = item,
                        waiting = state.phase == SessionPhase.WAIT_SYNC,
                        offline = state.offline,
                        autoDial = state.autoDial,
                        onCancelAutoDial = vm::cancelAutoDial,
                        onCall = {
                            call(item.contact.phoneE164, dnc = item.contact.dnc, callListItemId = item.id, onSkip = { vm.skip() }, onDialed = vm::onDialed)
                        },
                        onSkip = { vm.skip() },
                        onDetails = { onOpenContact(item.contact.phoneE164) },
                    )
                }
            }
            state.list?.script?.let { ScriptCard(it) }
        }
    }
}

@Composable
private fun Message(title: String, body: String?) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            body?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@Composable
private fun DoneCard(state: ListSessionState) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("All done", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = UicColors.callGreen)
            Text(ListSessionLogic.progressText(state.progress), color = MaterialTheme.colorScheme.onSurfaceVariant)
            state.results.filter { it.count > 0 }.sortedByDescending { it.count }.forEach { r ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ColorDot(r.color)
                    Text(r.label, modifier = Modifier.weight(1f))
                    Text("${r.count}", fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
private fun NextUpCard(
    item: ListItemDto, waiting: Boolean, offline: Boolean, autoDial: Boolean,
    onCancelAutoDial: () -> Unit, onCall: () -> Unit, onSkip: () -> Unit, onDetails: () -> Unit,
) {
    val ct = item.contact
    // 5 s countdown before auto-dialling the next contact; restarts per contact, stops on Cancel/Skip.
    var secondsLeft by remember(item.id, autoDial) { mutableIntStateOf(AUTO_DIAL_SECONDS) }
    LaunchedEffect(item.id, autoDial, waiting) {
        if (!autoDial || waiting) return@LaunchedEffect
        while (secondsLeft > 0) { delay(1000); secondsLeft-- }
        // Clear the flag first so a blocked dial (DNC prompt, no permission) doesn't leave "in 0s" on screen.
        onCancelAutoDial()
        onCall()
    }
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.fillMaxWidth().padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Next up · #${item.position + 1}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
            Avatar(ct.name, size = 60.dp)
            Text(ct.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            val sub = listOfNotNull(ct.company?.takeIf { it.isNotBlank() }, ct.city?.takeIf { it.isNotBlank() }, ct.phoneE164.takeIf { !ct.name.isNullOrBlank() }).joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (ct.dnc != null) Pill("Do not call", PillTone.DANGER)
            item.lastOutcome?.let { o ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ColorDot(o.color)
                    Text("Last: ${o.label} · attempt ${item.attempts + 1}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (waiting) {
                Text(
                    if (offline) "Waiting for network. The outcome is saved; the next number loads once it is sent." else "Saving outcome…",
                    style = MaterialTheme.typography.bodySmall, color = UicColors.amber,
                )
            }
            Button(
                onClick = onCall,
                enabled = !waiting,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                colors = ButtonDefaults.buttonColors(containerColor = UicColors.callGreen, contentColor = Color.White),
            ) {
                Icon(Icons.Filled.Call, contentDescription = null)
                Text("Call ${ct.name?.takeIf { it.isNotBlank() }?.substringBefore(' ') ?: "now"}", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 8.dp))
            }
            if (autoDial && !waiting) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Calling ${ct.name?.takeIf { it.isNotBlank() }?.substringBefore(' ') ?: ct.phoneE164} in ${secondsLeft}s", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(" · ", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    TextButton(onClick = onCancelAutoDial, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                TextButton(onClick = onSkip, enabled = !waiting, modifier = Modifier.heightIn(min = 48.dp)) { Text("Skip", style = MaterialTheme.typography.bodyMedium) }
                TextButton(onClick = { onCancelAutoDial(); onDetails() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Details", style = MaterialTheme.typography.bodyMedium) }
            }
        }
    }
}

@Composable
private fun ScriptCard(script: ScriptDto) {
    if (script.sections.isEmpty()) return
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Script · ${script.name}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            script.sections.forEach { s ->
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(s.heading.uppercase() + ": ") }
                        append(s.text)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

private const val AUTO_DIAL_SECONDS = 5
