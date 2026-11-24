package com.usaindiacfo.uicdialer.data.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Mirrors server/src/routes/*.ts. Timestamps are ISO-8601 strings; BigInt columns arrive as strings.

@Serializable enum class Role { ADMIN, MANAGER, AGENT }
@Serializable enum class Direction { INCOMING, OUTGOING, MISSED, UNKNOWN }
@Serializable enum class CallSource { LIVE, BACKLOG, IMPORT }
/** NO_RECORDING: a call-log entry without a recording; only sent to clients that ask with ?v=2. */
@Serializable enum class CallStatus { PENDING_UPLOAD, UPLOADED, TRANSCRIBING, TRANSCRIBED, FAILED, NO_RECORDING }

// ---- Auth -------------------------------------------------------------------

@Serializable
data class DeviceInfo(val installId: String, val model: String?, val androidVersion: String?, val appVersion: String?)

@Serializable data class GoogleLoginRequest(val idToken: String, val device: DeviceInfo)
@Serializable data class RefreshRequest(val refreshToken: String)

@Serializable
data class UserDto(val id: String, val email: String, val name: String? = null, val role: Role) {
    val isAdmin get() = role == Role.ADMIN
    /** Admin tab (users/devices) is visible to managers too; server settings are admin-only. */
    val canManage get() = role == Role.ADMIN || role == Role.MANAGER
}

@Serializable
data class AuthResponse(val accessToken: String, val refreshToken: String, val expiresIn: Long, val user: UserDto)

// ---- Sync -------------------------------------------------------------------

@Serializable data class CheckRequest(val hashes: List<String>)
@Serializable data class CheckResponse(val known: List<String>)

@Serializable
data class CreateCallRequest(
    val originalSha256: String,
    val phoneNumber: String? = null,
    val contactName: String? = null,
    val direction: Direction = Direction.UNKNOWN,
    val startedAt: String,
    val durationS: Int? = null,
    val originalName: String? = null,
    val source: CallSource = CallSource.LIVE,
    /** Only APP is sent: the rep dialled this call from the app. */
    val via: DialVia? = null,
    val simKey: String? = null,
    val simSlot: Int? = null,
    val simCarrier: String? = null,
)

/** One CallLog row for POST /v1/calls/log. type: INCOMING, OUTGOING, MISSED, REJECTED, BLOCKED, VOICEMAIL, ... */
@Serializable
data class CallLogEntryRequest(
    val phoneNumber: String? = null,
    val contactName: String? = null,
    val type: String,
    val startedAt: String,
    val durationS: Int? = null,
    val simKey: String? = null,
    val simSlot: Int? = null,
    val simCarrier: String? = null,
    /** Only APP is sent: the rep dialled this call from the app. */
    val via: DialVia? = null,
)
@Serializable data class CallLogBatchRequest(val entries: List<CallLogEntryRequest>)
@Serializable data class CallLogResult(val callId: String, val created: Boolean = false)
@Serializable data class CallLogResponse(val results: List<CallLogResult> = emptyList())

/** 201 → uploadPath set, alreadyUploaded=false; 200 → alreadyUploaded=true (skip the PUT). */
@Serializable data class CreateCallResponse(val callId: String, val alreadyUploaded: Boolean, val uploadPath: String? = null)
@Serializable data class UploadResponse(
    val callId: String,
    val alreadyUploaded: Boolean,
    /** False when only part of a resumable upload arrived; continue from [received]. Older servers omit it. */
    val complete: Boolean = true,
    val received: Long? = null,
)

/** GET /v1/calls/:id/audio/progress: bytes of this file the server already has. */
@Serializable data class UploadProgress(val complete: Boolean, val received: Long)

// ---- Device -----------------------------------------------------------------

@Serializable
data class DeviceConfig(
    val recorderFolders: List<String> = emptyList(),
    val liveNetwork: String = "any", // "any" | "wifi"
    val backlogEnabled: Boolean = true,
    val backlogCutoffDays: Int = 365,
    val maxParallelUploads: Int = 2,
    val compressAudio: Boolean = true,
    val businessOnly: Boolean = false,
    /** Only present on GET /v1/device/config (per user); stripped on PUT. */
    val excludedNumbers: List<String> = emptyList(),
)

