package com.usaindiacfo.uicrecorder.reminders

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.usaindiacfo.uicrecorder.MainActivity
import com.usaindiacfo.uicrecorder.ui.OpenTargets
import com.usaindiacfo.uicrecorder.container
import com.usaindiacfo.uicrecorder.data.api.ActivityType
import com.usaindiacfo.uicrecorder.dialer.Dialer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

/**
 * Invisible trampoline for notification buttons (Call now / Call back / WhatsApp). Android 12+ doesn't let a
 * receiver start activities from a notification, so the button opens this, which acts and finishes.
 */
class NotificationActionActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val phone = intent.getStringExtra(EXTRA_PHONE)
        val notifId = intent.getIntExtra(EXTRA_NOTIF_ID, 0)
        if (notifId != 0) Notifications.cancel(this, notifId) // auto-cancel doesn't apply to action buttons
        if (phone != null && container.tokenStore.user.value != null) {
            when (intent.getStringExtra(EXTRA_ACTION)) {
                // Do-not-call number: no dialog is possible from a notification, so open the contact (red banner) instead.
                ACTION_CALL -> if (isDnc(phone)) {
                    runCatching {
                        startActivity(MainActivity.openIntent(this, OpenTargets.CONTACT, phone).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                } else {
                    // Bring the app forward under the call screen, so it resumes (and asks for the outcome)
                    // when the call ends instead of the phone going back to the launcher.
                    runCatching {
                        startActivity(MainActivity.openIntent(this, OpenTargets.TODAY).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                    Dialer.call(this, phone)
                }
                ACTION_WHATSAPP -> if (Dialer.whatsApp(this, phone)) {
                    // Logged so the server closes a missed-call task for this number.
                    val app = applicationContext
                    scope.launch { runCatching { app.container.activityRepository.log(phone, ActivityType.WHATSAPP) } }
                }
            }
        }
        finish()
    }

    /** One indexed Room lookup; this trampoline has no UI to wait in, so it blocks briefly off the main thread. */
    private fun isDnc(phone: String): Boolean =
        runCatching { runBlocking(Dispatchers.IO) { container.dncCheck.isDnc(phone) } }.getOrDefault(false)

    companion object {
        const val EXTRA_ACTION = "action"
        const val EXTRA_PHONE = "phone"
        const val EXTRA_NOTIF_ID = "notifId"
        const val ACTION_CALL = "call"
        const val ACTION_WHATSAPP = "whatsapp"

        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}
