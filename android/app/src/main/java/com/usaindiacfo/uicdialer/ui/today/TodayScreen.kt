package com.usaindiacfo.uicdialer.ui.today

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.MeToday
import com.usaindiacfo.uicdialer.data.api.MyCallList
import com.usaindiacfo.uicdialer.dialer.DialLogic
import com.usaindiacfo.uicdialer.dialer.Dialer
import com.usaindiacfo.uicdialer.ui.dialer.Avatar
import com.usaindiacfo.uicdialer.ui.dialer.Caller
import com.usaindiacfo.uicdialer.ui.dialer.Chip
import com.usaindiacfo.uicdialer.ui.dialer.GreenCallButton
import com.usaindiacfo.uicdialer.ui.dialer.rememberCaller
import com.usaindiacfo.uicdialer.ui.dialer.title
import com.usaindiacfo.uicdialer.ui.dialpadIcon
import com.usaindiacfo.uicdialer.ui.lists.ListSessionLogic
import com.usaindiacfo.uicdialer.ui.lists.ListSessionViewModel
import com.usaindiacfo.uicdialer.ui.lists.SessionPhase
import com.usaindiacfo.uicdialer.ui.setup.SetupChecks
import com.usaindiacfo.uicdialer.ui.theme.UicColors
import com.usaindiacfo.uicdialer.update.UpdateBanner
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale

private const val UP_NEXT_SHOWN = 5

/**
 * Today is the call queue: one big "Next up" card (overdue, due today, then the active call list / new leads)
 * with one Call button; after the outcome is saved the next contact comes up. Below it a short "Up next" list,
 * and a Dial button that opens the keypad.
 */
