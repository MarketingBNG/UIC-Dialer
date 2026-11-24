package com.usaindiacfo.uicdialer.ui.recents

import kotlinx.coroutines.flow.flowOn
import android.Manifest
import android.content.Context
import android.text.format.DateUtils
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.usaindiacfo.uicdialer.AppContainer
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.phonebook.CallKind
import com.usaindiacfo.uicdialer.phonebook.DayGroup
import com.usaindiacfo.uicdialer.phonebook.PhoneBook
import com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic
import com.usaindiacfo.uicdialer.phonebook.PhoneContact
import com.usaindiacfo.uicdialer.phonebook.RecentCall
import com.usaindiacfo.uicdialer.phonebook.RecentsFilter
import com.usaindiacfo.uicdialer.ui.dialer.Avatar
import com.usaindiacfo.uicdialer.ui.dialer.formatDate
import com.usaindiacfo.uicdialer.ui.dialer.rememberCaller
import com.usaindiacfo.uicdialer.ui.theme.UicColors
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import java.time.LocalDate
import java.time.ZoneId

data class RecentsState(
    val groups: List<DayGroup> = emptyList(),
    val total: Int = 0,
    val filter: RecentsFilter = RecentsFilter.ALL,
    val query: String = "",
    /** Phone contact names by number key (when the call log has no cached name). */
    val phoneNames: Map<String, String> = emptyMap(),
    /** CRM names by number key (null value = in CRM without a name). */
    val crmNames: Map<String, String?> = emptyMap(),
    val loaded: Boolean = false,
)

@OptIn(ExperimentalCoroutinesApi::class)
class RecentsViewModel(c: AppContainer, app: Context) : ViewModel() {
    private val permTick = MutableStateFlow(0)
    private val filter = MutableStateFlow(RecentsFilter.ALL)
    private val query = MutableStateFlow("")
    private val crm = MutableStateFlow(crmNames(c.contactCache.recent + c.contactCache.followUps))
    private val calls = permTick.flatMapLatest { PhoneBook.recentsFlow(app) }
    private val contacts = permTick.flatMapLatest { PhoneBook.contactsFlow(app) }
    private val cache = c.contactCache

    val state: StateFlow<RecentsState> = combine(calls, contacts, filter, query, crm) { cs, pcs, f, q, crmMap ->
        val phoneNames = names(pcs)
        val nameOf: (String) -> String? = { n -> PhoneBookLogic.numberKey(n)?.let { phoneNames[it] ?: crmMap[it] } }
        val shown = PhoneBookLogic.filterRecents(cs, f, q, nameOf)
        RecentsState(PhoneBookLogic.groupByDay(shown, ZoneId.systemDefault()), cs.size, f, q, phoneNames, crmMap, loaded = true)
    }.flowOn(kotlinx.coroutines.Dispatchers.Default).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), RecentsState())

    fun setFilter(f: RecentsFilter) { filter.value = f }
    fun setQuery(q: String) { query.value = q }
    fun recheck() {
        permTick.value++
        crm.value = crmNames(cache.recent + cache.followUps)
    }

    private fun names(list: List<PhoneContact>): Map<String, String> =
        list.mapNotNull { p -> PhoneBookLogic.numberKey(p.number)?.let { it to p.name } }.toMap()
}

