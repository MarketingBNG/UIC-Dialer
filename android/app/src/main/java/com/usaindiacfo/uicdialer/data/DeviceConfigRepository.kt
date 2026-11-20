package com.usaindiacfo.uicdialer.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.usaindiacfo.uicdialer.data.api.ApiClient
import com.usaindiacfo.uicdialer.data.api.DeviceConfig
import com.usaindiacfo.uicdialer.data.db.ClientHashDao
import com.usaindiacfo.uicdialer.data.db.DncHashDao
import com.usaindiacfo.uicdialer.sync.SyncPrefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.configStore by preferencesDataStore("device_config")

/** Server-pushed device config (GET /v1/device/config), cached so workers run offline. */
class DeviceConfigRepository(
    private val context: Context,
    private val api: ApiClient,
    private val clients: ClientHashDao,
    private val dnc: DncHashDao? = null,
) {
    private val keyJson = stringPreferencesKey("json")
    private val keyFetchedAt = longPreferencesKey("fetched_at")
    private val keyClientEtag = stringPreferencesKey("client_list_etag")

    /** Last fetched config, or defaults before the first fetch. */
    val config: Flow<DeviceConfig> = context.configStore.data.map { p ->
        p[keyJson]?.let { runCatching { api.json.decodeFromString<DeviceConfig>(it) }.getOrNull() } ?: DeviceConfig()
    }

    suspend fun current(): DeviceConfig = config.first()

    /** Fetches and caches. Throws IOException/ApiException like [ApiClient]. */
    suspend fun refresh(): DeviceConfig {
        val cfg = api.deviceConfig()
        context.configStore.edit {
            it[keyJson] = api.json.encodeToString(cfg)
            it[keyFetchedAt] = System.currentTimeMillis()
        }
        // Business-only mode: refresh the hashed client list with the config. On failure the old list stays.
        if (cfg.businessOnly) {
            try {
                // ETag: an unchanged list answers 304 instead of re-sending every hash.
                val etag = if (clients.loaded()) context.configStore.data.first()[keyClientEtag] else null
                api.clientNumberHashes(etag)?.let { (list, newEtag) ->
                    clients.replaceAll(list.hashes)
                    context.configStore.edit { p -> if (newEtag != null) p[keyClientEtag] = newEtag else p.remove(keyClientEtag) }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Keep the old list; until one download succeeds, saved contacts are held, not skipped.
            }
        }
        syncDnc()
        return cfg
    }

    /**
     * Downloads the hashed do-not-call list (every rep, not only business-only mode). ETag only while the table
     * is loaded, so a list wiped at sign-out is fetched in full. Failures keep the old list. Returns false on error.
     */
    suspend fun syncDnc(): Boolean {
        val dao = dnc ?: return true
        val prefs = SyncPrefs(context)
        return try {
            val etag = if (dao.loaded()) prefs.dncEtag else null
            api.dncHashes(etag)?.let { (list, newEtag) ->
                dao.replaceAll(list.hashes)
                prefs.dncEtag = newEtag
            }
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false // includes a 404 from a server without DNC
        }
    }

    /**
     * After a sign-out or server-side session end: drop the previous rep's own excluded numbers and mark the cache
     * stale, so the next rep's first sync fetches their config instead of skipping (or uploading) calls by the old
     * rep's list for up to 6 h. Org-wide settings (business-only, folders) are kept as the offline fallback.
     */
    suspend fun forgetUser() {
        val cur = current()
        context.configStore.edit {
            it.remove(keyFetchedAt)
            if (it[keyJson] != null) it[keyJson] = api.json.encodeToString(cur.copy(excludedNumbers = emptyList()))
        }
    }

    /** Refreshes when the cache is older than [maxAgeMs]; falls back to the cache on network errors. */
    suspend fun refreshIfStale(maxAgeMs: Long = 6 * 3600_000L): DeviceConfig {
        val fetchedAt = context.configStore.data.first()[keyFetchedAt] ?: 0
        val fresh = System.currentTimeMillis() - fetchedAt < maxAgeMs
        // Business-only without a client list holds saved-contact calls, so don't wait out the cache age.
        if (fresh && !(current().businessOnly && !clients.loaded()) && (dnc == null || dnc.loaded())) return current()
        return runCatching { refresh() }.getOrElse { current() }
    }
}
