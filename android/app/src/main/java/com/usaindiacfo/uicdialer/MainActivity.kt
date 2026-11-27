package com.usaindiacfo.uicdialer

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.usaindiacfo.uicdialer.sync.SyncScheduler
import com.usaindiacfo.uicdialer.ui.AppNavigation
import com.usaindiacfo.uicdialer.ui.theme.UicTheme
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    /** Pending deep link from a notification: (EXTRA_OPEN value, EXTRA_PHONE). */
    private val openRequest = MutableStateFlow<Pair<String, String?>?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) readOpen(intent)
        setContent {
            val open by openRequest.collectAsStateWithLifecycle()
            UicTheme { AppNavigation(container, openRequest = open, onOpenHandled = { openRequest.value = null }) }
        }
    }

    override fun onResume() {
        super.onResume()
        // The app is on screen, so Android allows the backlog's foreground notification: start a waiting backlog
        // run now. Started from the background it would get only ~10 minutes at a time.
        SyncScheduler.kickBacklogFromForeground(applicationContext)
        // "Calls from PC" (if on): restart it if Android or a battery saver stopped it.
        com.usaindiacfo.uicdialer.dialer.RemoteDialService.startIfEnabled(applicationContext)
        startFirstSyncIfReady()
    }

    /**
     * Sign-in syncs before setup has asked for permissions, so that run finds nothing. The first time the app sees
     * the permissions granted (from the guide, the checklist or system settings), run the full sync once.
     */
    private fun startFirstSyncIfReady() {
        val ctx = applicationContext
        if (ctx.container.tokenStore.user.value == null) return
        if (!com.usaindiacfo.uicdialer.ui.setup.SetupChecks.requiredGranted(ctx)) return
        val prefs = com.usaindiacfo.uicdialer.sync.SyncPrefs(ctx)
        if (prefs.firstSyncWithPermsDone) return
        prefs.firstSyncWithPermsDone = true
        prefs.lastBacklogScanAt = 0L // the scan at sign-in had no access: scan old recordings now
        SyncScheduler.syncNow(ctx)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readOpen(intent)
    }

    private fun readOpen(intent: Intent?) {
        val target = intent?.getStringExtra(EXTRA_OPEN) ?: return
        openRequest.value = target to intent.getStringExtra(EXTRA_PHONE)
        intent.removeExtra(EXTRA_OPEN) // don't replay on recreation
    }

    companion object {
        const val EXTRA_OPEN = "open" // "today" | "contact"
        const val EXTRA_PHONE = "phone"

        /** Intent for notifications: opens Today, or a contact when [phone] is given. */
        fun openIntent(context: Context, target: String, phone: String? = null): Intent =
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_OPEN, target)
                .apply { if (phone != null) putExtra(EXTRA_PHONE, phone) }
    }
}