@Composable
fun TodayScreen(
    onOpenContact: (phone: String) -> Unit,
    onOpenSetup: () -> Unit,
    onOpenLists: () -> Unit = {},
    onOpenKeypad: () -> Unit = {},
) {
    val container = appContainer()
    val vm: TodayViewModel = viewModel(factory = viewModelFactory { initializer { TodayViewModel(container) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val user by container.authRepository.currentUser.collectAsStateWithLifecycle()
    var resumeTick by remember { mutableIntStateOf(0) }
    val setupOk = remember(resumeTick) { SetupChecks.requiredGranted(context) }
    val notifOk = remember(resumeTick) { com.usaindiacfo.uicdialer.reminders.Notifications.canNotify(context) }
    var recordingOff by remember { mutableStateOf(com.usaindiacfo.uicdialer.sync.RecordingCheck.isOff(context)) }
    LaunchedEffect(resumeTick) {
        recordingOff = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            runCatching { com.usaindiacfo.uicdialer.sync.RecordingCheck.run(context) }.getOrDefault(recordingOff)
        }
    }
    val call = rememberCaller()

    // The active call list is folded into the queue. A new key per start, so a stopped session is never reused.
    var activeListId by rememberSaveable { mutableStateOf<String?>(null) }
    var sessionNo by rememberSaveable { mutableIntStateOf(0) }
    val listVm: ListSessionViewModel? = activeListId?.let { id ->
        viewModel(key = "today-list-$id-$sessionNo", factory = viewModelFactory { initializer { ListSessionViewModel(container, id) } })
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { resumeTick++; vm.refresh(); listVm?.onResume() }
    com.usaindiacfo.uicdialer.dialer.LiveRefresh("activity", "followups", "contacts", "lists", "settings") { vm.refresh() }
    val stopList: () -> Unit = {
        listVm?.pause { }
        activeListId = null
    }

    val queue = state.queue
    val head = TodayQueue.head(queue, state.called, hasListItem = listVm != null)
    val upNext = queue.filterNot { head is QueueHead.Row && it.key == head.row.key }
    var showAll by rememberSaveable { mutableStateOf(false) }

    Box(Modifier.fillMaxSize()) {
        // WhatsApp-style: the Dial button shrinks to just the icon while scrolling down the list.
        val listState = androidx.compose.foundation.lazy.rememberLazyListState()
        val fabExpanded by remember { androidx.compose.runtime.derivedStateOf { listState.firstVisibleItemIndex == 0 } }
        LazyColumn(
            Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            item(key = "update") { UpdateBanner(checkKey = resumeTick / 10) } // re-check occasionally
            item(key = "sim") { SimNumberBanner(checkKey = resumeTick / 10) }
            if (!setupOk) item(key = "setup") {
                Banner("Setup needs attention: calls can't be synced.", "Fix", MaterialTheme.colorScheme.errorContainer, onOpenSetup)
            }
            if (recordingOff) item(key = "recording-off") {
                Banner(
                    "Call recording is off. " + com.usaindiacfo.uicdialer.sync.RecordingCheck.TEXT, "Open Phone",
                    MaterialTheme.colorScheme.errorContainer,
                ) { runCatching { context.startActivity(android.content.Intent(android.content.Intent.ACTION_DIAL).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) } }
            }
            if (!notifOk) item(key = "notif") {
                Banner("Notifications are off, so you won't get follow-up reminders.", "Turn on", MaterialTheme.colorScheme.surface, onOpenSetup)
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
                    val toCall = queue.count { it.key !in state.called }
                    Text(
                        if (toCall == 0) "Nothing left in your queue"
                        else "$toCall to call" + (if (state.overdue.isNotEmpty()) " · ${state.overdue.size} overdue" else ""),
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (state.overdue.isNotEmpty()) UicColors.overdue else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            state.me?.let { me -> item(key = "targets") { TargetsCard(me) } }
            if (state.loading) item(key = "loading") { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            state.error?.let { item(key = "error") { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) } }

            item(key = "next") {
                // Next call changes (Done, Snooze, called): the new card rises in as the old one fades.
                AnimatedContent(
                    targetState = head,
                    contentKey = { h -> if (h is QueueHead.Row) h.row.key else h::class },
                    transitionSpec = {
                        (fadeIn(tween(200, delayMillis = 60)) + slideInVertically(tween(250)) { it / 12 }) togetherWith fadeOut(tween(120))
                    },
                    label = "next",
                ) { head ->
                when (head) {
                    is QueueHead.Row -> RowNextUp(head.row, vm, call, onOpenContact)
                    QueueHead.ListItem -> listVm?.let { ListNextUp(it, call, onOpenContact, onStop = stopList) }
                    QueueHead.Empty -> if (!state.loading) EmptyCard()
                }
                }
            }
            if (head is QueueHead.Row && listVm != null) item(key = "list-later") {
                Text(
                    "Your call list continues after these follow-ups.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (listVm == null && state.lists.isNotEmpty()) item(key = "lists") {
                ListStarter(state.lists, onStart = { id -> sessionNo++; activeListId = id }, onOpenLists = onOpenLists)
            }
            if (upNext.isNotEmpty()) item(key = "h-upnext") {
                Text(
                    "UP NEXT", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp),
                )
            }
            val shown = if (showAll) upNext else upNext.take(UP_NEXT_SHOWN)
            items(shown, key = { it.key }) { row -> Box(Modifier.animateItem()) { UpNextRow(row, vm, call, onOpenContact) } }
            if (upNext.size > UP_NEXT_SHOWN) item(key = "more") {
                TextButton(onClick = { showAll = !showAll }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(if (showAll) "Show less" else "Show all (${upNext.size})")
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = onOpenKeypad,
            icon = { Icon(remember { dialpadIcon() }, contentDescription = null) },
            text = { Text("Dial") },
            expanded = fabExpanded,
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

@Composable
private fun Banner(text: String, action: String, color: Color, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick), colors = CardDefaults.cardColors(containerColor = color)) {
        Row(Modifier.padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = onClick, modifier = Modifier.heightIn(min = 48.dp)) { Text(action) }
        }
    }
}

@Composable
private fun EmptyCard() {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("All caught up", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = UicColors.callGreen)
            Text("Follow-ups you set after a call show up here. Tap Dial to call a new number.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** The one label a queue row shows. */
@Composable
private fun QueueLabel(row: TodayRow) {
    val text = TodayQueue.label(row)
    when {
        row.kind == TodayKind.MISSED_CALL || row.overdue -> Chip(text, MaterialTheme.colorScheme.errorContainer, UicColors.overdue)
        row.kind == TodayKind.NEW_LEAD -> Chip(text, Color(0xFFDDF3E4), Color(0xFF166534))
        else -> Chip(text, Color(0xFFDCE7F7), UicColors.primary)
    }
}

@Composable
private fun BigCallButton(enabled: Boolean = true, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
        colors = ButtonDefaults.buttonColors(containerColor = UicColors.callGreen, contentColor = Color.White),
    ) {
        Icon(Icons.Filled.Call, contentDescription = null)
        Text("Call", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(start = 8.dp))
    }
}

/** "⋯" menu: WhatsApp, Done (tasks only), Snooze, plus [extra] entries. */
@Composable
private fun RowMenu(row: TodayRow, vm: TodayViewModel, extra: List<Pair<String, () -> Unit>> = emptyList()) {
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More for ${row.title}") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("WhatsApp") }, onClick = {
                open = false
                if (Dialer.whatsApp(context, row.phoneE164)) vm.logWhatsApp(row.phoneE164)
            })
            if (row.taskIds.isNotEmpty()) DropdownMenuItem(text = { Text(if (row.taskIds.size > 1) "Done (all ${row.taskIds.size})" else "Done") }, onClick = { open = false; vm.markDone(row) })
            DropdownMenuItem(
                text = { Text(if (row.taskIds.isNotEmpty()) "Snooze 1 hour" else "Snooze (move to end)") },
                onClick = { open = false; vm.snooze(row) },
            )
            extra.forEach { (label, action) -> DropdownMenuItem(text = { Text(label) }, onClick = { open = false; action() }) }
        }
    }
}

@Composable
private fun NextUpFrame(caption: String, menu: @Composable () -> Unit, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    caption, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                menu()
            }
            Column(Modifier.padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
        }
    }
}

@Composable
private fun ContactHeader(name: String?, title: String, sub: String?, onClick: () -> Unit, phone: String? = null, label: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(name, size = 52.dp, sharedKey = phone)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            sub?.takeIf { it.isNotBlank() }?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            label()
        }
    }
}

