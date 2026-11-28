package com.usaindiacfo.uicdialer.ui.calls

import android.text.format.DateUtils
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.paging.LoadState
import androidx.paging.compose.LazyPagingItems
import androidx.paging.compose.collectAsLazyPagingItems
import androidx.paging.compose.itemKey
import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.widget.Toast
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.usaindiacfo.uicdialer.AppContainer
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.CallFilter
import java.time.LocalDate
import kotlinx.coroutines.launch
import com.usaindiacfo.uicdialer.data.api.ApiException
import com.usaindiacfo.uicdialer.data.api.CallStatus
import com.usaindiacfo.uicdialer.data.api.Direction

/** The Calls tab: the phone's own call log ("My phone") and server calls ("Recorded") behind one switch. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun CallsTab(onOpenCall: (id: String) -> Unit, onOpenContact: (phone: String) -> Unit) {
    var recorded by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        androidx.compose.material3.SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
            listOf("My phone", "Recorded").forEachIndexed { i, label ->
                SegmentedButton(
                    selected = recorded == (i == 1),
                    onClick = { recorded = i == 1 },
                    shape = androidx.compose.material3.SegmentedButtonDefaults.itemShape(i, 2),
                ) { Text(label) }
            }
        }
        if (recorded) CallsScreen(onOpenCall)
        else com.usaindiacfo.uicdialer.ui.recents.RecentsScreen(onOpenContact = onOpenContact)
    }
}

@Composable
fun CallsScreen(onOpenCall: (id: String) -> Unit) {
    val container = appContainer()
    val vm: CallsViewModel = viewModel(factory = viewModelFactory { initializer { CallsViewModel(container) } })
    val filter by vm.filter.collectAsStateWithLifecycle()
    val user by vm.user.collectAsStateWithLifecycle()
    val people by vm.people.collectAsStateWithLifecycle()
    val items = vm.calls.collectAsLazyPagingItems()
    com.usaindiacfo.uicdialer.dialer.LiveRefresh("calls", "activity") { items.refresh() }
    val cached = vm.cached.collectAsLazyPagingItems()
    val showPerson = user?.canManage == true
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val refresh = items.loadState.refresh
    val offline = refresh is LoadState.Error && items.itemCount == 0 && refresh.error !is ApiException
    // First load: show the last saved list at once (only when unfiltered, since the cache is unfiltered).
    val warming = refresh is LoadState.Loading && items.itemCount == 0 && cached.itemCount > 0 && filter.toApi() == CallFilter()
    val list = if (offline || warming) cached else items

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = if (showPerson) 4.dp else 16.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        // Local text so typing never waits on the filter flow (dropped letters, cursor jumps).
        var search by remember { mutableStateOf(filter.search) }
        // Follow changes made elsewhere (e.g. "Clear filters"); the VM's current value is never stale.
        androidx.compose.runtime.LaunchedEffect(filter.search) { vm.filter.value.search.let { if (it != search) search = it } }
        OutlinedTextField(
            value = search,
            onValueChange = { search = it; vm.setSearch(it) },
            modifier = Modifier.weight(1f),
            placeholder = { Text("Name, company, number or words said") },
            leadingIcon = { Icon(Icons.Default.Search, null) },
            trailingIcon = {
                if (search.isNotEmpty()) IconButton(onClick = { search = ""; vm.setSearch("") }) { Icon(Icons.Default.Clear, "Clear search") }
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        )
        // Managers / admins: CSV of the current filters, saved to Downloads (the server audit-logs it). Rarely used, so in a menu.
        if (showPerson) Box {
            var more by remember { mutableStateOf(false) }
            IconButton(onClick = { more = true }) { Icon(Icons.Default.MoreVert, "More") }
            DropdownMenu(more, { more = false }) {
                DropdownMenuItem({ Text("Export to CSV") }, { more = false; scope.launch { exportCsv(context, container, filter.toApi()) } })
            }
        }
        }
        FilterRow(filter, vm, showPerson, people.map { it.id to (it.name ?: it.email) })

        if (offline) Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Offline: showing recent calls", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = items::retry) { Text("Retry") }
            }
        }

        PullToRefreshBox(
            isRefreshing = items.loadState.refresh is LoadState.Loading && (items.itemCount > 0 || warming),
            onRefresh = items::refresh,
            modifier = Modifier.fillMaxSize(),
        ) {
            when {
                refresh is LoadState.Loading && list.itemCount == 0 ->
                    Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                refresh is LoadState.Error && list.itemCount == 0 ->
                    Message(refresh.error.message ?: "Could not load calls", "Retry", items::retry)
                refresh is LoadState.NotLoading && list.itemCount == 0 ->
                    Message("No calls found", null) {}
                else -> CallList(list, showPerson, onOpenCall, appendError = !offline && !warming && items.loadState.append is LoadState.Error, onRetry = items::retry)
            }
        }
    }
}

@Composable
private fun FilterRow(f: CallsFilterState, vm: CallsViewModel, showPerson: Boolean, people: List<Pair<String, String>>) {
    var dirOpen by remember { mutableStateOf(false) }
    var dateOpen by remember { mutableStateOf(false) }
    var personOpen by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box {
            FilterChip(f.direction != null, { dirOpen = true }, { Text(f.direction?.label() ?: "Direction") })
            DropdownMenu(dirOpen, { dirOpen = false }) {
                DropdownMenuItem({ Text("All directions") }, { vm.setDirection(null); dirOpen = false })
                Direction.entries.filter { it != Direction.UNKNOWN }.forEach { d -> DropdownMenuItem({ Text(d.label()) }, { vm.setDirection(d); dirOpen = false }) }
            }
        }
        Box {
            FilterChip(f.date != DatePreset.ALL, { dateOpen = true }, { Text(f.date.label) })
            DropdownMenu(dateOpen, { dateOpen = false }) {
                DatePreset.entries.forEach { p -> DropdownMenuItem({ Text(p.label) }, { vm.setDate(p); dateOpen = false }) }
            }
        }
        if (showPerson) Box {
            FilterChip(f.userId != null, { personOpen = true }, {
                Text(people.firstOrNull { it.first == f.userId }?.second ?: "Person", maxLines = 1, overflow = TextOverflow.Ellipsis)
            })
            DropdownMenu(personOpen, { personOpen = false }) {
                DropdownMenuItem({ Text("Everyone") }, { vm.setUser(null); personOpen = false })
                people.forEach { (id, name) -> DropdownMenuItem({ Text(name) }, { vm.setUser(id); personOpen = false }) }
            }
        }
        if (f.search.isNotEmpty() || f.direction != null || f.date != DatePreset.ALL || f.userId != null) {
            IconButton(onClick = vm::clearFilters) { Icon(Icons.Default.Close, "Clear filters") }
        }
    }
}

/** Queues the CSV in the system DownloadManager with a fresh access token (same as recording downloads). */
private suspend fun exportCsv(context: Context, container: AppContainer, filter: CallFilter) {
    runCatching { container.apiClient.me() }
    val token = container.tokenStore.accessToken
    if (token == null) {
        Toast.makeText(context, "Sign in again to export.", Toast.LENGTH_SHORT).show()
        return
    }
    val name = "calls-${LocalDate.now()}.csv"
    val req = DownloadManager.Request(Uri.parse(container.apiClient.exportUrl(filter)))
        .addRequestHeader("Authorization", "Bearer $token")
        .setTitle("Calls export")
        .setMimeType("text/csv")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
    runCatching { context.getSystemService(DownloadManager::class.java).enqueue(req) }
        .onSuccess { Toast.makeText(context, "Exporting to Downloads/$name", Toast.LENGTH_SHORT).show() }
        .onFailure { Toast.makeText(context, "Export failed: ${it.message}", Toast.LENGTH_LONG).show() }
}

