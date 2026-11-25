package com.usaindiacfo.uicdialer.sync

import android.content.Context
import android.provider.CallLog
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkerParameters
import com.usaindiacfo.uicdialer.AppContainer
import com.usaindiacfo.uicdialer.container
import com.usaindiacfo.uicdialer.data.api.ApiException
import com.usaindiacfo.uicdialer.data.api.CallLogEntryRequest
import com.usaindiacfo.uicdialer.data.api.DeviceConfig
import com.usaindiacfo.uicdialer.data.api.DialVia
import com.usaindiacfo.uicdialer.detect.CallLogMatcher
import com.usaindiacfo.uicdialer.detect.SimInfo
import com.usaindiacfo.uicdialer.dialer.DialLogic
import com.usaindiacfo.uicdialer.dialer.DialPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.Instant

/** One CallLog row as read from the provider. */
data class CallLogRow(
    val id: Long, val number: String?, val type: Int, val dateMs: Long, val durationS: Int, val cachedName: String?,
    val accountId: String?,
)

/** Pure parts of the call-log sync (JVM-tested). */
object CallLogPlan {
    /** CallLog.Calls.TYPE -> the server's name for it. */
    fun typeName(type: Int): String = when (type) {
        CallLog.Calls.INCOMING_TYPE -> "INCOMING"
        CallLog.Calls.OUTGOING_TYPE -> "OUTGOING"
        CallLog.Calls.MISSED_TYPE -> "MISSED"
        CallLog.Calls.VOICEMAIL_TYPE -> "VOICEMAIL"
        CallLog.Calls.REJECTED_TYPE -> "REJECTED"
        CallLog.Calls.BLOCKED_TYPE -> "BLOCKED"
        CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> "ANSWERED_EXTERNALLY"
        else -> "UNKNOWN"
    }

    /**
     * What to do with rows (in _ID order) given each one's privacy decision:
     * send the Upload ones, drop the Skip ones, and stop just before the first Hold (it must not be lost, so the
     * cursor never passes it). [cursor] is the _ID to save once [send] is acknowledged; null = don't move it.
     */
    data class Batch(val send: List<CallLogRow>, val cursor: Long?, val held: Boolean)

    fun plan(rows: List<Pair<CallLogRow, PrivacyDecision>>): Batch {
        val send = ArrayList<CallLogRow>()
        var cursor: Long? = null
        for ((row, d) in rows) {
            when (d) {
                is PrivacyDecision.Hold -> return Batch(send, cursor, held = true)
                is PrivacyDecision.Skip -> Unit
                PrivacyDecision.Upload -> send += row
            }
            cursor = row.id
        }
        return Batch(send, cursor, held = false)
    }

    /** First run: only calls since the server's backlog cutoff (0 days = only calls from now on). */
    fun firstRunSince(nowMs: Long, cutoffDays: Int): Long = nowMs - cutoffDays.coerceAtLeast(0) * 24 * 3600_000L
}

enum class CallLogOutcome { DONE, RETRY, SIGNED_OUT }

/**
 * Sends every call-log entry (incoming, outgoing, missed, rejected; recorded or not) to the server, in _ID order
 * from a saved cursor. The server dedupes per entry and attaches recordings found later to the same call.
 */
class CallLogSync(private val context: Context, private val c: AppContainer) {
    private val prefs = SyncPrefs(context)

    suspend fun run(cfg: DeviceConfig, isStopped: () -> Boolean): CallLogOutcome = withContext(Dispatchers.IO) {
        if (!CallLogMatcher.hasPermission(context)) return@withContext CallLogOutcome.DONE
        val contacts = AndroidContactCheck(context, c.db.clientHashes())
        val appDials = DialPrefs(context).recentAppDials
        val sims = SimInfo.active(context)
        val accounts = SimInfo.accountToSub(context)
        while (!isStopped()) {
            val cursor = prefs.callLogCursor
            val since = if (cursor < 0) CallLogPlan.firstRunSince(System.currentTimeMillis(), cfg.backlogCutoffDays) else null
            val rows = query(cursor, since, BATCH)
            if (rows.isEmpty()) {
                // First run with nothing in range: start from the newest row so the range isn't read again.
                if (cursor < 0) prefs.callLogCursor = maxId() ?: -1L
                return@withContext CallLogOutcome.DONE
            }
            val plan = CallLogPlan.plan(rows.map { it to PrivacyFilter.decide(it.number, cfg, contacts) })
            if (plan.send.isNotEmpty()) {
                try {
                    c.apiClient.postCallLog(plan.send.map { toRequest(it, appDials, sims, accounts) })
                } catch (e: ApiException) {
                    return@withContext when {
                        e.isAuth -> CallLogOutcome.SIGNED_OUT
                        e.code == 404 && e.fromServer -> CallLogOutcome.DONE // server predates call-log sync
                        else -> CallLogOutcome.RETRY
                    }
                } catch (_: IOException) {
                    return@withContext CallLogOutcome.RETRY
                }
            }
            plan.cursor?.let { prefs.callLogCursor = it }
            // A held row (business-only mode waiting for Contacts permission or the client list): try later.
            if (plan.held) return@withContext CallLogOutcome.RETRY
            if (rows.size < BATCH) return@withContext CallLogOutcome.DONE
        }
        CallLogOutcome.RETRY
    }

