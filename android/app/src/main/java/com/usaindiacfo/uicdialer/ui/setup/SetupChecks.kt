package com.usaindiacfo.uicdialer.ui.setup

import android.Manifest
import android.app.ActivityManager
import com.usaindiacfo.uicdialer.detect.FoundFolder
import com.usaindiacfo.uicdialer.detect.RecordingDiscovery
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import kotlinx.coroutines.flow.first
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Setup choices shared with the sync package. DataStore file "setup". */
val Context.setupStore by preferencesDataStore("setup")

object SetupPrefs {
    /** SAF tree URI (persisted read permission) picked when MediaStore can't see the recorder folder. */
    val SAF_TREE_URI = stringPreferencesKey("safTreeUri")

    fun safTreeUri(context: Context): Flow<Uri?> =
        context.setupStore.data.map { p -> p[SAF_TREE_URI]?.let(Uri::parse) }

    suspend fun setSafTreeUri(context: Context, uri: Uri?) {
        context.setupStore.edit { if (uri == null) it.remove(SAF_TREE_URI) else it[SAF_TREE_URI] = uri.toString() }
        com.usaindiacfo.uicdialer.sync.SyncPrefs(context).safTreeUri = uri
        if (uri != null) com.usaindiacfo.uicdialer.sync.SyncScheduler.syncNow(context)
    }

    /** Discovery results as "folder\tcount"; [UNTICKED] holds folders the user switched off. */
    private val DISCOVERED = stringSetPreferencesKey("discovered")
    private val UNTICKED = stringSetPreferencesKey("discoveredOff")
    private val DISCOVERY_RAN = booleanPreferencesKey("discoveryRan")

    data class Discovery(val ran: Boolean, val folders: List<FoundFolder>, val unticked: Set<String>) {
        val enabled get() = folders.map { it.folder }.filter { it !in unticked }.toSet()
    }

    fun discovery(context: Context): Flow<Discovery> = context.setupStore.data.map { p ->
        val folders = p[DISCOVERED].orEmpty().mapNotNull { e ->
            val (f, n) = e.split('\t').takeIf { it.size == 2 } ?: return@mapNotNull null
            FoundFolder(f, n.toIntOrNull() ?: 0)
        }.sortedByDescending { it.files }
        Discovery(p[DISCOVERY_RAN] == true, folders, p[UNTICKED].orEmpty())
    }

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _scanning = MutableStateFlow(false)
    val scanning: StateFlow<Boolean> = _scanning

    /** Starts a whole-phone scan in an app-wide scope (survives leaving setup); no-op if one is running. */
    fun startDiscovery(context: Context, allow: List<String>) {
        if (!_scanning.compareAndSet(false, true)) return
        val app = context.applicationContext
        appScope.launch {
            try { runCatching { runDiscovery(app, allow.ifEmpty { com.usaindiacfo.uicdialer.detect.RecorderScanner.DEFAULT_FOLDERS }) } }
            finally { _scanning.value = false }
        }
    }

    /** Scans the whole phone (off the main thread), saves the result and syncs if anything was found. */
    private suspend fun runDiscovery(context: Context, allow: List<String>) {
        val found = withContext(Dispatchers.IO) { RecordingDiscovery(context).discover(allow) }
        context.setupStore.edit { p ->
            p[DISCOVERED] = found.map { "${it.folder}\t${it.files}" }.toSet()
            p[UNTICKED] = p[UNTICKED].orEmpty().filter { u -> found.any { it.folder == u } }.toSet()
            p[DISCOVERY_RAN] = true
        }
        mirror(context)
        if (found.isNotEmpty()) com.usaindiacfo.uicdialer.sync.SyncScheduler.syncNow(context)
    }

    suspend fun setTicked(context: Context, folder: String, ticked: Boolean) {
        context.setupStore.edit { p -> p[UNTICKED] = p[UNTICKED].orEmpty().let { if (ticked) it - folder else it + folder } }
        mirror(context)
        if (ticked) com.usaindiacfo.uicdialer.sync.SyncScheduler.syncNow(context)
    }

    private suspend fun mirror(context: Context) {
        val d = discovery(context).first()
        com.usaindiacfo.uicdialer.sync.SyncPrefs(context).apply { discoveredFolders = d.enabled; excludedFolders = d.unticked }
    }
}

/** Guided setup: finished once (so it doesn't nag) and steps the rep chose to skip. */
object GuidePrefs {
    private val DONE = booleanPreferencesKey("guideDone")
    private val SKIPPED = stringSetPreferencesKey("guideSkipped")

    suspend fun completed(context: Context): Boolean = context.setupStore.data.first()[DONE] == true
    suspend fun skipped(context: Context): Set<GuideStep> =
        context.setupStore.data.first()[SKIPPED].orEmpty().mapNotNull { n -> GuideStep.entries.firstOrNull { it.name == n } }.toSet()