@Composable
private fun CallList(
    items: LazyPagingItems<CallRow>,
    showPerson: Boolean,
    onOpenCall: (String) -> Unit,
    appendError: Boolean,
    onRetry: () -> Unit,
) {
    LazyColumn(Modifier.fillMaxSize()) {
        items(items.itemCount, key = items.itemKey { it.id }, contentType = { "call" }) { i ->
            val row = items[i]
            // Day header above the first call of each day (peek: no extra page loads).
            val prev = if (i > 0) items.peek(i - 1) else null
            if (row != null && (prev == null || dayOf(prev.startedAtMs) != dayOf(row.startedAtMs))) DayHeader(row.startedAtMs)
            else HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            row?.let { CallRowItem(it, showPerson) { onOpenCall(it.id) } }
        }
        if (items.loadState.append is LoadState.Loading) item(key = "loading", contentType = "footer") {
            Box(Modifier.fillMaxWidth().padding(16.dp), Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
        }
        if (appendError) item(key = "error", contentType = "footer") {
            Box(Modifier.fillMaxWidth().padding(8.dp), Alignment.Center) { TextButton(onClick = onRetry) { Text("Load more failed. Retry") } }
        }
    }
}

private fun dayOf(ms: Long): LocalDate = java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault()).toLocalDate()

