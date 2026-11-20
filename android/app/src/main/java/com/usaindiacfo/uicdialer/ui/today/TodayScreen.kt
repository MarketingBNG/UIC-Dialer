package com.usaindiacfo.uicdialer.ui.today

import android.text.format.DateUtils
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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.dialer.DialLogic
import com.usaindiacfo.uicdialer.dialer.Dialer
import com.usaindiacfo.uicdialer.ui.dialer.Avatar
import com.usaindiacfo.uicdialer.ui.dialer.Chip
import com.usaindiacfo.uicdialer.ui.dialer.GreenCallButton
import com.usaindiacfo.uicdialer.ui.dialer.StatusChip
import com.usaindiacfo.uicdialer.ui.dialer.rememberCaller
import com.usaindiacfo.uicdialer.ui.setup.SetupChecks
import com.usaindiacfo.uicdialer.ui.theme.UicColors
import com.usaindiacfo.uicdialer.update.UpdateBanner
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun TodayScreen(onOpenContact: (phone: String) -> Unit, onOpenSetup: () -> Unit, onOpenLists: () -> Unit = {}) {
    val container = appContainer()
    val vm: TodayViewModel = viewModel(factory = viewModelFactory { initializer { TodayViewModel(container) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val user by container.authRepository.currentUser.collectAsStateWithLifecycle()
    var resumeTick by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { resumeTick++; vm.refresh() }
    val setupOk = remember(resumeTick) { SetupChecks.requiredGranted(context) }
    val notifOk = remember(resumeTick) { com.usaindiacfo.uicdialer.reminders.Notifications.canNotify(context) }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item(key = "update") { UpdateBanner(checkKey = resumeTick / 10) } // re-check occasionally
        if (!setupOk) item(key = "setup") {
            Card(
                Modifier.fillMaxWidth().clickable(onClick = onOpenSetup),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
            ) {
                Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Setup needs attention: calls can't be synced.", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = onOpenSetup) { Text("Fix") }
                }
            }
        }
        if (!notifOk) item(key = "notif") {
            Card(Modifier.fillMaxWidth().clickable(onClick = onOpenSetup)) {
                Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Notifications are off, so you won't get follow-up reminders.", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    TextButton(onClick = onOpenSetup) { Text("Turn on") }
                }
            }
        }
        item(key = "head") {
            Column {
                Text(
                    LocalDate.now(DialLogic.IST).format(DateTimeFormatter.ofPattern("EEEE, d MMM", Locale.ENGLISH)),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    greeting() + (user?.name?.substringBefore(' ')?.takeIf { it.isNotBlank() }?.let { ", $it" } ?: ""),
                    style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold,
                )
            }
        }
        item(key = "counts") {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CountCard(state.overdue.size, "Overdue", UicColors.overdue, Modifier.weight(1f))
                CountCard(state.today.size, "Due today", MaterialTheme.colorScheme.primary, Modifier.weight(1f))
            }
        }
        state.me?.let { me -> item(key = "targets") { TargetsCard(me) } }
        if (state.lists.isNotEmpty()) item(key = "lists") {
            Card(
                Modifier.fillMaxWidth().clickable(onClick = onOpenLists),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("My call lists (${state.lists.size})", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        val left = state.lists.sumOf { it.progress.pending + it.progress.inProgress }
                        Text("$left numbers to call", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    TextButton(onClick = onOpenLists) { Text("Open") }
                }
            }
        }
        if (state.loading) item(key = "loading") { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        state.error?.let { item(key = "error") { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) } }
        if (state.overdue.isEmpty() && state.today.isEmpty() && !state.loading) item(key = "empty") {
            Text(
                "Nothing due today. Follow-ups you set after a call show up here.",
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp),
            )
        }
        if (state.overdue.isNotEmpty()) item(key = "h-overdue") { SectionLabel("OVERDUE", UicColors.overdue) }
        items(state.overdue, key = { it.key }) { row -> TodayRowCard(row, vm, onOpenContact) }
        if (state.today.isNotEmpty()) item(key = "h-today") { SectionLabel("LATER TODAY", MaterialTheme.colorScheme.onSurfaceVariant) }
        items(state.today, key = { it.key }) { row -> TodayRowCard(row, vm, onOpenContact) }
    }
}

