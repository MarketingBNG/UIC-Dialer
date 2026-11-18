package com.usaindiacfo.uicrecorder.ui.contacts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.appContainer
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.ui.dialer.Avatar
import com.usaindiacfo.uicrecorder.ui.dialer.GreenCallButton
import com.usaindiacfo.uicrecorder.ui.dialer.StatusChip
import com.usaindiacfo.uicrecorder.ui.dialer.formatWhen
import com.usaindiacfo.uicrecorder.ui.dialer.friendlyError
import com.usaindiacfo.uicrecorder.ui.dialer.rememberCaller
import com.usaindiacfo.uicrecorder.ui.dialer.title
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

data class ContactsState(val items: List<ContactDto> = emptyList(), val loading: Boolean = false, val error: String? = null)

/** Recent contacts: the saved list first, then the server's (no search or import in stage 1). */
class ContactsViewModel(private val c: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(ContactsState(items = c.contactCache.recent))
    val state: StateFlow<ContactsState> = _state.asStateFlow()

    fun refresh() = viewModelScope.launch {
        _state.update { it.copy(loading = true) }
        try {
            val page = c.apiClient.contacts()
            c.contactCache.recent = page.items
            _state.update { ContactsState(items = page.items) }
        } catch (e: IOException) {
            _state.update { it.copy(loading = false, error = friendlyError(e)) }
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

    Column(Modifier.fillMaxSize()) {
        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(16.dp)) }
        if (state.items.isEmpty() && !state.loading && state.error == null) {
            Text("No contacts yet. Numbers you call appear here.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
        }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                            ).joinToString(" · ")
                            if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                StatusChip(contact.status)
                                formatWhen(context, contact.lastActivityAt)?.let {
                                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        GreenCallButton(onClick = { call(contact.phoneE164) })
                    }
                }
            }
        }
    }
}