@Composable
private fun DayHeader(ms: Long) {
    val context = LocalContext.current
    val day = dayOf(ms)
    val today = LocalDate.now()
    val label = when (day) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> DateUtils.formatDateTime(context, ms, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_WEEKDAY or DateUtils.FORMAT_ABBREV_ALL)
    }
    Text(
        label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
    )
}

@Composable
private fun CallRowItem(row: CallRow, showPerson: Boolean, onClick: () -> Unit) {
    val context = LocalContext.current
    ListItem(
        modifier = Modifier.clickable(onClick = onClick),
        colors = androidx.compose.material3.ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.background),
        leadingContent = { DirectionIcon(row.direction) },
        // Name on top, number under it (title is the number itself when there is no name).
        headlineContent = { Text(row.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Column {
                row.subtitle?.let { Text(it, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                val parts = listOfNotNull(
                    DateUtils.formatDateTime(context, row.startedAtMs, DateUtils.FORMAT_SHOW_TIME),
                    row.durationS?.takeIf { it > 0 }?.let(::formatDuration),
                    row.person.takeIf { showPerson },
                )
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                    )
                    // Small grey mark when the words of the call are ready to read.
                    if (row.status == CallStatus.TRANSCRIBED) Icon(
                        Icons.AutoMirrored.Filled.List, "Has transcript",
                        tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(14.dp),
                    )
                }
            }
        },
        trailingContent = {
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                StatusBadge(row.status, row.logType, row.direction, row.durationS)
                com.usaindiacfo.uicdialer.ui.dialer.ViaChip(row.via)
            }
        },
    )
}

@Composable
internal fun DirectionIcon(d: Direction) {
    val (icon, rot, tint) = when (d) {
        Direction.INCOMING -> Triple(Icons.AutoMirrored.Filled.ArrowBack, -45f, MaterialTheme.colorScheme.primary)
        Direction.OUTGOING -> Triple(Icons.AutoMirrored.Filled.ArrowForward, -45f, MaterialTheme.colorScheme.tertiary)
        Direction.MISSED -> Triple(Icons.Default.Close, 0f, MaterialTheme.colorScheme.error)
        Direction.UNKNOWN -> Triple(Icons.Default.Call, 0f, MaterialTheme.colorScheme.outline)
    }
    Icon(icon, d.label(), tint = tint, modifier = Modifier.rotate(rot))
}

@Composable
internal fun StatusBadge(s: CallStatus, logType: String? = null, direction: Direction? = null, durationS: Int? = null) {
    val cs = MaterialTheme.colorScheme
    val text = CallStatusText.of(s, logType, direction, durationS)
    val (bg, fg) = when (text.tone) {
        StatusTone.GOOD -> cs.primaryContainer to cs.onPrimaryContainer
        StatusTone.BAD -> cs.errorContainer to cs.onErrorContainer
        StatusTone.INFO, StatusTone.BUSY -> cs.secondaryContainer to cs.onSecondaryContainer
        StatusTone.NEUTRAL -> cs.surfaceVariant to cs.onSurfaceVariant
    }
    Surface(color = bg, contentColor = fg, shape = MaterialTheme.shapes.small) {
        Text(text.label, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
    }
}

@Composable
private fun Message(text: String, action: String?, onAction: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), Arrangement.Center, Alignment.CenterHorizontally) {
        Text(text, color = Color.Unspecified, style = MaterialTheme.typography.bodyLarge)
        if (action != null) { Spacer(Modifier.width(8.dp)); Button(onClick = onAction, Modifier.padding(top = 12.dp)) { Text(action) } }
    }
}

internal fun Direction.label() = name.lowercase().replaceFirstChar { it.uppercase() }

internal fun CallStatus.label() = CallStatusText.of(this).label

internal fun formatDuration(s: Int): String = if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
