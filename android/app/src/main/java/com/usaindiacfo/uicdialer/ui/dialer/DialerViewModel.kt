package com.usaindiacfo.uicdialer.ui.dialer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.usaindiacfo.uicdialer.AppContainer
import com.usaindiacfo.uicdialer.data.api.ActivityType
import com.usaindiacfo.uicdialer.data.api.ContactDto
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException

data class DialerState(
    val number: String = "",
    /** Saved contacts matching what's typed; the first is shown above the keypad. */
    val matches: List<ContactDto> = emptyList(),
    /** Phone contacts, CRM contacts and recent numbers matching the typed digits (T9 on names too). */
    val suggestions: List<com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic.Suggestion> = emptyList(),
    /** The typed number is saved in the phone's contacts. */
    val savedOnPhone: Boolean = false,
)

@OptIn(FlowPreview::class)
class DialerViewModel(private val c: AppContainer, private val app: android.content.Context? = null) : ViewModel() {
    private val _state = MutableStateFlow(DialerState())
    val state: StateFlow<DialerState> = _state.asStateFlow()
    private val query = MutableStateFlow("")

    private var phoneContacts: List<com.usaindiacfo.uicdialer.phonebook.PhoneContact> = emptyList()
    private var recents: List<com.usaindiacfo.uicdialer.phonebook.RecentCall> = emptyList()

    init {
        viewModelScope.launch {
            query.debounce(250).distinctUntilChanged().collectLatest { lookup(it) }
        }
        if (app != null) {
            viewModelScope.launch { com.usaindiacfo.uicdialer.phonebook.PhoneBook.contactsFlow(app).collect { phoneContacts = it; suggest() } }
            viewModelScope.launch { com.usaindiacfo.uicdialer.phonebook.PhoneBook.recentsFlow(app).collect { recents = it; suggest() } }
        }
    }

    /** Local, in-memory: cheap enough to run on every key press. */
    private var suggestJob: kotlinx.coroutines.Job? = null

    /** Off the main thread: thousands of phone contacts made this freeze the keypad. */
    private fun suggest() {
        suggestJob?.cancel()
        suggestJob = viewModelScope.launch(kotlinx.coroutines.Dispatchers.Default) { suggestNow() }
    }

    private fun suggestNow() {
        val n = _state.value.number
        val crm = (_state.value.matches + c.contactCache.recent + c.contactCache.followUps).map { it.name to it.phoneE164 }
        val list = com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic.suggestions(n, phoneContacts, crm, recents)
        val key = com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic.numberKey(n)
        val saved = key != null && phoneContacts.any { com.usaindiacfo.uicdialer.phonebook.PhoneBookLogic.numberKey(it.number) == key }
        _state.update { it.copy(suggestions = list, savedOnPhone = saved) }
    }

    fun setNumber(n: String) {
        _state.update { it.copy(number = n) }
        query.value = n
        suggest()
    }

    /** The last number dialled from this phone (call log), for Call with nothing typed. */
    fun lastDialed(): String? = recents.filter { it.kind == com.usaindiacfo.uicdialer.phonebook.CallKind.OUTGOING }
        .maxByOrNull { it.dateMs }?.number

    fun logWhatsApp(phone: String) = viewModelScope.launch { c.activityRepository.log(phone, ActivityType.WHATSAPP) }

    private suspend fun lookup(q: String) {
        val term = lookupTerm(q)
        if (term == null) {
            _state.update { it.copy(matches = emptyList()) }
            return
        }
        val found = try {
            c.apiClient.contacts(q = term, limit = 5).items
        } catch (e: IOException) {
            c.contactCache.recent.filter { matchesQuery(it, q) } // offline: the saved list
        }
        _state.update { it.copy(matches = found) }
        suggest()
    }
}

/** What to send to the server search, or null when the input is too short (it would match too much). */
internal fun lookupTerm(q: String): String? = q.trim().takeIf { it.length >= 3 }

/** Local search over the saved list: name, company or digits of the number. */
internal fun matchesQuery(c: ContactDto, q: String): Boolean {
    val t = q.trim()
    if (t.isEmpty()) return true
    val digits = t.filter(Char::isDigit)
    return c.name?.contains(t, ignoreCase = true) == true || c.company?.contains(t, ignoreCase = true) == true ||
        (digits.isNotEmpty() && c.phoneE164.filter(Char::isDigit).contains(digits))
}
