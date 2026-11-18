package com.usaindiacfo.uicrecorder.ui.dialer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.data.api.ActivityType
import com.usaindiacfo.uicrecorder.data.api.ContactDto
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
)

@OptIn(FlowPreview::class)
class DialerViewModel(private val c: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(DialerState())
    val state: StateFlow<DialerState> = _state.asStateFlow()
    private val query = MutableStateFlow("")

    init {
        viewModelScope.launch {
            query.debounce(350).distinctUntilChanged().collectLatest { lookup(it) }
        }
    }

    fun setNumber(n: String) {
        _state.update { it.copy(number = n) }
        query.value = n
    }

    fun logWhatsApp(phone: String) = viewModelScope.launch { c.activityRepository.log(phone, ActivityType.WHATSAPP) }

    private suspend fun lookup(q: String) {
        // Short input matches too much; wait for a few digits or letters.
        if (q.trim().length < 3) {
            _state.update { it.copy(matches = emptyList()) }
            return
        }
        val found = try {
            c.apiClient.contacts(q = q.trim(), limit = 5).items
        } catch (e: IOException) {
            c.contactCache.recent.filter { matchesQuery(it, q) } // offline: the saved list
        }
        _state.update { it.copy(matches = found) }
    }
}

/** Local search over the saved list: name, company or digits of the number. */
internal fun matchesQuery(c: ContactDto, q: String): Boolean {
    val t = q.trim()
    if (t.isEmpty()) return true
    val digits = t.filter(Char::isDigit)
    return c.name?.contains(t, ignoreCase = true) == true || c.company?.contains(t, ignoreCase = true) == true ||
        (digits.isNotEmpty() && c.phoneE164.filter(Char::isDigit).contains(digits))
}