@Serializable
data class HeartbeatRequest(
    val appVersion: String? = null,
    val pendingCount: Int,
    val permissionsOk: Boolean,
    val freeBytes: Long? = null,
    val lastSyncAt: String? = null,
    /** UsageStatsManager bucket (API 28+). */
    val standbyBucket: Int? = null,
    /** WorkManager stop reason of the last stopped sync job (API 31+). */
    val lastStopReason: Int? = null,
    /** Call-log calls of 30 s+ in the last 7 days; null without call-log permission. */
    val calls7d: Int? = null,
    val recordings7d: Int? = null,
    /** OEM autostart screen that resolves on this phone (package/class). */
    val autostartIntent: String? = null,
    val defaultDialer: String? = null,
    /** SIMs in the phone; null without phone-state permission (server keeps what it has). */
    val sims: List<SimReport>? = null,
)

@Serializable data class SimReport(val key: String, val slot: Int? = null, val carrier: String? = null, val number: String? = null)

/** GET /v1/device/sims. numberSetBy: SIM | USER | ADMIN | null. */
@Serializable data class DeviceSimDto(val key: String, val slot: Int? = null, val carrier: String? = null, val number: String? = null, val numberSetBy: String? = null)
@Serializable data class DeviceSims(val sims: List<DeviceSimDto> = emptyList())
@Serializable data class SimNumberRequest(val simKey: String, val number: String?)

@Serializable
data class LatestApp(
    val available: Boolean,
    val versionCode: Int? = null,
    val versionName: String? = null,
    val sha256: String? = null,
    val fileName: String? = null,
    val downloadPath: String? = null,
)

// ---- Dashboard API (/api, Bearer accepted) -----------------------------------

@Serializable
data class Me(val id: String, val email: String, val name: String? = null, val role: Role, val team: String? = null, val pictureUrl: String? = null)

@Serializable data class UserRef(val id: String, val name: String? = null, val email: String)
@Serializable data class TranscriptLang(val language: String? = null)

@Serializable
data class CallListItem(
    val id: String,
    val phoneE164: String? = null,
    val phoneRaw: String? = null,
    val contactName: String? = null,
    val direction: Direction,
    val startedAt: String,
    val durationS: Int? = null,
    val status: CallStatus,
    /** The phone's call-log type (MISSED, REJECTED, OUTGOING, ...); null for calls known only from a recording. */
    val logType: String? = null,
    val user: UserRef,
    val transcript: TranscriptLang? = null,
    val via: DialVia? = null,
)

@Serializable data class CallPage(val items: List<CallListItem>, val nextCursor: String? = null)

/** Query for GET /api/calls. q = transcript full-text search; from/to are ISO datetimes with offset. */
data class CallFilter(
    val q: String? = null,
    val phone: String? = null,
    val userId: String? = null,
    val direction: Direction? = null,
    val status: CallStatus? = null,
    val from: String? = null,
    val to: String? = null,
)

/**
 * segments is provider-specific JSON (e.g. [{start,end,text}]); null when absent. After translation each
 * segment also carries "en". textEn/translationModel are null until the English version exists.
 */
@Serializable
data class Transcript(
    val text: String,
    val language: String? = null,
    val provider: String,
    val segments: JsonElement? = null,
    val textEn: String? = null,
    val translationModel: String? = null,
    val translationPending: Boolean = false,
    /** AI summary (server Milestone 5); null until summarized or on older servers. */
    val summary: String? = null,
    val actionItems: List<String>? = null,
    /** positive | neutral | negative | mixed */
    val sentiment: String? = null,
    val tags: List<String>? = null,
    val speakerRoles: List<SpeakerRole>? = null,
    val summaryPending: Boolean = false,
)

