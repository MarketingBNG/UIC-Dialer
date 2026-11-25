package com.usaindiacfo.uicdialer.sync

import android.content.Context
import android.content.Intent
import android.net.Uri

/** Small non-secret sync state: SAF fallback folder and last successful sync time. */
class SyncPrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("sync", Context.MODE_PRIVATE)

    var safTreeUri: Uri?
        get() = prefs.getString(KEY_TREE, null)?.let(Uri::parse)
        set(v) = prefs.edit().putString(KEY_TREE, v?.toString()).apply()

    /** Folders from the whole-phone discovery that the user kept ticked (mirrored from SetupPrefs). */
    var discoveredFolders: Set<String>
        get() = prefs.getStringSet(KEY_DISCOVERED, null)?.toSet() ?: emptySet()
        set(v) = prefs.edit().putStringSet(KEY_DISCOVERED, v).apply()

    /** Discovered folders the user unticked; skipped even when on the server list. */
    var excludedFolders: Set<String>
        get() = prefs.getStringSet(KEY_EXCLUDED, null)?.toSet() ?: emptySet()
        set(v) = prefs.edit().putStringSet(KEY_EXCLUDED, v).apply()

    /** Epoch millis of the last sync run that finished without network errors; 0 if never. */
    var lastSyncAt: Long
        get() = prefs.getLong(KEY_LAST, 0)
        set(v) = prefs.edit().putLong(KEY_LAST, v).apply()

    /** True once a full sync ran with the required permissions granted (see MainActivity.startFirstSyncIfReady). */
    var firstSyncWithPermsDone: Boolean
        get() = prefs.getBoolean("first_sync_perms", false)
        set(v) = prefs.edit().putBoolean("first_sync_perms", v).apply()

    /** When a backlog run last scanned the recorder folders (epoch millis); 0 = never. */
    var lastBacklogScanAt: Long
        get() = prefs.getLong(KEY_BACKLOG_SCAN, 0)
        set(v) = prefs.edit().putLong(KEY_BACKLOG_SCAN, v).apply()

    /** Why Android refused the backlog progress notification last time (exception class); null when it worked. */
    var backlogForegroundError: String?
        get() = prefs.getString(KEY_BACKLOG_FGS, null)
        set(v) = prefs.edit().apply { if (v == null) remove(KEY_BACKLOG_FGS) else putString(KEY_BACKLOG_FGS, v) }.apply()

    /** WorkManager stop reason the last time a sync job was stopped by the system; null if never. */
    var lastStopReason: Int?
        get() = if (prefs.contains(KEY_STOP)) prefs.getInt(KEY_STOP, 0) else null
        set(v) = prefs.edit().apply { if (v == null) remove(KEY_STOP) else putInt(KEY_STOP, v) }.apply()

    /** CallLog _ID of the newest call-log row sent to the server (or skipped as private); -1 before the first run. */
    var callLogCursor: Long
        get() = prefs.getLong(KEY_CALL_LOG_CURSOR, -1L)
        set(v) = prefs.edit().putLong(KEY_CALL_LOG_CURSOR, v).apply()

    /** ETag of the last GET /v1/dnc/hashes (only sent while the dnc_hashes table is loaded). */
    var dncEtag: String?
        get() = prefs.getString(KEY_DNC_ETAG, null)
        set(v) = prefs.edit().apply { if (v == null) remove(KEY_DNC_ETAG) else putString(KEY_DNC_ETAG, v) }.apply()

    companion object {
        private const val KEY_DNC_ETAG = "dnc_etag"
        private const val KEY_CALL_LOG_CURSOR = "call_log_cursor"
        private const val KEY_STOP = "last_stop_reason"
        private const val KEY_BACKLOG_SCAN = "backlog_scan_at"
        private const val KEY_BACKLOG_FGS = "backlog_fgs_error"
        private const val KEY_TREE = "saf_tree"
        private const val KEY_LAST = "last_sync_at"
        private const val KEY_DISCOVERED = "discovered_folders"
        private const val KEY_EXCLUDED = "excluded_folders"

        /**
         * Call with the result of ACTION_OPEN_DOCUMENT_TREE (setup screen). Persists read access and
         * triggers a scan of the new folder.
         */
        fun setSafTree(context: Context, tree: Uri) {
            context.contentResolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            SyncPrefs(context).safTreeUri = tree
            SyncScheduler.syncNow(context)
        }
    }
}