@Composable
private fun RowNextUp(row: TodayRow, vm: TodayViewModel, call: Caller, onOpenContact: (String) -> Unit) {
    NextUpFrame("NEXT UP", menu = { RowMenu(row, vm, listOf("Details" to { onOpenContact(row.phoneE164) })) }) {
        ContactHeader(row.name, row.title, row.company, onClick = { onOpenContact(row.phoneE164) }, phone = row.phoneE164) { QueueLabel(row) }
        row.lastNote?.takeIf { it.isNotBlank() }?.let {
            Text("Last note: $it", style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        BigCallButton { call(row.phoneE164, onDialed = { vm.onCalled(row) }) }
    }
}

@Composable
private fun ListNextUp(vm: ListSessionViewModel, call: Caller, onOpenContact: (String) -> Unit, onStop: () -> Unit) {
    val s by vm.state.collectAsStateWithLifecycle()
    val name = s.list?.name ?: "Call list"
    val caption = "NEXT UP · ${name.uppercase()}" +
        if (s.progress.total > 0) " · ${TodayQueue.listProgress(s.progress.done, s.progress.total)}" else ""
    var menuOpen by remember { mutableStateOf(false) }
    val item = s.item
    NextUpFrame(caption, menu = {
        Box {
            IconButton(onClick = { menuOpen = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More for this call list") }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                if (item != null) {
                    DropdownMenuItem(text = { Text("Skip") }, onClick = { menuOpen = false; vm.skip() })
                    DropdownMenuItem(text = { Text("Details") }, onClick = { menuOpen = false; onOpenContact(item.contact.phoneE164) })
                }
                DropdownMenuItem(text = { Text("Stop this list") }, onClick = { menuOpen = false; onStop() })
            }
        }
    }) {
        LinearProgressIndicator(progress = { ListSessionLogic.fraction(s.progress) }, modifier = Modifier.fillMaxWidth())
        s.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        when (s.phase) {
            SessionPhase.LOADING -> LinearProgressIndicator(Modifier.fillMaxWidth())
            SessionPhase.PAUSED -> ListMessage("This list is paused by your admin.", "Stop", onStop)
            SessionPhase.NOT_ASSIGNED -> ListMessage("This list isn't assigned to you.", "Stop", onStop)
            SessionPhase.EMPTY -> ListMessage("All done: " + ListSessionLogic.progressText(s.progress) + ".", "Close list", onStop)
            SessionPhase.ERROR -> ListMessage("Couldn't load the next number.", "Try again") { vm.next() }
            else -> if (item != null) {
                val ct = item.contact
                ContactHeader(ct.name, ct.title, ct.company, onClick = { onOpenContact(ct.phoneE164) }, phone = ct.phoneE164) {
                    val last = item.lastOutcome
                    when {
                        ct.dnc != null -> Chip("Do not call", MaterialTheme.colorScheme.errorContainer, UicColors.overdue)
                        last != null -> Chip("Last: ${last.label}", Color(0xFFF1F5F9), Color(0xFF475569))
                        else -> Chip("New", Color(0xFFDCE7F7), UicColors.primary)
                    }
                }
                val waiting = s.phase == SessionPhase.WAIT_SYNC
                if (waiting) {
                    Text(
                        if (s.offline) "Waiting for network. The outcome is saved; the next number loads once it is sent." else "Saving outcome…",
                        style = MaterialTheme.typography.bodySmall, color = UicColors.amber,
                    )
                }
                BigCallButton(enabled = !waiting) {
                    call(ct.phoneE164, dnc = ct.dnc, callListItemId = item.id, onSkip = { vm.skip() }, onDialed = vm::onDialed)
                }
                s.list?.script?.takeIf { it.sections.isNotEmpty() }?.let { sc ->
                    Text(
                        "SCRIPT · ${sc.name.uppercase()}", style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    sc.sections.forEach { sec ->
                        Text(
                            buildAnnotatedString {
                                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(sec.heading.uppercase() + ": ") }
                                append(sec.text)
                            },
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ListMessage(text: String, action: String, onAction: () -> Unit) {
    Text(text, style = MaterialTheme.typography.bodyLarge)
    TextButton(onClick = onAction, modifier = Modifier.heightIn(min = 48.dp)) { Text(action) }
}

/** The rep's call lists with a Start button each; starting one folds it into the queue above. */
@Composable
private fun ListStarter(lists: List<MyCallList>, onStart: (String) -> Unit, onOpenLists: () -> Unit) {
    Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 4.dp)) {
            Text("CALL LISTS", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            lists.forEach { l ->
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(l.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val left = l.progress.pending + l.progress.inProgress
                        Text(
                            if (l.state == "PAUSED") "Paused by your admin" else "$left left · ${ListSessionLogic.progressText(l.progress)}",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = { onStart(l.id) }, enabled = l.state != "PAUSED", modifier = Modifier.heightIn(min = 48.dp)) { Text("Start") }
                }
            }
            TextButton(onClick = onOpenLists, modifier = Modifier.heightIn(min = 48.dp)) { Text("All call lists") }
        }
    }
}

@Composable
private fun UpNextRow(row: TodayRow, vm: TodayViewModel, call: Caller, onOpenContact: (String) -> Unit) {
    Card(
        Modifier.fillMaxWidth().clickable { onOpenContact(row.phoneE164) },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Row(
            Modifier.padding(start = 12.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Avatar(row.name, sharedKey = row.phoneE164)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(row.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                row.company?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                QueueLabel(row)
            }
            GreenCallButton(onClick = { call(row.phoneE164, onDialed = { vm.onCalled(row) }) })
            RowMenu(row, vm)
        }
    }
}

private fun greeting(): String = when (LocalTime.now(DialLogic.IST).hour) {
    in 0..11 -> "Good morning"
    in 12..16 -> "Good afternoon"
    else -> "Good evening"
}

/**
 * "Today: 14 / 40 calls · 40 / 60 talk min" with a bar per target; without targets only the counts show.
 */
@Composable
private fun TargetsCard(me: MeToday) {
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
