package com.usaindiacfo.uicdialer.detect

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.telecom.TelecomManager
import com.usaindiacfo.uicdialer.data.api.SimReport

/** One active SIM. [key] is what the call log stores as PHONE_ACCOUNT_ID for calls on it (usually the subscription id). */
data class Sim(val key: String, val subId: Int, val iccId: String?, val slot: Int, val carrier: String?, val number: String?)

object SimInfo {
    /**
     * The SIM a call-log row's PHONE_ACCOUNT_ID refers to. Most phones store the subscription id; some OEMs store
     * the ICCID (sometimes with a trailing "F" or extra digits), so that is tried next.
     */
    fun match(accountId: String?, sims: List<Sim>, accountToSub: Map<String, Int> = emptyMap()): Sim? {
        val id = accountId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        accountToSub[id]?.let { sub -> sims.firstOrNull { it.subId == sub }?.let { return it } }
        sims.firstOrNull { it.subId.toString() == id }?.let { return it }
        val digits = id.trimEnd('F', 'f')
        return sims.firstOrNull { s -> s.iccId?.takeIf { it.length >= 10 }?.let { digits.startsWith(it) || it.startsWith(digits) } == true }
    }

    fun hasPermission(context: Context) =
        context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED

    /** Active SIMs; empty without READ_PHONE_STATE. The number is filled only when Android exposes it. */
    @SuppressLint("MissingPermission")
    fun active(context: Context): List<Sim> {
        if (!hasPermission(context)) return emptyList()
        val sm = context.getSystemService(SubscriptionManager::class.java) ?: return emptyList()
        val subs: List<SubscriptionInfo> = runCatching { sm.activeSubscriptionInfoList }.getOrNull() ?: return emptyList()
        return subs.map { s ->
            Sim(
                key = s.subscriptionId.toString(),
                subId = s.subscriptionId,
                iccId = runCatching { s.iccId }.getOrNull()?.takeIf { it.isNotBlank() },
                slot = s.simSlotIndex,
                carrier = (s.carrierName ?: s.displayName)?.toString()?.takeIf { it.isNotBlank() },
                number = number(context, sm, s),
            )
        }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun number(context: Context, sm: SubscriptionManager, s: SubscriptionInfo): String? = runCatching {
        if (Build.VERSION.SDK_INT >= 33) {
            val ok = context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED
            if (ok) sm.getPhoneNumber(s.subscriptionId) else null
        } else {
            s.number
        }
    }.getOrNull()?.takeIf { it.any(Char::isDigit) }

    /**
     * Call-log account id -> subscription id, as Android itself maps them (API 30+). Covers phones whose call
     * log stores the ICCID, which apps can't read on Android 10+.
     */
    @SuppressLint("MissingPermission")
    fun accountToSub(context: Context): Map<String, Int> {
        if (Build.VERSION.SDK_INT < 30 || !hasPermission(context)) return emptyMap()
        val telecom = context.getSystemService(TelecomManager::class.java) ?: return emptyMap()
        val tm = context.getSystemService(TelephonyManager::class.java) ?: return emptyMap()
        return runCatching {
            telecom.callCapablePhoneAccounts.mapNotNull { h ->
                tm.createForPhoneAccountHandle(h)?.subscriptionId?.takeIf { it >= 0 }?.let { h.id to it }
            }.toMap()
        }.getOrDefault(emptyMap())
    }

    /** A SIM the rep can call from: [handle] goes on the call intent; [label] is "SIM 1 · Jio · +91…". */
    data class CallSim(val handle: android.telecom.PhoneAccountHandle, val label: String, val slot: Int)

    /** SIMs that can place calls, in slot order; empty without READ_PHONE_STATE (then the phone decides). */
    @SuppressLint("MissingPermission")
    fun callSims(context: Context): List<CallSim> {
        if (!hasPermission(context)) return emptyList()
        val telecom = context.getSystemService(TelecomManager::class.java) ?: return emptyList()
        val sims = active(context)
        val toSub = accountToSub(context)
        return runCatching {
            telecom.callCapablePhoneAccounts.mapIndexed { i, h ->
                val sim = match(h.id, sims, toSub)
                val slot = sim?.slot ?: i
                val name = runCatching { telecom.getPhoneAccount(h)?.label?.toString() }.getOrNull()
                val parts = listOfNotNull("SIM ${slot + 1}", (sim?.carrier ?: name)?.takeIf { it.isNotBlank() }, sim?.number)
                CallSim(h, parts.distinct().joinToString(" · "), slot)
            }.sortedBy { it.slot }
        }.getOrDefault(emptyList())
    }

    fun reports(context: Context): List<SimReport> =
        active(context).map { SimReport(key = it.key, slot = it.slot, carrier = it.carrier, number = it.number) }
}
