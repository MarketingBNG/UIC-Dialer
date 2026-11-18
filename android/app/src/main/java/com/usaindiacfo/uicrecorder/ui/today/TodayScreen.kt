package com.usaindiacfo.uicrecorder.ui.today

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
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.dialer.DialLogic
import com.usaindiacfo.uicrecorder.dialer.Dialer
import com.usaindiacfo.uicrecorder.ui.dialer.Avatar
import com.usaindiacfo.uicrecorder.ui.dialer.Chip
import com.usaindiacfo.uicrecorder.ui.dialer.GreenCallButton
import com.usaindiacfo.uicrecorder.ui.dialer.StatusChip
import com.usaindiacfo.uicrecorder.ui.dialer.rememberCaller
import com.usaindiacfo.uicrecorder.ui.setup.SetupChecks
import com.usaindiacfo.uicrecorder.ui.theme.UicColors
import com.usaindiacfo.uicrecorder.update.UpdateBanner
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

@Composable
fun TodayScreen(onOpenContact: (phone: String) -> Unit, onOpenSetup: () -> Unit) {
    val container = appContainer()
    val vm: TodayViewModel = viewModel(factory = viewModelFactory { initializer { TodayViewModel(container) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val user by container.authRepository.currentUser.collectAsStateWithLifecycle()
    var resumeTick by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { resumeTick++; vm.refresh() }
    val setupOk = remember(resumeTick) { SetupChecks.requiredGranted(context) }
    val notifOk = remember(resumeTick) { com.usaindiacfo.uicrecorder.reminders.Notifications.canNotify(context) }

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
                if (!missed) GreenCallButton(onClick = { call(row.phoneE164) })
            }
            if (missed || row.status != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (missed) Chip("Missed call", MaterialTheme.colorScheme.errorContainer, UicColors.overdue)
                    row.status?.let { StatusChip(it) }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (missed) OutlinedButton(onClick = { call(row.phoneE164) }, Modifier.heightIn(min = 48.dp)) { Text("Call back") }
                OutlinedButton(
                    onClick = { if (Dialer.whatsApp(context, row.phoneE164)) vm.logWhatsApp(row.phoneE164) },
                    modifier = Modifier.heightIn(min = 48.dp),
                ) { Text("WhatsApp") }
                if (missed) TextButton(onClick = { vm.markDone(row) }, Modifier.heightIn(min = 48.dp)) { Text("Done") }
            }
        }
    }
}
