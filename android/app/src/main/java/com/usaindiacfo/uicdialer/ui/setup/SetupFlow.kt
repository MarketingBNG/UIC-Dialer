package com.usaindiacfo.uicdialer.ui.setup

/** Steps of the guided first-time setup, in the order they are shown. Pure logic (unit tested). */
enum class GuideStep { PHONE, CONTACTS, NOTIFICATIONS, RECORDINGS, BATTERY, OVERLAY, EXACT_ALARMS }

/** Phone maker families with their own call recorder / autostart screens. */
enum class Brand {
    SAMSUNG, XIAOMI, OPPO, VIVO, MOTOROLA_GOOGLE, OTHER;

    companion object {
        fun from(manufacturer: String): Brand = when (manufacturer.trim().lowercase()) {
            "samsung" -> SAMSUNG
            "xiaomi", "redmi", "poco" -> XIAOMI
            "oppo", "realme", "oneplus" -> OPPO
            "vivo", "iqoo" -> VIVO
            "motorola", "google" -> MOTOROLA_GOOGLE
            else -> OTHER
        }
    }
}

object SetupFlow {
    /** Steps that apply on this API level, in display order. */
    fun stepsFor(sdk: Int): List<GuideStep> = GuideStep.entries.filter { step ->
        when (step) {
            GuideStep.NOTIFICATIONS -> sdk >= 33
            GuideStep.EXACT_ALARMS -> sdk >= 31
            else -> true
        }
    }

    /** Required steps can't be skipped. Contacts becomes required when the admin turned on business-calls-only. */
    fun isRequired(step: GuideStep, businessOnly: Boolean): Boolean = when (step) {
        GuideStep.PHONE, GuideStep.RECORDINGS, GuideStep.BATTERY -> true
        GuideStep.CONTACTS -> businessOnly
        else -> false
    }

    /** Autostart is a separate OEM screen only on these makers. */
    fun needsAutostart(brand: Brand): Boolean = brand in setOf(Brand.XIAOMI, Brand.OPPO, Brand.VIVO)

    /** Index to open on: the first step that is neither done nor skipped; [steps].size means "All set". */
    fun firstPending(steps: List<GuideStep>, done: Set<GuideStep>, skipped: Set<GuideStep> = emptySet()): Int =
        steps.indexOfFirst { it !in done && it !in skipped }.let { if (it < 0) steps.size else it }

    /** Required steps (whose state is a permission we can read) that are not done. */
    fun missingRequired(steps: List<GuideStep>, done: Set<GuideStep>, businessOnly: Boolean): List<GuideStep> =
        steps.filter { isRequired(it, businessOnly) && it !in done }

    /** Show the guide after sign-in until finished once, and again if a required permission was later revoked. */
    fun shouldShowGuide(completed: Boolean, requiredPermissionsMissing: Boolean): Boolean =
        !completed || requiredPermissionsMissing

    fun progressLabel(index: Int, total: Int) = "Step ${index + 1} of $total"

    fun title(step: GuideStep) = when (step) {
        GuideStep.PHONE -> "Allow phone and call log"
        GuideStep.CONTACTS -> "Allow contacts"
        GuideStep.NOTIFICATIONS -> "Allow notifications"
        GuideStep.RECORDINGS -> "Turn on call recording"
        GuideStep.BATTERY -> "Let the app run in the background"
        GuideStep.OVERLAY -> "Show the caller card"
        GuideStep.EXACT_ALARMS -> "Reminders on time"
    }

    fun why(step: GuideStep, businessOnly: Boolean) = when (step) {
        GuideStep.PHONE -> "The app reads your call log to match each recording to the right call."
        GuideStep.CONTACTS -> if (businessOnly) "Your admin chose business calls only, so the app needs contacts to skip your personal calls."
        else "Contacts show names instead of numbers."
        GuideStep.NOTIFICATIONS -> "Notifications remind you of follow-ups and missed calls."
        GuideStep.RECORDINGS -> "The app uploads the recordings your phone's own dialer makes, so it needs access to them."
        GuideStep.BATTERY -> "Otherwise the phone stops uploads when the app is in the background."
        GuideStep.OVERLAY -> "See the client's name and last note on the ringing screen."
        GuideStep.EXACT_ALARMS -> "Follow-up reminders arrive exactly on time instead of up to 10 minutes late."
    }

    /** Where to switch on automatic call recording in the phone maker's own dialer (docs/rollout.md). */
    fun recordingInstructions(brand: Brand) = when (brand) {
        Brand.SAMSUNG -> "Phone app > ⋮ > Settings > Record calls > Auto record calls: On, All calls."
        Brand.XIAOMI -> "Phone > Settings > Call recording > Record calls automatically: On, All numbers."
        Brand.OPPO -> "Phone > Settings > Call recording > Auto-record all calls (OnePlus: region dependent)."
        Brand.VIVO -> "Phone > Settings > Call recording > Auto record all calls."
        Brand.MOTOROLA_GOOGLE -> "Google Phone keeps recordings private, so the app can't read them. Use a dialer that saves recordings to a folder and turn on its auto-record."
        Brand.OTHER -> "In your Phone app open Settings > Call recording and record all calls automatically."
    }

    fun autostartInstructions(brand: Brand) = when (brand) {
        Brand.XIAOMI -> "Security > Autostart: turn on UIC Dialer. Also set Battery saver to \"No restrictions\"."
        Brand.OPPO -> "Allow UIC Dialer to auto-launch / run in background."
        Brand.VIVO -> "Allow background startup for UIC Dialer (i Manager > App manager)."
        else -> ""
    }
}
