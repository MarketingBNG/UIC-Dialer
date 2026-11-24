package com.usaindiacfo.uicdialer.callercard

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import com.usaindiacfo.uicdialer.container
import com.usaindiacfo.uicdialer.reminders.Reminders
import com.usaindiacfo.uicdialer.sync.AndroidContactCheck
import com.usaindiacfo.uicdialer.sync.PrivacyDecision
import com.usaindiacfo.uicdialer.sync.PrivacyFilter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Ringing: shows who is calling (overlay when allowed, else a heads-up notification). Idle after ringing:
 * schedules a missed-call scan. PHONE_STATE is exempt from the implicit-broadcast limits. The number is only
 * filled in when READ_CALL_LOG is granted, and the broadcast often arrives twice (without, then with it).
 */
class PhoneStateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        val app = context.applicationContext
        when (intent.getStringExtra(TelephonyManager.EXTRA_STATE)) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                setRang(app, true)
                @Suppress("DEPRECATION")
                val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)?.takeIf { it.isNotBlank() } ?: return
                if (!CallerCard.claim(number)) return // already showing (or looking up) this caller
                val pending = goAsync()
                scope.launch {
                    try {
                        // Never crash while the phone rings: any failure just means no card.
                        runCatching { lookup(app, number) }.getOrNull()
                            ?.let { info -> withContext(Dispatchers.Main) { runCatching { CallerCard.show(app, info) } } }
                    } finally {
                        pending.finish()
                    }
                }
            }
            TelephonyManager.EXTRA_STATE_OFFHOOK -> CallerCard.hideAfter(app, ANSWERED_HIDE_MS)
            TelephonyManager.EXTRA_STATE_IDLE -> {
                CallerCard.hide(app)
                // Any call just ended: send its call-log entry once the dialer has written it.
                if (app.container.tokenStore.user.value != null) com.usaindiacfo.uicdialer.sync.SyncScheduler.enqueueCallLogSync(app, delaySec = 3)
                if (rang(app)) {
                    setRang(app, false)
                    // Let the call log entry land first.
                    if (app.container.tokenStore.user.value != null) Reminders.enqueueSync(app, delaySec = 10)
                }
            }
        }
    }

    /** Null = show nothing (signed out, or a number that must stay on the phone). */
    private suspend fun lookup(context: Context, number: String): CallerInfo? {
        val c = context.container
        if (c.tokenStore.user.value == null) return null
        val cfg = c.deviceConfigRepository.current()
        val decision = PrivacyFilter.decide(number, cfg, AndroidContactCheck(context, c.db.clientHashes()))
        if (decision is PrivacyDecision.Skip) return null
        val local = CallerLookup.local(number, c.contactCache.recent + c.contactCache.followUps, c.contactCache.today?.let { it.items + it.upcoming }.orEmpty())
        // Undecided numbers (business-only, no Contacts permission) are not sent to the server.
        if (decision !is PrivacyDecision.Upload) return local ?: CallerInfo(number, known = false)
        val server = withTimeoutOrNull(LOOKUP_TIMEOUT_MS) { runCatching { c.apiClient.contactByPhone(number) }.getOrNull() }
        return CallerLookup.merge(number, server, local)
    }

    private companion object {
        const val LOOKUP_TIMEOUT_MS = 3_000L
        const val ANSWERED_HIDE_MS = 8_000L
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        // Persisted: the process can die between RINGING and IDLE, and IDLE then arrives in a fresh one.
        private const val PREFS = "phone_state"
        private const val KEY_RANG = "rang"
        fun rang(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_RANG, false)
        fun setRang(context: Context, v: Boolean) =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_RANG, v).commit()
    }
}