@Composable
fun RecentsScreen(onOpenContact: (phone: String) -> Unit) {
    val container = appContainer()
    val context = LocalContext.current
    val app = context.applicationContext
    val vm: RecentsViewModel = viewModel(factory = viewModelFactory { initializer { RecentsViewModel(container, app) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val call = rememberCaller()
    var hasPerm by remember { mutableStateOf(PhoneBook.has(context, Manifest.permission.READ_CALL_LOG)) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        hasPerm = PhoneBook.has(context, Manifest.permission.READ_CALL_LOG)
        vm.recheck()
    }

    Column(Modifier.fillMaxSize()) {
        if (!hasPerm) {
            PermissionPrompt("Allow call history to see your recent calls here.", Manifest.permission.READ_CALL_LOG) {
                hasPerm = it
                vm.recheck()
            }
            return@Column
        }
        OutlinedTextField(
            value = state.query,
            onValueChange = { vm.setQuery(it.take(100)) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            placeholder = { Text("Search name or number") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            singleLine = true,
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            RecentsFilter.entries.forEach { f ->
                FilterChip(selected = state.filter == f, onClick = { vm.setFilter(f) }, label = { Text(f.label) })
            }
        }
        if (state.loaded && state.groups.isEmpty()) {
            Text(
                if (state.total == 0) "No calls yet." else "No calls match.",
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp),
            )
        }
        val today = LocalDate.now()
        LazyColumn(contentPadding = PaddingValues(bottom = 16.dp)) {
            state.groups.forEach { g ->
                item(key = "day-${g.day}") {
                    Text(
                        PhoneBookLogic.dayLabel(g.day, today) ?: formatDate(context, g.calls.first().dateMs),
                        style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
                    )
                }
                items(g.calls, key = { it.id }) { rc ->
                    val key = PhoneBookLogic.numberKey(rc.number)
                    val phoneName = key?.let { state.phoneNames[it] }
                    val inCrm = key != null && key in state.crmNames
                    val name = rc.name ?: phoneName ?: key?.let { state.crmNames[it] }
                    RecentRow(
                        rc, name, inCrm, savedOnPhone = rc.name != null || phoneName != null,
                        onCall = { if (rc.number.isNotBlank()) call(rc.number) },
                        onOpenCrm = onOpenContact,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecentRow(
    rc: RecentCall, name: String?, inCrm: Boolean, savedOnPhone: Boolean,
    onCall: () -> Unit, onOpenCrm: (String) -> Unit,
) {
    val context = LocalContext.current
    var menu by rememberSaveable { mutableStateOf(false) }
    val missed = rc.kind == CallKind.MISSED || rc.kind == CallKind.REJECTED
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClick = onCall, onLongClick = { menu = true })
            .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(name)
        Column(Modifier.weight(1f)) {
            Text(
                name ?: rc.number.ifBlank { "Private number" },
                style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (missed) UicColors.overdue else MaterialTheme.colorScheme.onSurface,
                fontWeight = if (missed) FontWeight.SemiBold else null,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                KindIcon(rc.kind)
                val time = DateUtils.formatDateTime(context, rc.dateMs, DateUtils.FORMAT_SHOW_TIME)
                val parts = listOfNotNull(
                    kindLabel(rc.kind),
                    rc.number.takeIf { name != null && it.isNotBlank() },
                    time,
                    PhoneBookLogic.formatDuration(rc.durationS),
                    "CRM".takeIf { inCrm },
                )
                Text(
                    parts.joinToString(" · "), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
            if (rc.number.isNotBlank()) {
                NumberMenu(menu, { menu = false }, rc.number, name, inCrm, savedOnPhone, onOpenCrm)
            }
        }
    }
}

private fun kindLabel(k: CallKind) = when (k) {
    CallKind.INCOMING -> "Incoming"
    CallKind.OUTGOING -> "Outgoing"
    CallKind.MISSED -> "Missed"
    CallKind.REJECTED -> "Rejected"
    CallKind.OTHER -> null
}

/** Arrow direction and colour per call kind (material-icons-core has no call_made/received). */
@Composable
private fun KindIcon(k: CallKind) {
    val (icon, angle, tint) = when (k) {
        CallKind.OUTGOING -> Triple(Icons.AutoMirrored.Filled.ArrowForward, -45f, UicColors.callGreen)
        CallKind.INCOMING -> Triple(Icons.AutoMirrored.Filled.ArrowForward, 135f, UicColors.primary)
        CallKind.MISSED -> Triple(Icons.AutoMirrored.Filled.ArrowForward, 135f, UicColors.overdue)
        CallKind.REJECTED -> Triple(Icons.Filled.Clear, 0f, UicColors.overdue)
        CallKind.OTHER -> Triple(Icons.AutoMirrored.Filled.ArrowForward, 0f, Color.Gray)
    }
    Icon(icon, contentDescription = kindLabel(k), tint = tint, modifier = Modifier.size(14.dp).rotate(angle))
}