    suspend fun setCompleted(context: Context) { context.setupStore.edit { it[DONE] = true } }
    suspend fun skip(context: Context, step: GuideStep) {
        context.setupStore.edit { it[SKIPPED] = it[SKIPPED].orEmpty() + step.name }
    }
}

object SetupChecks {
    /** Whether a guided-setup step is already done on this phone. */
    fun stepDone(context: Context, step: GuideStep): Boolean = when (step) {
        GuideStep.PHONE -> granted(context, Manifest.permission.READ_CALL_LOG) && phoneStateGranted(context)
        GuideStep.CONTACTS -> granted(context, Manifest.permission.READ_CONTACTS)
        GuideStep.NOTIFICATIONS -> notificationsGranted(context)
        GuideStep.RECORDINGS -> granted(context, audioPermission)
        GuideStep.BATTERY -> ignoringBatteryOptimizations(context) && !backgroundRestricted(context)
        GuideStep.OVERLAY -> canDrawOverlays(context)
        GuideStep.EXACT_ALARMS -> canExactAlarms(context)
    }

    /** Runtime permissions a step asks for (empty = opens a system settings screen instead). */
    fun stepPermissions(step: GuideStep): List<String> = when (step) {
        GuideStep.PHONE -> listOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_PHONE_NUMBERS)
        GuideStep.CONTACTS -> listOf(Manifest.permission.READ_CONTACTS)
        GuideStep.NOTIFICATIONS -> if (Build.VERSION.SDK_INT >= 33) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()
        GuideStep.RECORDINGS -> listOf(audioPermission)
        else -> emptyList()
    }

    /** A required permission (call log, recordings, contacts in business-only mode) is missing: re-show the guide. */
    fun requiredPermissionsMissing(context: Context, businessOnly: Boolean): Boolean =
        !requiredGranted(context) || (businessOnly && !granted(context, Manifest.permission.READ_CONTACTS))

    /** One thing the phone still needs, most important first. [Fix] says what the single "Fix" button does. */
    enum class Fix { OPEN_SETUP, CALL_PHONE, CALLS_FROM_PC, NOTIFICATIONS }
    data class Issue(val text: String, val fix: Fix, val action: String = "Fix")

    /** Everything wrong with this phone's setup, ordered so the Today banner shows the worst first. */
    fun issues(context: Context): List<Issue> = buildList {
        if (!requiredGranted(context)) add(Issue("Setup needs attention: calls can't be synced.", Fix.OPEN_SETUP))
        if (!callPhoneGranted(context)) add(Issue("Allow \"Make calls\" so Call on your laptop dials this phone.", Fix.CALL_PHONE, "Allow"))
        if (!com.usaindiacfo.uicdialer.dialer.RemoteDialService.isEnabled(context)) {
            add(Issue("Calls from your laptop are off.", Fix.CALLS_FROM_PC, "Turn on"))
        }
        if (!com.usaindiacfo.uicdialer.reminders.Notifications.canNotify(context)) {
            add(Issue("Notifications are off, so you won't get follow-up reminders.", Fix.NOTIFICATIONS, "Turn on"))
        }
    }

    /** Direct dialling (laptop Call, one-tap call lists) needs CALL_PHONE; without it we fall back to the keypad. */
    fun callPhoneGranted(context: Context) = granted(context, Manifest.permission.CALL_PHONE)

    /** App notification settings (covers both the permission and a channel/app switch turned off). */
    fun openNotificationSettings(context: Context) {
        val i = if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        else null
        if (i == null || !tryStart(context, i)) openAppDetails(context)
    }

    val audioPermission: String =
        if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE

    /** Permissions the sync needs (audio + call log). Contacts, notifications and phone state are optional. */
    val requiredPermissions = listOf(audioPermission, Manifest.permission.READ_CALL_LOG)
    val optionalPermissions = buildList {
        add(Manifest.permission.READ_CONTACTS)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        add(Manifest.permission.READ_PHONE_STATE) // caller card
    }

    /** Contacts + notifications (one setup step); phone state has its own caller-card step. */
    val contactsAndNotifications = optionalPermissions - Manifest.permission.READ_PHONE_STATE

    fun notificationsGranted(context: Context) =
        Build.VERSION.SDK_INT < 33 || granted(context, Manifest.permission.POST_NOTIFICATIONS)

    /** Caller card needs to see the phone ring; the overlay is optional (falls back to a notification). */
    fun phoneStateGranted(context: Context) = granted(context, Manifest.permission.READ_PHONE_STATE)

    fun canDrawOverlays(context: Context) = Settings.canDrawOverlays(context)

    fun openOverlaySettings(context: Context) {
        if (!tryStart(context, Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}")))) openAppDetails(context)
    }

    /** Android 12+ asks for exact alarms separately; without it reminders may come up to 10 minutes late. */
    val exactAlarmApplies get() = Build.VERSION.SDK_INT >= 31

    fun canExactAlarms(context: Context) = com.usaindiacfo.uicdialer.reminders.ReminderScheduler.canExact(context)

    fun openExactAlarmSettings(context: Context) {
        if (Build.VERSION.SDK_INT < 31) return
        if (!tryStart(context, Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}")))) openAppDetails(context)
    }

    fun granted(context: Context, permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun requiredGranted(context: Context) = requiredPermissions.all { granted(context, it) }

    fun ignoringBatteryOptimizations(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    /** "Restricted" battery mode (API 28+): the app can't run in the background at all, even if whitelisted. */
    fun backgroundRestricted(context: Context): Boolean =
        Build.VERSION.SDK_INT >= 28 && context.getSystemService(ActivityManager::class.java).isBackgroundRestricted

    /** One-tap "Allow" dialog (sideloaded app, so the permission is fine); then the list; then app details. */
    @android.annotation.SuppressLint("BatteryLife")
    fun openBatterySettings(context: Context) {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        if (!tryStart(context, direct) && !tryStart(context, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))) {
            openAppDetails(context)
        }
    }

    val manufacturer: String = Build.MANUFACTURER.lowercase()
    val hasAutostartScreen: Boolean
        get() = autostartIntents().isNotEmpty()

    /** OEM autostart / background-launch screens; first that resolves wins, else app details. */
    fun openAutostartSettings(context: Context) {
        if (autostartIntents().none { tryStart(context, it) }) openAppDetails(context)
    }

    /** "package/class" of the first OEM autostart screen that resolves here (heartbeat field), or null. */
    fun resolvedAutostart(context: Context): String? = autostartIntents().firstOrNull { i ->
        runCatching { context.packageManager.resolveActivity(i, 0) != null }.getOrDefault(false)
    }?.component?.flattenToShortString()

    /**
     * Android 13+ blocks "restricted settings" (call log among them) for apps installed outside an app store,
     * until the user taps App info > ⋮ > "Allow restricted settings".
     */
    fun sideloaded(context: Context): Boolean = runCatching {
        val pm = context.packageManager
        val installer = if (Build.VERSION.SDK_INT >= 30) pm.getInstallSourceInfo(context.packageName).installingPackageName
        else @Suppress("DEPRECATION") pm.getInstallerPackageName(context.packageName)
        installer == null || installer !in STORE_INSTALLERS
    }.getOrDefault(true)

    private val STORE_INSTALLERS = setOf("com.android.vending", "com.sec.android.app.samsungapps", "com.xiaomi.market", "com.heytap.market", "com.oppo.market", "com.bbk.appstore")

    fun needsRestrictedSettings(context: Context): Boolean =
        com.usaindiacfo.uicdialer.sync.DeviceHealth.needsRestrictedSettings(
            Build.VERSION.SDK_INT, granted(context, Manifest.permission.READ_CALL_LOG), sideloaded(context),
        )

    private fun autostartIntents(): List<Intent> {
        fun cmp(pkg: String, cls: String) = Intent().setComponent(ComponentName(pkg, cls))
        return when {
            manufacturer in listOf("xiaomi", "redmi", "poco") -> listOf(
                cmp("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            )
            manufacturer in listOf("oppo", "realme", "oneplus") -> listOf(
                cmp("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                cmp("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
                cmp("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
                cmp("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
            )
            manufacturer in listOf("vivo", "iqoo") -> listOf(
                cmp("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                cmp("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"),
                cmp("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
            )
            manufacturer == "samsung" -> listOf(
                cmp("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"),
                cmp("com.samsung.android.sm", "com.samsung.android.sm.battery.ui.BatteryActivity"),
            )
            manufacturer in listOf("huawei", "honor") -> listOf(
                cmp("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            )
            else -> emptyList()
        }
    }

    fun openAppDetails(context: Context) {
        tryStart(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
    }

    private fun tryStart(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent)
        true
    } catch (_: Exception) { // ActivityNotFound / SecurityException on OEM builds
        false
    }

    /** True if MediaStore has at least one audio file in any of [folders] (needs the audio permission). */
    suspend fun recorderFolderFound(context: Context, folders: List<String>): Boolean = withContext(Dispatchers.IO) {
        val names = folders.map { it.trim('/', ' ') }.filter { it.isNotEmpty() }
            .ifEmpty { listOf("Call", "Recordings", "MIUI/sound_recorder/call_rec", "Record/Call", "Sounds/CallRecord") }
        @Suppress("DEPRECATION")
        val column = if (Build.VERSION.SDK_INT >= 29) MediaStore.Audio.Media.RELATIVE_PATH else MediaStore.Audio.Media.DATA
        val selection = names.joinToString(" OR ") { "$column LIKE ?" }
        val args = names.map { "%$it%" }.toTypedArray()
        runCatching {
            context.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Audio.Media._ID), selection, args, null,
            )?.use { it.moveToFirst() } ?: false
        }.getOrDefault(false)
    }
}
