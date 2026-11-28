package com.usaindiacfo.uicdialer.update

import android.content.Context
import com.usaindiacfo.uicdialer.BuildConfig
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * What auto-update last did, so Settings can show it. Auto-update runs in the background,
 * so without this nobody can tell whether it is working.
 */
object UpdateStatus {
    private const val PREFS = "update_status"

    data class Snapshot(val lastCheckAt: Long, val lastResult: String?, val updatedTo: String?, val updatedAt: Long)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Called from every branch of the worker, including failures. */
    fun record(context: Context, result: String) {
        prefs(context).edit().putLong("lastCheckAt", System.currentTimeMillis()).putString("lastResult", result).apply()
    }

    /** First run of a newer build: remember when this phone got it. */
    fun noteCurrentVersion(context: Context) {
        val p = prefs(context)
        val seen = p.getInt("lastSeenVersionCode", 0)
        if (BuildConfig.VERSION_CODE <= seen) return
        val e = p.edit().putInt("lastSeenVersionCode", BuildConfig.VERSION_CODE)
        // The very first install isn't an update, so only stamp a date once we had an older version on record.
        if (seen > 0) e.putString("updatedTo", BuildConfig.VERSION_NAME).putLong("updatedAt", System.currentTimeMillis())
        e.apply()
    }

    /** Admin requires a newer version than this one (from the last check). */
    fun setRequired(context: Context, required: Boolean) {
        if (isRequired(context) != required) prefs(context).edit().putBoolean("required", required).apply()
    }

    fun isRequired(context: Context): Boolean = prefs(context).getBoolean("required", false)

    fun read(context: Context): Snapshot {
        noteCurrentVersion(context)
        val p = prefs(context)
        return Snapshot(p.getLong("lastCheckAt", 0), p.getString("lastResult", null), p.getString("updatedTo", null), p.getLong("updatedAt", 0))
    }

    fun date(ms: Long): String = SimpleDateFormat("d MMM", Locale.getDefault()).format(Date(ms))

    fun ago(ms: Long, now: Long = System.currentTimeMillis()): String {
        val min = (now - ms) / 60_000
        return when {
            min < 1 -> "just now"
            min < 60 -> "${min}m ago"
            min < 24 * 60 -> "${min / 60}h ago"
            else -> "${min / (24 * 60)}d ago"
        }
    }
}