    private fun toRequest(r: CallLogRow, appDials: List<Pair<String, Long>>, sims: List<com.usaindiacfo.uicdialer.detect.Sim>, accounts: Map<String, Int>): CallLogEntryRequest {
        val sim = SimInfo.match(r.accountId, sims, accounts)
        val type = CallLogPlan.typeName(r.type)
        return CallLogEntryRequest(
            phoneNumber = r.number?.takeIf { it.isNotBlank() }?.take(40),
            contactName = r.cachedName?.takeIf { it.isNotBlank() }?.take(200),
            type = type,
            startedAt = Instant.ofEpochMilli(r.dateMs).toString(),
            durationS = r.durationS.coerceIn(0, 24 * 3600),
            simKey = sim?.key ?: r.accountId?.takeIf { it.isNotBlank() }?.take(100),
            simSlot = sim?.slot?.takeIf { it >= 0 },
            simCarrier = sim?.carrier?.take(100),
            via = if (type == "OUTGOING" && DialLogic.isAppDial(appDials, r.number, r.dateMs)) DialVia.APP else null,
        )
    }

    private fun query(afterId: Long, sinceMs: Long?, limit: Int): List<CallLogRow> {
        val cols = arrayOf(
            CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION,
            CallLog.Calls.CACHED_NAME, CallLog.Calls.PHONE_ACCOUNT_ID,
        )
        val where = StringBuilder("${CallLog.Calls._ID} > ?")
        val args = arrayListOf(afterId.toString())
        if (sinceMs != null) { where.append(" AND ${CallLog.Calls.DATE} >= ?"); args += sinceMs.toString() }
        val out = ArrayList<CallLogRow>()
        context.contentResolver.query(CallLog.Calls.CONTENT_URI, cols, where.toString(), args.toTypedArray(), "${CallLog.Calls._ID} ASC")?.use { c ->
            // No LIMIT in the sort order (some providers reject it): stop reading after [limit] rows instead.
            while (out.size < limit && c.moveToNext()) {
                out += CallLogRow(c.getLong(0), c.getString(1), c.getInt(2), c.getLong(3), c.getInt(4), c.getString(5), c.getString(6))
            }
        }
        return out
    }

    private fun maxId(): Long? =
        context.contentResolver.query(CallLog.Calls.CONTENT_URI, arrayOf(CallLog.Calls._ID), null, null, "${CallLog.Calls._ID} DESC")
            ?.use { c -> if (c.moveToFirst()) c.getLong(0) else null }

    companion object {
        const val BATCH = 200
    }
}

/**
 * Sends new call-log entries. [KEY_TRIGGER] runs come from the content-URI trigger on the call log: they re-arm
 * it and hand over to the network-constrained run; other runs do the sync.
 */
class CallLogWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        if (inputData.getBoolean(KEY_TRIGGER, false)) {
            SyncScheduler.enqueueCallLogTrigger(ctx, ExistingWorkPolicy.APPEND_OR_REPLACE)
            if (ctx.container.tokenStore.user.value != null) SyncScheduler.enqueueCallLogSync(ctx)
            return Result.success()
        }
        if (ctx.container.tokenStore.user.value == null) return Result.success()
        val c = ctx.container
        val cfg = c.deviceConfigRepository.refreshIfStale()
        val outcome = runCatching { CallLogSync(ctx, c).run(cfg) { isStopped } }.getOrElse { CallLogOutcome.RETRY }
        runCatching { RecordingCheck.run(ctx) } // after each call: warn if recording looks off
        runCatching { com.usaindiacfo.uicdialer.dialer.ExternalCallPrompt.run(ctx) } // outcome for phone-app calls
        return when (outcome) {
            CallLogOutcome.RETRY -> Result.retry()
            else -> Result.success()
        }
    }

    companion object {
        const val KEY_TRIGGER = "trigger"
    }
}