/** role is "Agent" (the staff member), "Customer" or "Unknown". */
@Serializable data class SpeakerRole(val speaker: String, val role: String)

@Serializable
data class CallDetail(
    val id: String,
    val userId: String,
    val deviceId: String? = null,
    val phoneE164: String? = null,
    val phoneRaw: String? = null,
    val contactName: String? = null,
    val direction: Direction,
    val source: CallSource,
    val startedAt: String,
    val durationS: Int? = null,
    val originalName: String? = null,
    val mimeType: String? = null,
    val fileSize: String? = null,
    val status: CallStatus,
    val logType: String? = null,
    val uploadedAt: String? = null,
    val createdAt: String,
    val user: UserRef,
    val transcript: Transcript? = null,
    /** Some server builds report this next to the transcript instead of inside it; either counts. */
    val translationPending: Boolean = false,
    /** Set when the server's retention setting deleted the audio (transcript kept). */
    val audioDeletedAt: String? = null,
    /** Zoho CRM sync state; absent on older servers. */
    val crm: CallCrm? = null,
    val via: DialVia? = null,
    /** AI call score (stage 3); null until scored or when scoring is off. */
    val score: CallScore? = null,
    val scorePending: Boolean = false,
)

@Serializable
data class CallCrm(
    val enabled: Boolean = false,
    val status: String? = null,
    val module: String? = null,
)

/** One-line Zoho CRM state for the call detail, or null when sync is off. */
fun CallCrm.label(): String? = if (!enabled) null else when (status) {
    "SYNCED" -> if (module == "Contacts") "Synced to contact" else "Synced to lead"
    "NO_MATCH" -> "No matching lead or contact"
    "ERROR" -> "Sync failed"
    else -> "Waiting to sync"
}

@Serializable data class CallCount(val calls: Int = 0)

@Serializable
data class AdminUser(
    val id: String,
    val email: String,
    val name: String? = null,
    val pictureUrl: String? = null,
    val role: Role,
    val team: String? = null,
    val active: Boolean,
    val excludedNumbers: List<String> = emptyList(),
    val lastLoginAt: String? = null,
    val createdAt: String,
    @SerialName("_count") val count: CallCount = CallCount(),
)

@Serializable
data class CreateUserRequest(val email: String, val name: String? = null, val role: Role = Role.AGENT, val team: String? = null)

/** Null fields are not sent. To clear a team, pass clearTeam = true to [ApiClient.patchUser]. */
@Serializable
data class UserPatch(
    val name: String? = null,
    val role: Role? = null,
    val team: String? = null,
    val active: Boolean? = null,
    val excludedNumbers: List<String>? = null,
)

@Serializable
data class DeviceDto(
    val id: String,
    val userId: String,
    val installId: String,
    val model: String? = null,
    val androidVersion: String? = null,
    val appVersion: String? = null,
    val lastSeenAt: String? = null,
    val lastSyncAt: String? = null,
    val pendingCount: Int = 0,
    val permissionsOk: Boolean = false,
    val freeBytes: String? = null,
    val revokedAt: String? = null,
    val createdAt: String,
    val user: UserRef,
    val standbyBucket: Int? = null,
    val standbyBucketName: String? = null,
    val lastStopReason: Int? = null,
    val calls7d: Int? = null,
    val recordings7d: Int? = null,
    val autostartIntent: String? = null,
    val defaultDialer: String? = null,
    val throttled: Boolean = false,
    val callsWithoutRecordings: Boolean = false,
)

@Serializable
data class LatestAppInfo(val versionCode: Int, val versionName: String, val sha256: String, val fileName: String)

@Serializable data class ServerSettings(val deviceConfig: DeviceConfig, val latestApp: LatestAppInfo? = null)

@Serializable data class DiskUsage(val totalBytes: Long, val freeBytes: Long, val usedPct: Int)