private fun greeting(): String = when (LocalTime.now(DialLogic.IST).hour) {
    in 0..11 -> "Good morning"
    in 12..16 -> "Good afternoon"
    else -> "Good evening"
}

@Composable
private fun CountCard(n: Int, label: String, color: Color, modifier: Modifier) {
    Card(modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp)) {
            Text(n.toString(), style = MaterialTheme.typography.headlineMedium, color = color, fontWeight = FontWeight.SemiBold)
            Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SectionLabel(text: String, color: Color) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = color, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
}

@Composable
private fun TodayRowCard(row: TodayRow, vm: TodayViewModel, onOpenContact: (String) -> Unit) {
    val context = LocalContext.current
    val call = rememberCaller()
    val missed = row.kind == TodayKind.MISSED_CALL
    val lead = row.kind == TodayKind.NEW_LEAD
    val due = DateUtils.formatDateTime(context, row.dueAtMs, DateUtils.FORMAT_SHOW_TIME or DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH)
    Card(
        Modifier.fillMaxWidth().clickable { onOpenContact(row.phoneE164) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Avatar(row.name)
                Column(Modifier.weight(1f)) {
                    Text(row.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val sub = listOfNotNull(row.company?.takeIf { it.isNotBlank() }, row.lastNote?.takeIf { it.isNotBlank() }).joinToString(" · ")
                    if (sub.isNotEmpty()) {
                        Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text(
                        (if (row.overdue) "Overdue · " else "Due ") + due,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (row.overdue) UicColors.overdue else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (!missed && !lead) GreenCallButton(onClick = { call(row.phoneE164) })
            }
            if (missed || lead || row.status != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (missed) Chip("Missed call", MaterialTheme.colorScheme.errorContainer, UicColors.overdue)
                    if (lead) Chip("New lead" + (row.source?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""), Color(0xFFDDF3E4), Color(0xFF166534))
                    row.status?.let { StatusChip(it) }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (missed) OutlinedButton(onClick = { call(row.phoneE164) }, Modifier.heightIn(min = 48.dp)) { Text("Call back") }
                if (lead) OutlinedButton(onClick = { call(row.phoneE164) }, Modifier.heightIn(min = 48.dp)) { Text("Call now") }
                OutlinedButton(
                    onClick = { if (Dialer.whatsApp(context, row.phoneE164)) vm.logWhatsApp(row.phoneE164) },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("WhatsApp") }
                if (missed || lead) TextButton(onClick = { vm.markDone(row) }, Modifier.heightIn(min = 48.dp)) { Text("Done") }
            }
        }
    }
}

/**
 * "Today: 14 / 40 calls · 40 / 60 talk min" with a bar per target; without targets only the counts show.
 */
@Composable
private fun TargetsCard(me: com.usaindiacfo.uicdialer.data.api.MeToday) {
    val talkMin = me.talkTimeS / 60
    val callsTarget = me.target.callsPerDay
    val talkTarget = me.target.talkMinPerDay
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "Today: " + (if (callsTarget != null) "${me.calls} / $callsTarget calls" else "${me.calls} calls") +
                    " · " + (if (talkTarget != null) "$talkMin / $talkTarget talk min" else "$talkMin talk min"),
                style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
            )
            if (callsTarget != null) TargetBar("Calls", me.progress.callsPct)
            if (talkTarget != null) TargetBar("Talk time", me.progress.talkPct)
            if (callsTarget == null && talkTarget == null) {
                Text("${me.connected} connected · ${me.messages} messages", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun TargetBar(label: String, pct: Int?) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("$label ${pct ?: 0}%", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        LinearProgressIndicator(
            progress = { ((pct ?: 0) / 100f).coerceIn(0f, 1f) },
            modifier = Modifier.fillMaxWidth(),
            color = if ((pct ?: 0) >= 100) UicColors.callGreen else MaterialTheme.colorScheme.primary,
        )
    }
}
