package com.usaindiacfo.uicdialer.ui.home

import android.content.Context
import com.usaindiacfo.uicdialer.sync.SyncScheduler

object SyncNames {
    /** Unique one-time work enqueued by the "Sync now" button. */
    const val SYNC_NOW = SyncScheduler.SCAN_NOW

    fun enqueueSyncNow(context: Context): Boolean {
        SyncScheduler.syncNow(context)
        return true
    }
}