@Serializable
data class Stats(
    val calls: Map<String, Int> = emptyMap(),
    val jobs: Map<String, Int> = emptyMap(),
    val disk: DiskUsage,
    val staleDevices: Int,
    /** Absent on servers older than the Fireflies provider. */
    val fireflies: FirefliesStats? = null,
    /** Absent on servers before alerting (M1). */
    val throughput: Throughput? = null,
    val alertsEnabled: Boolean? = null,
    /** Absent on servers before cost tracking (M2). */
    val translation: TranslationStats? = null,
    /** Absent on servers before recording compression (M2b). */
    val compression: CompressionStats? = null,
)

/** Disk freed by re-encoding old recordings; eligible = large transcribed recordings not done or queued yet. */
@Serializable
data class CompressionStats(
    val compressedCalls: Int = 0,
    val bytesSaved: Long = 0,
    val eligibleCalls: Int = 0,
    val queuedJobs: Int = 0,
)

// ---- Claude translation spend (/api/translation/usage, PUT /api/settings/costs) ----

@Serializable
data class TranslationStats(
    val month: String,
    val spentUsd: Double = 0.0,
    val budgetUsd: Double = 0.0,
    val pct: Double = 0.0,
    val capped: Boolean = false,
)

@Serializable
data class TranslationUsage(
    val month: String,
    val spentUsd: Double = 0.0,
    val budgetUsd: Double = 0.0,
    val pct: Double = 0.0,
    val capped: Boolean = false,
    val translatedThisMonth: Int = 0,
    /** AI summaries this month (same Claude cap); null on older servers. */
    val summarizedThisMonth: Int? = null,
    val avgCostUsd: Double? = null,
    val queuedJobs: Int = 0,
    val sarvamOverflow: Boolean = false,
)

/** Null fields are not sent; the server applies only what is present. */
@Serializable
data class CostSettingsPatch(
    val translateBudgetUsd: Double? = null,
    val sarvamOverflow: Boolean? = null,
)

/** Transcription throughput and backlog ETA from GET /api/stats. */
@Serializable
data class Throughput(
    val jobsPerHour: Double = 0.0,
    val doneLastHour: Int = 0,
    val failureRatePct: Double = 0.0,
    val failureRatePctLastHour: Double = 0.0,
    val avgJobSeconds: Int? = null,
    val backlogCalls: Int = 0,
    val backlogMinutes: Int = 0,
    val backlogEtaMonths: Double? = null,
    val backlogEtaHours: Int? = null,
) {
    /** Same wording as the dashboard Health page. */
    fun etaText(): String {
        if (backlogCalls == 0) return "No backlog"
        val parts = buildList {
            backlogEtaMonths?.let { add("${fmt(it)} mo of Fireflies budget") }
            backlogEtaHours?.let { add(if (it >= 48) "${Math.round(it / 24.0)} d at current rate" else "$it h at current rate") }
        }
        return parts.joinToString(" · ").ifEmpty { "Unknown" }
    }

    private fun fmt(d: Double) = if (d == Math.floor(d)) d.toLong().toString() else d.toString()
}

/** POST /api/admin/test-alert response. */
@Serializable data class TestAlertResult(val sent: Boolean = false)

// ---- Fireflies (/api/fireflies/usage, PUT /api/settings/fireflies) ----------

/** Banner subset that GET /api/stats carries. */
@Serializable
data class FirefliesStats(
    val month: String,
    val pct: Double,
    val thresholds: List<Int> = emptyList(),
    val blocked: Boolean = false,
    val lastError: String? = null,
    val backlogGateReached: Boolean = false,
    val waitingBudgetJobs: Int = 0,
)

@Serializable
data class FirefliesUsage(
    val month: String,
    val enabled: Boolean,
    val budgetMinutes: Int,
    val liveReservePct: Double,
    val usedMinutes: Int,
    val reservedMinutes: Int,
    val pct: Double,
    val thresholds: List<Int> = emptyList(),
    val approvedBacklogCount: Int,
    val backlogSent: Int,
    val deleteAfterFetch: Boolean,
    val blocked: Boolean = false,
    val blockedUntil: String? = null,
    val lastError: String? = null,
    val lastErrorAt: String? = null,
    val waitingBudgetJobs: Int = 0,
) {
    val backlogGateReached get() = backlogSent >= approvedBacklogCount
}

