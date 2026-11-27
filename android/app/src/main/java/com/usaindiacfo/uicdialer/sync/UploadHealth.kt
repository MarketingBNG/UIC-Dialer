package com.usaindiacfo.uicdialer.sync

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.PowerManager
import android.provider.Settings
import com.usaindiacfo.uicdialer.ui.setup.SetupChecks

/** Why uploads may be stuck on this phone, most likely first, each with a one-tap fix. */
object UploadHealth {
    class Reason(val text: String, val fix: (Context) -> Unit)

    fun reasons(context: Context): List<Reason> {
        val out = mutableListOf<Reason>()
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
            out += Reason("No internet. Turn on Wi-Fi or mobile data.") { open(it, Intent(Settings.ACTION_WIFI_SETTINGS)) }
        }
        if (SetupChecks.backgroundRestricted(context)) {
            out += Reason("Battery is set to Restricted for UIC Dialer, so it can't upload in the background. Set it to Unrestricted.") { SetupChecks.openAppDetails(it) }
        } else if (!SetupChecks.ignoringBatteryOptimizations(context)) {
            out += Reason("Battery saving pauses uploads. Allow UIC Dialer to run in the background.") { SetupChecks.openBatterySettings(it) }
        }
        if (context.getSystemService(PowerManager::class.java).isPowerSaveMode) {
            out += Reason("Power saving mode is on, which pauses uploads.") { open(it, Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS)) }
        }
        return out
    }

    private fun open(context: Context, intent: Intent) {
        runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}
