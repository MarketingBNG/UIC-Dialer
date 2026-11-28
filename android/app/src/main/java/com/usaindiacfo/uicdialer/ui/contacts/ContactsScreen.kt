package com.usaindiacfo.uicdialer.ui.contacts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
import android.Manifest
import com.usaindiacfo.uicdialer.AppContainer
import com.usaindiacfo.uicdialer.phonebook.PhoneBook
import com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic
import com.usaindiacfo.uicdialer.phonebook.PhoneContact
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.data.api.ContactDto
import com.usaindiacfo.uicdialer.ui.dialer.Avatar
import com.usaindiacfo.uicdialer.ui.dialer.Chip
import com.usaindiacfo.uicdialer.ui.dialer.GreenCallButton
import com.usaindiacfo.uicdialer.ui.dialer.StatusChip
import com.usaindiacfo.uicdialer.ui.dialer.formatWhen
import com.usaindiacfo.uicdialer.ui.dialer.friendlyError
import com.usaindiacfo.uicdialer.ui.dialer.rememberCaller
import com.usaindiacfo.uicdialer.ui.dialer.title
import com.usaindiacfo.uicdialer.ui.theme.UicColors
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

/** Filter chips; [param] is the server's `filter` value (null = All). */
enum class ContactFilter(val label: String, val param: String?) {
    ALL("All", null),
    INTERESTED("Interested", "interested"),
    CALLBACK("Call back", "callback"),
    NEVER("Never called", "never"),
    MINE("My leads", "mine"),
}

data class ContactsState(
    val items: List<ContactDto> = emptyList(),
    val query: String = "",
    val filter: ContactFilter = ContactFilter.ALL,
    val nextCursor: String? = null,
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    val error: String? = null,
)

/** Server-side search (name, number, company, city, notes) with filters and cursor paging. */
class ContactsViewModel(private val c: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(ContactsState(items = c.contactCache.recent))
    val state: StateFlow<ContactsState> = _state.asStateFlow()
    private var job: Job? = null

    fun setQuery(q: String) {
        _state.update { it.copy(query = q) }
        reload(debounceMs = 300)
    }

    fun setFilter(f: ContactFilter) {
        _state.update { it.copy(filter = f) }
        reload()
    }

    fun refresh() = reload()

    private fun reload(debounceMs: Long = 0) {
        job?.cancel()
        job = viewModelScope.launch {
            if (debounceMs > 0) delay(debounceMs)
            val s = _state.value
            _state.update { it.copy(loading = true, error = null) }
            try {
                val page = c.apiClient.contacts(q = s.query.trim(), filter = s.filter.param)
                // Only the plain first page is the offline "recent" list.
                if (s.query.isBlank() && s.filter == ContactFilter.ALL) c.contactCache.recent = page.items
                _state.update { it.copy(items = page.items, nextCursor = page.nextCursor, loading = false) }
            } catch (e: IOException) {
                _state.update { it.copy(loading = false, error = friendlyError(e)) }
            }
        }
    }

    fun loadMore() {
        val s = _state.value
        val cursor = s.nextCursor ?: return
        if (s.loading || s.loadingMore) return
        _state.update { it.copy(loadingMore = true) }
        viewModelScope.launch {
            try {
                val page = c.apiClient.contacts(q = s.query.trim(), cursor = cursor, filter = s.filter.param)
                _state.update { st ->
                    if (st.query != s.query || st.filter != s.filter) st.copy(loadingMore = false)
                    else st.copy(items = (st.items + page.items).distinctBy { it.id }, nextCursor = page.nextCursor, loadingMore = false)
                }
            } catch (e: IOException) {
                _state.update { it.copy(loadingMore = false, error = friendlyError(e)) }
            }
        }
    }
}

/**
 * One search across CRM and the phone's own contacts. Chips filter the CRM list;
 * "On this phone" shows the phone book (favourites, new contact). Flat rows; the next
 * page loads as the rep scrolls.
 */