/** Null fields are not sent; the server applies only what is present. */
@Serializable
data class FirefliesPatch(
    val enabled: Boolean? = null,
    val budgetMinutes: Int? = null,
    val liveReservePct: Double? = null,
    val approvedBacklogCount: Int? = null,
    val deleteAfterFetch: Boolean? = null,
    val clearBlock: Boolean? = null,
)

/** [code] (stage 2+): DNC, LIST_PAUSED, NOT_ASSIGNED, OUTCOME_NEEDS_DATE, EXISTS. */
@Serializable data class ErrorBody(val error: String? = null, val code: String? = null)

// ---- Privacy (M3): client list, retention / PII settings, audit log ---------

/** GET /v1/device/client-numbers: sha256 hex of each client number's key (see PrivacyFilter.key). */
@Serializable data class ClientNumberHashes(val hashes: List<String> = emptyList())

@Serializable data class ClientNumberDto(val id: String, val raw: String, val label: String? = null, val createdAt: String)
@Serializable data class ClientNumberList(val items: List<ClientNumberDto> = emptyList(), val count: Int = 0)
@Serializable data class AddClientNumber(val number: String, val label: String? = null)
@Serializable data class ClientCsv(val csv: String)

@Serializable
data class ClientImportResult(val added: Int = 0, val updated: Int = 0, val rejected: Int = 0, val rejectedSample: List<String> = emptyList())

/** retentionMonths null = keep audio forever (default). */
@Serializable data class PrivacySettings(val retentionMonths: Int? = null, val maskPii: Boolean = false)

/** [action] stays a String so new server actions never break decoding. */
@Serializable
data class AuditEntry(
    val id: String,
    val action: String,
    val callId: String? = null,
    val detail: JsonElement? = null,
    val ip: String? = null,
    val createdAt: String,
    val user: UserRef? = null,
)

@Serializable data class AuditPage(val items: List<AuditEntry> = emptyList(), val nextCursor: String? = null)

/** POST /api/admin/translate-backfill response. */
@Serializable data class TranslateBackfill(val queued: Int = 0)

// ---- Activity tracker (dialer): /v1/activities, /v1/contacts -------------------

@Serializable enum class ContactStatus { NEW, INTERESTED, CALL_BACK, NOT_INTERESTED, NO_ANSWER }
@Serializable enum class ActivityType { CALL, WHATSAPP, NOTE }
@Serializable enum class CallOutcome { INTERESTED, CALL_BACK, NOT_INTERESTED, NO_ANSWER }

@Serializable
data class ContactDto(
    val id: String,
    val phoneE164: String,
    val name: String? = null,
    val company: String? = null,
    val status: ContactStatus = ContactStatus.NEW,
    val nextFollowUpAt: String? = null,
    val lastActivityAt: String? = null,
    val owner: UserRef? = null,
    val city: String? = null,
    /** Lead source name, "csv" or "manual". */
    val source: String? = null,
    /** Set when the number is on the do-not-call list. */
    val dnc: DncInfo? = null,
)

@Serializable data class DncInfo(val reason: String? = null, val createdAt: String = "")

@Serializable
data class ActivityDto(
    val id: String,
    val clientId: String,
    val type: ActivityType,
    val outcome: CallOutcome? = null,
    val note: String? = null,
    val followUpAt: String? = null,
    val durationS: Int? = null,
    val occurredAt: String,
    val callId: String? = null,
    val via: DialVia? = null,
    val outcomeId: String? = null,
    val outcomeLabel: String? = null,
    /** "#RRGGBB" */
    val outcomeColor: String? = null,
    val callListItemId: String? = null,
    /** "WHATSAPP" | "SMS", only on WHATSAPP activities. */
    val channel: String? = null,
    val templateId: String? = null,
)

