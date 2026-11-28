package com.usaindiacfo.uicdialer.dialer

import android.content.Context
import com.usaindiacfo.uicdialer.data.api.ContactDto
import com.usaindiacfo.uicdialer.data.api.ContactByPhone
import com.usaindiacfo.uicdialer.data.api.ContactList
import com.usaindiacfo.uicdialer.data.api.MyCallLists
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Last loaded Recent and Follow-ups lists, so the dialer still shows them when the server can't be reached.
 * Small (at most a few hundred contacts); cleared on sign-out and when the session ends.
 */
class ContactCache(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("dialer_cache", Context.MODE_PRIVATE)
    private val catalogPrefs = context.applicationContext.getSharedPreferences("dialer_catalog", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    var recent: List<ContactDto>
        get() = read(KEY_RECENT)
        set(v) = write(KEY_RECENT, v)

    var followUps: List<ContactDto>
        get() = read(KEY_FOLLOW_UPS)
        set(v) = write(KEY_FOLLOW_UPS, v)

    /** Last GET /v1/followups/today (Today offline, caller card, morning summary fallback). */
    var today: com.usaindiacfo.uicdialer.data.api.FollowUpsToday?
        get() = prefs.getString(KEY_TODAY, null)?.let {
            runCatching { json.decodeFromString(com.usaindiacfo.uicdialer.data.api.FollowUpsToday.serializer(), it) }.getOrNull()
        }
        set(v) = prefs.edit().apply {
            if (v == null) remove(KEY_TODAY) else putString(KEY_TODAY, json.encodeToString(com.usaindiacfo.uicdialer.data.api.FollowUpsToday.serializer(), v))
        }.apply()

    /** Last GET /v1/call-lists, so Call lists opens instantly. */
    var myLists: MyCallLists?
        get() = prefs.getString(KEY_MY_LISTS, null)?.let { runCatching { json.decodeFromString(MyCallLists.serializer(), it) }.getOrNull() }
        set(v) = prefs.edit().apply {
            if (v == null) remove(KEY_MY_LISTS) else putString(KEY_MY_LISTS, json.encodeToString(MyCallLists.serializer(), v))
        }.apply()

    /** Last contact detail for this number (keyed by E.164), so the contact screen opens instantly. */
    fun contact(phone: String): ContactByPhone? = readContacts().firstOrNull { it.phone == phone }?.data

    /** Saves under each given key (raw and E.164); keeps the newest [MAX_CONTACTS] numbers. */
    @Synchronized
    fun putContact(keys: Collection<String>, data: ContactByPhone) {
        val fresh = keys.filter { it.isNotBlank() }.distinct().map { CachedContact(it, data) }
        if (fresh.isEmpty()) return
        val rest = readContacts().filter { old -> fresh.none { it.phone == old.phone } }
        val all = (fresh + rest).take(MAX_CONTACTS)
        prefs.edit().putString(KEY_CONTACTS, json.encodeToString(CachedContacts.serializer(), CachedContacts(all))).apply()
    }

    private fun readContacts(): List<CachedContact> =
        prefs.getString(KEY_CONTACTS, null)?.let { runCatching { json.decodeFromString(CachedContacts.serializer(), it).items }.getOrNull() } ?: emptyList()

    /** Also drops the cached outcomes and templates (OutcomeCatalog). */
    fun clear() {
        prefs.edit().clear().apply()
        catalogPrefs.edit().clear().apply()
    }

    private fun read(key: String): List<ContactDto> =
        prefs.getString(key, null)?.let { runCatching { json.decodeFromString<ContactList>(it).items }.getOrNull() } ?: emptyList()

    private fun write(key: String, items: List<ContactDto>) =
        prefs.edit().putString(key, json.encodeToString(ContactList.serializer(), ContactList(items))).apply()

    private companion object {
        const val KEY_RECENT = "recent"
        const val KEY_FOLLOW_UPS = "follow_ups"
        const val KEY_TODAY = "today"
        const val KEY_MY_LISTS = "my_lists"
        const val KEY_CONTACTS = "contacts_by_phone"
        const val MAX_CONTACTS = 50
    }
}

@Serializable private data class CachedContact(val phone: String, val data: ContactByPhone)
@Serializable private data class CachedContacts(val items: List<CachedContact> = emptyList())