@Composable
fun ContactsScreen(onOpenContact: (phone: String) -> Unit) {
    val container = appContainer()
    val vm: ContactsViewModel = viewModel(factory = viewModelFactory { initializer { ContactsViewModel(container) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val app = context.applicationContext
    // Same instance PhoneContactsTab gets, so the search text carries across.
    val phoneVm: PhoneContactsViewModel = viewModel(factory = viewModelFactory { initializer { PhoneContactsViewModel(app) } })
    val phoneState by phoneVm.state.collectAsStateWithLifecycle()
    var onPhone by rememberSaveable { mutableStateOf(false) }
    var hasPerm by remember { mutableStateOf(PhoneBook.has(context, Manifest.permission.READ_CONTACTS)) }
    val call = rememberCaller()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        hasPerm = PhoneBook.has(context, Manifest.permission.READ_CONTACTS)
        // Re-read the phone book once contacts permission is newly granted.
        phoneVm.recheck()
        vm.refresh()
    }
    com.usaindiacfo.uicdialer.dialer.LiveRefresh("contacts", "activity", "followups") { vm.refresh() }
    val listState = rememberLazyListState()
    val nearEnd by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= listState.layoutInfo.totalItemsCount - 5
        }
    }
    LaunchedEffect(nearEnd, state.nextCursor, onPhone) { if (!onPhone && nearEnd && state.nextCursor != null) vm.loadMore() }

    // Phone matches only while searching, minus numbers already in the CRM results.
    val crmKeys = remember(state.items) { state.items.mapNotNull { PhoneBookLogic.numberKey(it.phoneE164) }.toSet() }
    val phoneMatches = if (!hasPerm || state.query.isBlank()) emptyList()
    else phoneState.all.filter { PhoneBookLogic.numberKey(it.number) !in crmKeys }.take(30)

    Column(Modifier.fillMaxSize()) {
        if (!onPhone) OutlinedTextField(
            value = state.query,
            onValueChange = { val q = it.take(100); vm.setQuery(q); phoneVm.setQuery(q) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            placeholder = { Text("Search name, number or company") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            singleLine = true,
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ContactFilter.entries.forEach { f ->
                FilterChip(selected = !onPhone && state.filter == f, onClick = { onPhone = false; vm.setFilter(f) }, label = { Text(f.label) })
            }
            FilterChip(selected = onPhone, onClick = { onPhone = true }, label = { Text("On this phone") })
        }
        if (onPhone) {
            PhoneContactsTab(onOpenContact)
            return@Column
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp)) }
        if (state.items.isEmpty() && phoneMatches.isEmpty() && !state.loading && state.error == null) {
            Text(
                if (state.query.isBlank() && state.filter == ContactFilter.ALL) "No contacts yet. Numbers you call appear here." else "No contacts match.",
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp),
            )
        }
        LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 16.dp)) {
            items(state.items, key = { it.id }) { contact ->
                Column(Modifier.animateItem(com.usaindiacfo.uicdialer.ui.theme.Motion.spec(), com.usaindiacfo.uicdialer.ui.theme.Motion.spec(), com.usaindiacfo.uicdialer.ui.theme.Motion.fast())) {
                    CrmRow(contact, onOpen = { onOpenContact(contact.phoneE164) }, onCall = { call(contact.phoneE164, dnc = contact.dnc) })
                    HorizontalDivider(Modifier.padding(start = 68.dp))
                }
            }
            if (state.loadingMore) item(key = "more") { LinearProgressIndicator(Modifier.fillMaxWidth().padding(16.dp)) }
            // Phone matches go after the last CRM page so they don't jump around while paging.
            if (phoneMatches.isNotEmpty() && state.nextCursor == null) {
                item(key = "phone-h") {
                    Text(
                        "On this phone", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
                    )
                }
                items(phoneMatches, key = { "p${it.id}" }) { pc ->
                    PhoneRow(pc, onOpen = { onOpenContact(pc.number) }, onCall = { call(pc.number) })
                    HorizontalDivider(Modifier.padding(start = 68.dp))
                }
            }
        }
    }
}

@Composable
private fun CrmRow(contact: ContactDto, onOpen: () -> Unit, onCall: () -> Unit) {
    val context = LocalContext.current
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(contact.name, sharedKey = contact.phoneE164)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(contact.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = listOfNotNull(
                contact.phoneE164.takeIf { !contact.name.isNullOrBlank() },
                contact.company?.takeIf { it.isNotBlank() },
                contact.city?.takeIf { it.isNotBlank() },
            ).joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                // One label per row: Do not call wins over the status.
                if (contact.dnc != null) Chip("Do not call", MaterialTheme.colorScheme.errorContainer, UicColors.overdue)
                else StatusChip(contact.status)
                formatWhen(context, contact.lastActivityAt)?.let {
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        GreenCallButton(onClick = onCall)
    }
}

@Composable
private fun PhoneRow(c: PhoneContact, onOpen: () -> Unit, onCall: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(c.name)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(c.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(c.number, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
        GreenCallButton(onClick = onCall)
    }
}

