package com.usaindiacfo.uicdialer.ui.contacts

import kotlinx.coroutines.flow.flowOn
import android.Manifest
import android.content.Context
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import com.usaindiacfo.uicdialer.appContainer
import com.usaindiacfo.uicdialer.phonebook.PhoneBook
import com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic
import com.usaindiacfo.uicdialer.phonebook.PhoneContact
import com.usaindiacfo.uicdialer.ui.dialer.Avatar
import com.usaindiacfo.uicdialer.ui.dialer.rememberCaller
import com.usaindiacfo.uicdialer.ui.recents.NumberMenu
import com.usaindiacfo.uicdialer.ui.recents.PermissionPrompt
import com.usaindiacfo.uicdialer.ui.recents.crmNames
import com.usaindiacfo.uicdialer.ui.theme.UicColors
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class PhoneContactsState(
    val favourites: List<PhoneContact> = emptyList(),
    val all: List<PhoneContact> = emptyList(),
    val query: String = "",
    val total: Int = 0,
    val loaded: Boolean = false,
)

@OptIn(ExperimentalCoroutinesApi::class)
class PhoneContactsViewModel(app: Context) : ViewModel() {
    private val permTick = MutableStateFlow(0)
    private val query = MutableStateFlow("")
    private val contacts = permTick.flatMapLatest { PhoneBook.contactsFlow(app) }

    val state: StateFlow<PhoneContactsState> = combine(contacts, query) { list, q ->
        val shown = list.filter { PhoneBookLogic.contactMatches(it, q) }
        PhoneContactsState(
            favourites = if (q.isBlank()) shown.filter { it.starred } else emptyList(),
            all = shown, query = q, total = list.size, loaded = true,
        )
    }.flowOn(kotlinx.coroutines.Dispatchers.Default).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), PhoneContactsState())

    fun setQuery(q: String) { query.value = q }
    fun recheck() { permTick.value++ }
}

/** The phone's saved contacts: favourites (starred) first, then A–Z with section letters. */
@Composable
fun PhoneContactsTab(onOpenContact: (phone: String) -> Unit) {
    val context = LocalContext.current
    val app = context.applicationContext
    val vm: PhoneContactsViewModel = viewModel(factory = viewModelFactory { initializer { PhoneContactsViewModel(app) } })
    val state by vm.state.collectAsStateWithLifecycle()
    val call = rememberCaller()
    val container = appContainer()
    val crm = remember { crmNames(container.contactCache.recent + container.contactCache.followUps) }
    val scope = rememberCoroutineScope()
    var hasPerm by remember { mutableStateOf(PhoneBook.has(context, Manifest.permission.READ_CONTACTS)) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        hasPerm = PhoneBook.has(context, Manifest.permission.READ_CONTACTS)
        vm.recheck()
    }

    // Starring needs WRITE_CONTACTS; asked the first time the rep taps a star.
    var pendingStar by remember { mutableStateOf<Pair<PhoneContact, Boolean>?>(null) }
    fun doStar(c: PhoneContact, star: Boolean) = scope.launch {
        if (!PhoneBook.setStarred(context, c.id, star)) com.usaindiacfo.uicdialer.ui.recents.toast(context, "Couldn't change favourites")
    }
    val writeLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val p = pendingStar
        pendingStar = null
        if (ok && p != null) doStar(p.first, p.second)
        else if (!ok) com.usaindiacfo.uicdialer.ui.recents.toast(context, "Allow contacts editing to change favourites")
    }
    val toggleStar: (PhoneContact) -> Unit = { c ->
        if (PhoneBook.has(context, Manifest.permission.WRITE_CONTACTS)) doStar(c, !c.starred)
        else { pendingStar = c to !c.starred; writeLauncher.launch(Manifest.permission.WRITE_CONTACTS) }
    }

    Column(Modifier.fillMaxSize()) {
        if (!hasPerm) {
            PermissionPrompt("Allow contacts to see the phone's saved contacts here.", Manifest.permission.READ_CONTACTS) {
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
        TextButton(onClick = { PhoneBook.createContact(context, "") }, modifier = Modifier.padding(horizontal = 8.dp)) {
            Icon(Icons.Filled.Add, contentDescription = null)
            Text("  New contact")
        }
        if (state.loaded && state.all.isEmpty()) {
            Text(
                if (state.total == 0) "No contacts saved on this phone." else "No contacts match.",
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp),
            )
        }
        LazyColumn(contentPadding = PaddingValues(bottom = 16.dp)) {
            if (state.favourites.isNotEmpty()) {
                item(key = "fav-h") { Header("Favourites") }
                items(state.favourites, key = { "f${it.id}" }) { c ->
                    ContactRow(c, PhoneBookLogic.numberKey(c.number) in crm, { call(c.number) }, toggleStar, onOpenContact)
                }
            }
            var section: String? = null
            state.all.forEach { c ->
                val s = PhoneBookLogic.sectionOf(c.name)
                if (s != section) {
                    section = s
                    item(key = "h-$s") { Header(s) }
                }
                item(key = "c${c.id}") {
                    ContactRow(c, PhoneBookLogic.numberKey(c.number) in crm, { call(c.number) }, toggleStar, onOpenContact)
                }
            }
        }
    }
}

@Composable
private fun Header(text: String) = Text(
    text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary,
    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp),
)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ContactRow(
    c: PhoneContact, inCrm: Boolean, onCall: () -> Unit,
    onToggleStar: (PhoneContact) -> Unit, onOpenCrm: (String) -> Unit,
) {
    val context = LocalContext.current
    var menu by rememberSaveable { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClick = onCall, onLongClick = { menu = true })
            .padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Avatar(c.name)
        Column(Modifier.weight(1f).padding(start = 4.dp)) {
            Text(c.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(c.number, "CRM".takeIf { inCrm }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        IconButton(onClick = { onToggleStar(c) }) {
            Icon(
                Icons.Filled.Star, contentDescription = if (c.starred) "Remove from favourites" else "Add to favourites",
                tint = if (c.starred) UicColors.amber else MaterialTheme.colorScheme.outline,
            )
        }
        Box {
            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "More") }
            NumberMenu(menu, { menu = false }, c.number, c.name, inCrm, savedOnPhone = true, onOpenCrm) { close ->
                DropdownMenuItem(text = { Text("Open in Contacts app") }, onClick = { close(); PhoneBook.viewContact(context, c) })
            }
        }
    }
}
