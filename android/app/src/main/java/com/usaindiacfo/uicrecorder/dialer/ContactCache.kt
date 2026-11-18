package com.usaindiacfo.uicrecorder.dialer

import android.content.Context
import com.usaindiacfo.uicrecorder.data.api.ContactDto
import com.usaindiacfo.uicrecorder.data.api.ContactList
import kotlinx.serialization.json.Json

/**
 * Last loaded Recent and Follow-ups lists, so the dialer still shows them when the server can't be reached.
 * Small (at most a few hundred contacts); cleared on sign-out and when the session ends.
 */
class ContactCache(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("dialer_cache", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    var recent: List<ContactDto>
        get() = read(KEY_RECENT)
        set(v) = write(KEY_RECENT, v)

    var followUps: List<ContactDto>
        get() = read(KEY_FOLLOW_UPS)
        set(v) = write(KEY_FOLLOW_UPS, v)

    /** Last GET /v1/followups/today (Today offline, caller card, morning summary fallback). */
    var today: com.usaindiacfo.uicrecorder.data.api.FollowUpsToday?
        get() = prefs.getString(KEY_TODAY, null)?.let {
            runCatching { json.decodeFromString(com.usaindiacfo.uicrecorder.data.api.FollowUpsToday.serializer(), it) }.getOrNull()
        }
        set(v) = prefs.edit().apply {
            if (v == null) remove(KEY_TODAY) else putString(KEY_TODAY, json.encodeToString(com.usaindiacfo.uicrecorder.data.api.FollowUpsToday.serializer(), v))
        }.apply()

    fun clear() = prefs.edit().clear().apply()

    private fun read(key: String): List<ContactDto> =
        prefs.getString(key, null)?.let { runCatching { json.decodeFromString<ContactList>(it).items }.getOrNull() } ?: emptyList()

    private fun write(key: String, items: List<ContactDto>) =
        prefs.edit().putString(key, json.encodeToString(ContactList.serializer(), ContactList(items))).apply()

    private companion object {
        const val KEY_RECENT = "recent"
        const val KEY_FOLLOW_UPS = "follow_ups"
        const val KEY_TODAY = "today"
    }
}