/** POST /v1/activities. Idempotent by [clientId] (a UUID made on the phone). Null fields are not sent. */
@Serializable
data class ActivityBatchRequest(val items: List<CreateActivityRequest>)

@Serializable
data class ActivityBatchResult(val clientId: String? = null, val ok: Boolean, val status: Int? = null, val error: String? = null)

@Serializable
data class ActivityBatchResponse(val results: List<ActivityBatchResult>)

@Serializable
data class CreateActivityRequest(
    val clientId: String,
    val phone: String,
    val type: ActivityType,
    val outcome: CallOutcome? = null,
    val note: String? = null,
    val followUpAt: String? = null,
    val durationS: Int? = null,
    val occurredAt: String,
    val name: String? = null,
    val company: String? = null,
    val via: DialVia? = null,
    val outcomeId: String? = null,
    val callListItemId: String? = null,
    val channel: String? = null,
    val templateId: String? = null,
)

@Serializable data class CreateActivityResponse(val activity: ActivityDto, val contact: ContactDto)
@Serializable data class ContactPage(val items: List<ContactDto> = emptyList(), val nextCursor: String? = null)
@Serializable data class ContactList(val items: List<ContactDto> = emptyList())
@Serializable data class ContactByPhone(
    val contact: ContactDto? = null,
    val activities: List<ActivityDto> = emptyList(),
    /** AI summary of the newest transcribed call on this number (caller card). */
    val lastSummary: String? = null,
)

// ---- Stage 1: via labels and follow-ups (/v1/followups) ---------------------

/** How an outgoing call was started. Null on old rows and on incoming/missed calls. */
@Serializable enum class DialVia { LAPTOP, APP, PHONE_DIALER }

fun DialVia?.label(): String? = when (this) {
    DialVia.LAPTOP -> "via laptop"
    DialVia.APP -> "via app"
    DialVia.PHONE_DIALER -> "via phone dialer"
    null -> null
}

/** NEW_LEAD only arrives with ?v=2 (older APKs would fail to decode it). */
@Serializable enum class FollowUpKind { FOLLOW_UP, MISSED_CALL, NEW_LEAD }

@Serializable
data class FollowUpItem(
    val key: String,
    val kind: FollowUpKind,
    val contactId: String? = null,
    val taskId: String? = null,
    val phoneE164: String,
    val name: String? = null,
    val company: String? = null,
    val status: ContactStatus? = null,
    val dueAt: String,
    val overdue: Boolean = false,
    val lastNote: String? = null,
    /** Contact source, e.g. "Website" for "New lead · Website". */
    val source: String? = null,
)

@Serializable data class FollowUpCounts(val overdue: Int = 0, val today: Int = 0)

@Serializable
data class FollowUpsToday(
    val items: List<FollowUpItem> = emptyList(),
    val upcoming: List<FollowUpItem> = emptyList(),
    val counts: FollowUpCounts = FollowUpCounts(),
)

@Serializable data class MissedCallItem(val clientId: String, val phone: String, val occurredAt: String, val callerName: String? = null)
@Serializable data class MissedCallBatch(val items: List<MissedCallItem>)

@Serializable
data class MissedCallResult(
    val clientId: String? = null,
    val ok: Boolean,
    val id: String? = null,
    val state: String? = null,
    val status: Int? = null,
    val error: String? = null,
)

@Serializable data class MissedCallResponse(val results: List<MissedCallResult> = emptyList())

/** action: "done" | "dismiss" | "snooze" (snooze needs [until]). */
@Serializable data class FollowUpPatch(val action: String, val until: String? = null)

// ---- Stage 2/3: outcomes, scripts, templates, call lists, DNC, targets, scoring ----

enum class OutcomeRule { NONE, ASK_FOLLOW_UP, ASK_MEETING, ASK_CALLBACK, CLOSE_LEAD, RETRY, REMOVE_FROM_LISTS }

/** Unknown or missing rules (a newer server) behave like NONE. */
fun String?.toOutcomeRule(): OutcomeRule = OutcomeRule.entries.firstOrNull { it.name == this } ?: OutcomeRule.NONE

