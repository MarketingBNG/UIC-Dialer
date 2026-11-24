package com.usaindiacfo.uicdialer.phonebook

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.provider.ContactsContract
import android.widget.Toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext

/** Reads the phone's own call log and contacts (content providers), off the main thread. */
object PhoneBook {
    const val RECENTS_LIMIT = 500

    fun has(context: Context, permission: String) =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    /** Emits once at start and again (debounced by conflation) whenever [uri] changes. */
    private fun changes(context: Context, uri: Uri): Flow<Unit> = callbackFlow {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { trySend(Unit) }
        }
        trySend(Unit)
        val registered = runCatching { context.contentResolver.registerContentObserver(uri, true, observer) }.isSuccess
        awaitClose { if (registered) context.contentResolver.unregisterContentObserver(observer) }
    }.conflate()

    @OptIn(ExperimentalCoroutinesApi::class)
    fun recentsFlow(context: Context): Flow<List<RecentCall>> =
        changes(context, CallLog.Calls.CONTENT_URI).mapLatest { recents(context) }.flowOn(Dispatchers.IO)

    @OptIn(ExperimentalCoroutinesApi::class)
    fun contactsFlow(context: Context): Flow<List<PhoneContact>> =
        changes(context, ContactsContract.Contacts.CONTENT_URI).mapLatest { contacts(context) }.flowOn(Dispatchers.IO)

    /** Last [limit] call-log rows, newest first; empty without READ_CALL_LOG. */
    suspend fun recents(context: Context, limit: Int = RECENTS_LIMIT): List<RecentCall> = withContext(Dispatchers.IO) {
        if (!has(context, Manifest.permission.READ_CALL_LOG)) return@withContext emptyList()
        val out = ArrayList<RecentCall>()
        runCatching {
            context.contentResolver.query(
                CallLog.Calls.CONTENT_URI.buildUpon().appendQueryParameter("limit", limit.toString()).build(),
                arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.CACHED_NAME),
                null, null, "${CallLog.Calls.DATE} DESC",
            )?.use { c ->
                while (c.moveToNext() && out.size < limit) {
                    out += RecentCall(
                        id = c.getLong(0),
                        number = c.getString(1).orEmpty(),
                        kind = PhoneBookLogic.kindOf(c.getInt(2)),
                        dateMs = c.getLong(3),
                        durationS = c.getInt(4),
                        name = c.getString(5)?.takeIf { it.isNotBlank() },
                    )
                }
            }
        }
        out
    }

    /** Saved contacts with a phone number, one row per contact; empty without READ_CONTACTS. */
    suspend fun contacts(context: Context): List<PhoneContact> = withContext(Dispatchers.IO) {
        if (!has(context, Manifest.permission.READ_CONTACTS)) return@withContext emptyList()
        val byContact = LinkedHashMap<Long, PhoneContact>()
        runCatching {
            context.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(
                    ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                    ContactsContract.CommonDataKinds.Phone.LOOKUP_KEY,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER,
                    ContactsContract.CommonDataKinds.Phone.STARRED,
                    ContactsContract.CommonDataKinds.Phone.IS_SUPER_PRIMARY,
                ),
                null, null, null,
            )?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    val number = c.getString(3)?.takeIf { it.isNotBlank() } ?: continue
                    val primary = c.getInt(5) != 0
                    if (id in byContact && !primary) continue
                    byContact[id] = PhoneContact(
                        id = id,
                        lookupKey = c.getString(1).orEmpty(),
                        name = c.getString(2)?.takeIf { it.isNotBlank() } ?: number,
                        number = number,
                        starred = c.getInt(4) != 0,
                    )
                }
            }
        }
        PhoneBookLogic.sortContacts(byContact.values.toList())
    }

    /** Star / unstar a contact (needs WRITE_CONTACTS). False when it failed. */
    suspend fun setStarred(context: Context, contactId: Long, starred: Boolean): Boolean = withContext(Dispatchers.IO) {
        if (!has(context, Manifest.permission.WRITE_CONTACTS)) return@withContext false
        runCatching {
            val values = ContentValues().apply { put(ContactsContract.Contacts.STARRED, if (starred) 1 else 0) }
            context.contentResolver.update(
                ContactsContract.Contacts.CONTENT_URI, values, "${ContactsContract.Contacts._ID} = ?", arrayOf(contactId.toString()),
            ) > 0
        }.getOrDefault(false)
    }

    /** Opens the system "new contact" editor with [number] filled in. */
    fun createContact(context: Context, number: String, name: String? = null) =
        start(context, Intent(ContactsContract.Intents.Insert.ACTION).apply {
            type = ContactsContract.RawContacts.CONTENT_TYPE
            putExtra(ContactsContract.Intents.Insert.PHONE, number)
            if (!name.isNullOrBlank()) putExtra(ContactsContract.Intents.Insert.NAME, name)
            putExtra("finishActivityOnSaveCompleted", true)
        })

    /** Opens the system contact picker to add [number] to an existing contact. */
    fun addToExisting(context: Context, number: String) =
        start(context, Intent(Intent.ACTION_INSERT_OR_EDIT).apply {
            type = ContactsContract.Contacts.CONTENT_ITEM_TYPE
            putExtra(ContactsContract.Intents.Insert.PHONE, number)
            putExtra("finishActivityOnSaveCompleted", true)
        })

    /** Opens the contact in the phone's Contacts app. */
    fun viewContact(context: Context, c: PhoneContact) =
        start(context, Intent(Intent.ACTION_VIEW, ContactsContract.Contacts.getLookupUri(c.id, c.lookupKey)))

    private fun start(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "No contacts app found", Toast.LENGTH_SHORT).show()
        false
    } catch (_: SecurityException) {
        false
    }
}
