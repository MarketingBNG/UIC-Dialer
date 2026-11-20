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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
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
import com.usaindiacfo.uicdialer.AppContainer
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
    MINE("Mine", "mine"),
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

@Composable
fun ContactsScreen(onOpenContact: (phone: String) -> Unit) {
    val container = appContainer()
    val vm: ContactsViewModel = viewModel(factory = viewModelFactory { initializer { ContactsViewModel(container) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val call = rememberCaller()
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    com.usaindiacfo.uicdialer.dialer.LiveRefresh("contacts", "activity", "followups") { vm.refresh() }
    val listState = rememberLazyListState()
    val nearEnd by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= listState.layoutInfo.totalItemsCount - 5
        }
    }
    LaunchedEffect(nearEnd, state.nextCursor) { if (nearEnd && state.nextCursor != null) vm.loadMore() }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            value = state.query,
            onValueChange = { vm.setQuery(it.take(100)) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            placeholder = { Text("Name, number, company or notes") },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            singleLine = true,
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ContactFilter.entries.forEach { f ->
                FilterChip(selected = state.filter == f, onClick = { vm.setFilter(f) }, label = { Text(f.label) })
            }
        }
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp)) }
        if (state.items.isEmpty() && !state.loading && state.error == null) {
            Text(
                if (state.query.isBlank() && state.filter == ContactFilter.ALL) "No contacts yet. Numbers you call appear here." else "No contacts match.",
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp),
            )
        }
        LazyColumn(state = listState, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.items, key = { it.id }) { contact ->
                Card(
                    Modifier.fillMaxWidth().clickable { onOpenContact(contact.phoneE164) },
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                ) {
                    Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Avatar(contact.name)
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
                        GreenCallButton(onClick = { call(contact.phoneE164, dnc = contact.dnc) })
                    }
                }
            }
            if (state.loadingMore) item(key = "more") { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            else if (state.nextCursor != null) item(key = "more-btn") {
                TextButton(onClick = vm::loadMore, modifier = Modifier.fillMaxWidth()) { Text("Load more") }
            }
        }
    }
}