@Serializable
data class OutcomeDto(
    val id: String,
    val key: String? = null,
    val label: String = "",
    val color: String = "#64748B",
    val sortOrder: Int = 0,
    val active: Boolean = true,
    val baseOutcome: CallOutcome = CallOutcome.NO_ANSWER,
    val rule: String = "NONE",
    val retryHours: Int? = null,
    val addToDnc: Boolean = false,
) {
    val ruleEnum: OutcomeRule get() = rule.toOutcomeRule()
}

@Serializable data class OutcomeList(val items: List<OutcomeDto> = emptyList())

@Serializable data class ScriptSection(val heading: String = "", val text: String = "")

@Serializable
data class ScriptDto(val id: String, val name: String = "", val sections: List<ScriptSection> = emptyList(), val active: Boolean = true, val updatedAt: String? = null)

@Serializable
data class TemplateDto(
    val id: String,
    val name: String = "",
    val body: String = "",
    val whatsapp: Boolean = true,
    val sms: Boolean = true,
    val active: Boolean = true,
    val sortOrder: Int = 0,
)

@Serializable data class TemplateList(val items: List<TemplateDto> = emptyList())

@Serializable
data class ListProgress(val total: Int = 0, val done: Int = 0, val pending: Int = 0, val inProgress: Int = 0, val skipped: Int = 0, val removed: Int = 0)

@Serializable data class ListResult(val outcomeId: String? = null, val label: String = "", val color: String = "#64748B", val count: Int = 0)

@Serializable data class OutcomeRef(val id: String, val label: String = "", val color: String = "#64748B")

@Serializable
data class ListItemDto(
    val id: String,
    val position: Int = 0,
    val state: String = "PENDING",
    val attempts: Int = 0,
    val retryAt: String? = null,
    val lastOutcome: OutcomeRef? = null,
    val lastActivityAt: String? = null,
    val contact: ContactDto,
)

@Serializable
data class MyCallList(
    val id: String,
    val name: String = "",
    /** ACTIVE | PAUSED | ARCHIVED */
    val state: String = "ACTIVE",
    val script: ScriptDto? = null,
    val createdAt: String? = null,
    val progress: ListProgress = ListProgress(),
    val results: List<ListResult> = emptyList(),
    /** Who made the list ("assigned by …"). */
    val createdBy: UserRef? = null,
)

@Serializable data class MyCallLists(val items: List<MyCallList> = emptyList())

/** POST /v1/call-lists/:id/next. [item] is null with code LIST_EMPTY when nothing is left. */
@Serializable
data class NextResponse(val item: ListItemDto? = null, val progress: ListProgress = ListProgress(), val results: List<ListResult> = emptyList(), val code: String? = null)

@Serializable data class Target(val callsPerDay: Int? = null, val talkMinPerDay: Int? = null)
@Serializable data class TargetProgress(val callsPct: Int? = null, val talkPct: Int? = null)

@Serializable
data class MeToday(
    val calls: Int = 0,
    val connected: Int = 0,
    val talkTimeS: Int = 0,
    val messages: Int = 0,
    val target: Target = Target(),
    val progress: TargetProgress = TargetProgress(),
)

@Serializable data class Objection(val objection: String = "", val handled: Boolean = false)

@Serializable
data class CallScore(
    val overall: Int = 0,
    val scriptAdherence: Int? = null,
    val sentiment: String = "neutral",
    val objections: List<Objection> = emptyList(),
    val nextStep: String? = null,
    val strengths: List<String> = emptyList(),
    val improvements: List<String> = emptyList(),
    val model: String = "",
    val createdAt: String? = null,
)

@Serializable data class Features(val scoring: Boolean = false, val summaries: Boolean = false)

@Serializable data class DncRequest(val phone: String, val reason: String? = null)

@Serializable
data class DncDto(val id: String, val phoneE164: String? = null, val raw: String = "", val reason: String? = null, val source: String = "MANUAL", val createdAt: String? = null)
