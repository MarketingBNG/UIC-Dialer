export type Role = "ADMIN" | "MANAGER" | "AGENT";
export type Direction = "INCOMING" | "OUTGOING" | "MISSED" | "UNKNOWN";
export type CallStatus = "PENDING_UPLOAD" | "UPLOADED" | "TRANSCRIBING" | "TRANSCRIBED" | "FAILED" | "NO_RECORDING";
/** How an outgoing call was dialled; null for incoming calls and older rows. */
export type DialVia = "LAPTOP" | "APP" | "PHONE_DIALER";

export interface Me {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  team: string | null;
  pictureUrl: string | null;
}
export interface UserRef {
  id: string;
  name: string | null;
  email: string;
}
export interface CallItem {
  id: string;
  phoneE164: string | null;
  phoneRaw: string | null;
  contactName: string | null;
  direction: Direction;
  startedAt: string;
  durationS: number | null;
  status: CallStatus;
  /** The phone's call-log type (MISSED, REJECTED, ...); null for calls known only from a recording. */
  logType?: string | null;
  via?: DialVia | null;
  /** The rep's own number the call used (from its SIM); absent on older servers/apps. */
  fromNumber?: string | null;
  simSlot?: number | null;
  simCarrier?: string | null;
  user: UserRef;
  /** tag: VOICEMAIL / NO_SPEECH when there was no real talk (not translated or summarized). */
  transcript: { language: string | null; tag?: string | null } | null;
  /** Overall AI score (0..100); absent on older servers. */
  score?: number | null;
  /** The lead (CRM contact) with this number: its name and owner; null when the number isn't a lead. */
  lead?: { id: string; name: string | null; company: string | null; owner: UserRef | null } | null;
}
export interface CallPage {
  items: CallItem[];
  nextCursor: string | null;
}
export interface CallDetail extends Omit<CallItem, "transcript" | "score"> {
  score?: ScoreDto | null;
  scorePending?: boolean;
  filePath: string | null;
  /** Set when the retention setting deleted the audio (transcript kept). */
  audioDeletedAt?: string | null;
  crm?: CallCrm;
  mimeType: string | null;
  fileSize: string | null;
  transcript: {
    text: string;
    language: string | null;
    provider: string | null;
    /** VOICEMAIL / NO_SPEECH: no real talk, so no translation or summary. */
    tag?: string | null;
    /** Provider segments; after translation each object also carries `en`. */
    segments: unknown;
    textEn?: string | null;
    translationModel?: string | null;
    translationPending?: boolean;
    /** AI summary (Milestone 5); absent on older servers, null until summarized. */
    summary?: string | null;
    actionItems?: string[] | null;
    sentiment?: Sentiment | null;
    tags?: string[] | null;
    speakerRoles?: SpeakerRole[] | null;
    summaryModel?: string | null;
    summaryPending?: boolean;
  } | null;
}
export type Sentiment = "positive" | "neutral" | "negative" | "mixed";
export interface SpeakerRole {
  speaker: string;
  role: "Agent" | "Customer" | "Unknown";
}
export interface CompressionStats {
  compressedCalls: number;
  bytesSaved: number;
  /** Transcribed recordings above 40 kbps not compressed or queued yet. */
  eligibleCalls: number;
  queuedJobs: number;
}
export interface TranslateBackfillResult {
  queued: number;
}
export interface User {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  team: string | null;
  active: boolean;
  excludedNumbers: string[];
  lastLoginAt: string | null;
  createdAt: string;
  _count?: { calls: number };
  targetCallsPerDay?: number | null;
  targetTalkMinPerDay?: number | null;
}
export interface DeviceSim {
  key: string;
  slot: number | null;
  carrier: string | null;
  number: string | null;
  /** SIM | USER | ADMIN */
  numberSetBy: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  isNew: boolean;
}
export interface Device {
  id: string;
  userId: string;
  installId: string;
  model: string | null;
  androidVersion: string | null;
  appVersion: string | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  pendingCount: number;
  permissionsOk: boolean;
  freeBytes: string | null;
  revokedAt: string | null;
  createdAt: string;
  user: UserRef;
  /** M4 heartbeat fields; absent/null on older servers or apps. */
  standbyBucket?: number | null;
  standbyBucketName?: string | null;
  lastStopReason?: number | null;
  calls7d?: number | null;
  recordings7d?: number | null;
  autostartIntent?: string | null;
  defaultDialer?: string | null;
  /** Android refused the older-recordings foreground notification; uploads run in short bursts. */
  backlogFgsError?: string | null;
  throttled?: boolean;
  callsWithoutRecordings?: boolean;
  /** Recorded under half of 10+ calls this week. */
  fewRecordings?: boolean;
  sims?: DeviceSim[];
}
export interface Stats {
  calls: Partial<Record<CallStatus, number>>;
  jobs: Record<string, number>;
  disk: { freeBytes: number; totalBytes: number; usedPct: number };
  staleDevices: number;
  fireflies?: FirefliesAlert;
  /** Absent on servers before alerting (M1). */
  throughput?: Throughput;
  alertsEnabled?: boolean;
  /** Absent on servers before cost tracking (M2). */
  translation?: TranslationAlert;
  /** Absent on servers before recording compression (M2b). */
  compression?: CompressionStats;
}
export interface TranslationAlert {
  month: string;
  spentUsd: number;
  budgetUsd: number;
  pct: number;
  capped: boolean;
}
export interface TranslationUsage extends TranslationAlert {
  translatedThisMonth: number;
  /** AI summaries this month (same Claude cap); absent on older servers. */
  summarizedThisMonth?: number;
  avgCostUsd: number | null;
  queuedJobs: number;
}
export interface CostSettingsPatch {
  translateBudgetUsd?: number;
}
export interface Throughput {
  jobsPerHour: number;
  doneLastHour: number;
  failureRatePct: number;
  failureRatePctLastHour: number;
  avgJobSeconds: number | null;
  backlogCalls: number;
  backlogMinutes: number;
  backlogEtaMonths: number | null;
  backlogEtaHours: number | null;
}
export interface FirefliesAlert {
  month: string;
  pct: number;
  thresholds: number[];
  blocked: boolean;
  lastError: string | null;
  backlogGateReached: boolean;
  waitingBudgetJobs: number;
}
export interface FirefliesUsage {
  month: string;
  enabled: boolean;
  budgetMinutes: number;
  liveReservePct: number;
  usedMinutes: number;
  reservedMinutes: number;
  pct: number;
  thresholds: number[];
  approvedBacklogCount: number;
  backlogSent: number;
  deleteAfterFetch: boolean;
  blocked: boolean;
  blockedUntil: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  waitingBudgetJobs: number;
}
export interface FirefliesSettingsPatch {
  enabled?: boolean;
  budgetMinutes?: number;
  liveReservePct?: number;
  approvedBacklogCount?: number;
  deleteAfterFetch?: boolean;
  clearBlock?: boolean;
}
export interface DeviceConfig {
  recorderFolders: string[];
  liveNetwork: "any" | "wifi";
  backlogEnabled: boolean;
  backlogCutoffDays: number;
  maxParallelUploads: number;
  compressAudio: boolean;
  businessOnly: boolean;
}
/** Admin privacy settings: retentionMonths null = keep audio forever (default). */
export interface PrivacySettings {
  retentionMonths: number | null;
  maskPii: boolean;
  /** Stage 3: days win over months; null = off. */
  retentionDays?: number | null;
  /** Stage 3: also blank transcript text (summary and score kept). */
  retentionDeleteTranscript?: boolean;
}
export interface ClientNumber {
  id: string;
  raw: string;
  label: string | null;
  createdAt: string;
}
export interface ClientImportResult {
  added: number;
  updated: number;
  rejected: number;
  rejectedSample: string[];
}
export type AuditAction =
  | "PLAY"
  | "DOWNLOAD"
  | "SEARCH"
  | "DELETE"
  | "USER_CHANGE"
  | "DEVICE_REVOKE"
  | "SETTINGS_CHANGE"
  | "CLIENT_LIST_CHANGE"
  | "RETENTION_DELETE"
  | "EXPORT"
  | "CRM_SYNC"
  | "CALL_LIST_CHANGE"
  | "CONTACT_IMPORT"
  | "DNC_CHANGE"
  | "LEAD_SOURCE_CHANGE"
  | "OUTCOME_CHANGE"
  | "TEMPLATE_CHANGE"
  | "TARGET_CHANGE";
/** Zoho CRM sync state of one call (absent on older servers). */
export interface CallCrm {
  enabled: boolean;
  status: "SYNCED" | "NO_MATCH" | "ERROR" | null;
  module: string | null;
  recordId: string | null;
  recordUrl: string | null;
  syncedAt: string | null;
  error: string | null;
  attempts: number;
}
export interface CrmStats {
  enabled: boolean;
  synced: number;
  noMatch: number;
  errors: number;
  queued: number;
  lastError: string | null;
  /** Whole sync paused by an auth / Zoho outage error (retries with backoff). */
  failing?: boolean;
  globalError?: string | null;
}
export interface AuditEntry {
  id: string;
  action: AuditAction | string;
  callId: string | null;
  detail: unknown;
  ip: string | null;
  createdAt: string;
  user: UserRef | null;
}
export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}
export interface Settings {
  deviceConfig: DeviceConfig;
  latestApp: { versionCode: number; versionName: string; sha256: string; fileName: string } | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable error code (DNC, LIST_PAUSED, NOT_ASSIGNED, OUTCOME_NEEDS_DATE, EXISTS). */
    public code?: string,
    /** The parsed JSON error body (e.g. contactId on EXISTS). */
    public body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Called on any 401 so the app drops back to the sign-in page. */
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

/**
 * Same-origin fetch: the browser sends the session cookie and, for non-GET requests,
 * the Origin header the server's CSRF check expects. Content-Type is set only with a
 * body, because Fastify rejects an empty JSON body.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, "Your session has ended. Sign in again.");
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let code: string | undefined;
    let body: Record<string, unknown> | undefined;
    try {
      const j = (await res.json()) as { error?: string; code?: string };
      body = j as Record<string, unknown>;
      if (j.error) msg = j.error;
      if (typeof j.code === "string") code = j.code;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg, code, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Builds a query string, dropping empty values (the server rejects e.g. "direction="). */
/** One problem a staff phone / laptop / browser reported (Health page). */
export interface ClientErrorDto {
  id: string;
  user: { id: string; name: string };
  source: "android" | "desktop" | "web";
  device: string | null;
  kind: string;
  message: string;
  createdAt: string;
}

/** Tells admins about a problem on this computer. Fire-and-forget: a failed report is ignored. */
export function reportClientError(kind: string, message: string) {
  api("/v1/client-errors", { method: "POST", body: { kind, message: message.slice(0, 300) } }).catch(() => {});
}

export function qs(params: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const isManager = (r?: Role) => r === "ADMIN" || r === "MANAGER";

// Activity tracker (dialer plan): contacts are keyed by phone number and owned by the
// rep who first logged an activity for them.
export type ContactStatus = "NEW" | "INTERESTED" | "CALL_BACK" | "NOT_INTERESTED" | "NO_ANSWER";
export type ActivityType = "CALL" | "WHATSAPP" | "NOTE";
export type CallOutcome = "INTERESTED" | "CALL_BACK" | "NOT_INTERESTED" | "NO_ANSWER";
export interface Contact {
  id: string;
  phoneE164: string;
  name: string | null;
  company: string | null;
  status: ContactStatus;
  nextFollowUpAt: string | null;
  lastActivityAt: string | null;
  owner: UserRef | null;
  city?: string | null;
  source?: string | null;
  dnc?: DncInfo | null;
}
export interface DncInfo {
  reason: string | null;
  createdAt: string;
}
export interface ContactListItem extends Contact {
  activityCount: number;
}
export interface ContactPage {
  items: ContactListItem[];
  nextCursor: string | null;
}
export interface Activity {
  id: string;
  clientId: string;
  type: ActivityType;
  outcome: CallOutcome | null;
  note: string | null;
  followUpAt: string | null;
  durationS: number | null;
  occurredAt: string;
  callId: string | null;
  via?: DialVia | null;
  outcomeId?: string | null;
  outcomeLabel?: string | null;
  outcomeColor?: string | null;
  callListItemId?: string | null;
  channel?: MessageChannel | null;
  templateId?: string | null;
}
export type MessageChannel = "WHATSAPP" | "SMS";
export type TimelineItem =
  | (Activity & {
      kind: "activity";
      user: UserRef;
      call?: { id: string; status: CallStatus; summary: string | null; hasAudio: boolean } | null;
    })
  | {
      kind: "call";
      id: string;
      direction: Direction;
      startedAt: string;
      durationS: number | null;
      status: CallStatus;
      via?: DialVia | null;
      user: UserRef;
      hasAudio: boolean;
      summary: string | null;
    };
export interface ContactDetail {
  contact: Contact;
  timeline: TimelineItem[];
}
export interface ContactPatch {
  name?: string | null;
  company?: string | null;
  status?: ContactStatus;
  nextFollowUpAt?: string | null;
  ownerId?: string;
  city?: string | null;
}
export interface RepStats {
  user: UserRef;
  callsMade: number;
  answered: number;
  talkTimeS: number;
  whatsapp: number;
  followUpsDueToday: number;
  overdue: number;
}

// Stage 1: today's follow-ups (contact follow-ups + missed-call tasks) and the rep's phone heartbeat.
export interface FollowUpItem {
  key: string;
  kind: "FOLLOW_UP" | "MISSED_CALL" | "NEW_LEAD";
  contactId: string | null;
  taskId: string | null;
  phoneE164: string;
  name: string | null;
  company: string | null;
  status: ContactStatus | null;
  dueAt: string;
  overdue: boolean;
  lastNote: string | null;
  /** Contact source ("Website", "csv", "manual"); absent on older servers. */
  source?: string | null;
}
export interface FollowUpsToday {
  items: FollowUpItem[];
  upcoming: FollowUpItem[];
  counts: { overdue: number; today: number };
}
export interface PhoneStatus {
  lastSeenAt: string | null;
  online: boolean;
  model: string | null;
  appVersion: string | null;
}

// Stage 2 + 3 ------------------------------------------------------------------------------------

export type ContactFilterKey = "interested" | "callback" | "never" | "mine" | "dnc";
export type OutcomeRule = "NONE" | "ASK_FOLLOW_UP" | "ASK_MEETING" | "ASK_CALLBACK" | "CLOSE_LEAD" | "RETRY" | "REMOVE_FROM_LISTS";
export interface OutcomeDto {
  id: string;
  key: string | null;
  label: string;
  color: string;
  sortOrder: number;
  active: boolean;
  baseOutcome: CallOutcome;
  rule: OutcomeRule;
  retryHours: number | null;
  addToDnc: boolean;
}
export interface OutcomeInput {
  label: string;
  color: string;
  baseOutcome: CallOutcome;
  rule: OutcomeRule;
  retryHours?: number | null;
  addToDnc?: boolean;
  active?: boolean;
}
export interface ScriptSection {
  heading: string;
  text: string;
}
export interface ScriptDto {
  id: string;
  name: string;
  sections: ScriptSection[];
  active: boolean;
  updatedAt: string;
}
export interface TemplateDto {
  id: string;
  name: string;
  body: string;
  whatsapp: boolean;
  sms: boolean;
  active: boolean;
  sortOrder: number;
}

export type CallListState = "ACTIVE" | "PAUSED" | "ARCHIVED";
export type CallListItemState = "PENDING" | "IN_PROGRESS" | "DONE" | "SKIPPED" | "REMOVED";
export interface ListProgress {
  total: number;
  done: number;
  pending: number;
  inProgress: number;
  skipped: number;
  removed: number;
}
export interface ListResult {
  outcomeId: string | null;
  label: string;
  color: string;
  count: number;
}
export interface ListSummary {
  id: string;
  name: string;
  state: CallListState;
  script: { id: string; name: string } | null;
  assignees: UserRef[];
  createdAt: string;
  progress: ListProgress;
  results: ListResult[];
}
export interface ContactFilter {
  q?: string;
  status?: ContactStatus;
  filter?: ContactFilterKey;
  ownerId?: string;
}
export interface CreateList {
  name: string;
  scriptId?: string | null;
  assigneeIds: string[];
  contactIds?: string[];
  filter?: ContactFilter;
}
export interface AddItemsResult {
  added: number;
  excludedDnc: number;
  excludedDuplicate: number;
}
export interface ListItemDto {
  id: string;
  position: number;
  state: CallListItemState;
  attempts: number;
  retryAt: string | null;
  lastOutcome: { id: string; label: string; color: string } | null;
  lastActivityAt: string | null;
  claimedBy: UserRef | null;
  doneBy: UserRef | null;
  contact: Contact;
}
export interface ListDetail {
  list: ListSummary;
  items: ListItemDto[];
  nextCursor: string | null;
}
export interface MyList extends Omit<ListSummary, "assignees" | "script"> {
  script: ScriptDto | null;
  createdBy?: UserRef | null;
}
export interface NextResponse {
  item: ListItemDto | null;
  progress: ListProgress;
  results: ListResult[];
  code?: "LIST_EMPTY";
}

export interface ImportMapping {
  name: number | null;
  phone: number;
  company: number | null;
  city: number | null;
}
export interface ImportPreview {
  columns: string[];
  hasHeader: boolean;
  mapping: ImportMapping;
  total: number;
  new: number;
  existing: number;
  /** Of `existing`: contacts outside your scope (another team's). The import leaves them alone. */
  existingElsewhere: number;
  bad: number;
  duplicateInFile: number;
  dnc: number;
  badSample: string[];
  sample: { name: string | null; phoneE164: string | null; company: string | null; city: string | null; status: "new" | "existing" | "bad" | "dnc" }[];
}
export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  /** Numbers that are already another team's contacts: not changed, not added to the list. */
  ownedElsewhere: number;
  dncSkippedFromList: number;
  contactIds: string[];
}
export interface NewLeadResult {
  contact: Contact;
  leadId: string | null;
  assignedTo: UserRef | null;
}

export type DncSource = "MANUAL" | "OUTCOME" | "IMPORT";
export interface DncDto {
  id: string;
  phoneE164: string | null;
  raw: string;
  reason: string | null;
  source: DncSource;
  createdBy: UserRef | null;
  createdAt: string;
}
export interface DncPage {
  items: DncDto[];
  nextCursor: string | null;
  count: number;
}

export interface TeamStatsRow {
  user: UserRef;
  calls: number;
  connected: number;
  talkTimeS: number;
  connectRate: number | null;
  firstCallAt: string | null;
  lastCallAt: string | null;
  messages: number;
  followUpsDone: number;
  followUpsOverdue: number;
  target: { callsPerDay: number | null; talkMinPerDay: number | null };
  vsTarget: { callsPct: number | null; talkPct: number | null };
}
export interface TeamStats {
  from: string;
  to: string;
  days: number;
  totals: { calls: number; connected: number; talkTimeS: number; connectRate: number | null; messages: number; followUpsDone: number; followUpsOverdue: number };
  items: TeamStatsRow[];
  leaderboard: { userId: string; rank: number; calls: number; connected: number; talkTimeS: number }[];
}
export interface MeToday {
  calls: number;
  connected: number;
  talkTimeS: number;
  messages: number;
  target: { callsPerDay: number | null; talkMinPerDay: number | null };
  progress: { callsPct: number | null; talkPct: number | null };
}

export interface FieldMap {
  name?: string;
  phone?: string;
  company?: string;
  city?: string;
  note?: string;
}
export interface LeadSourceDto {
  id: string;
  name: string;
  active: boolean;
  repPool: UserRef[];
  fieldMap: FieldMap | null;
  tokenHint: string;
  webhookUrl: string;
  createdAt: string;
  stats: { last7d: number; lastAt: string | null };
}
export interface LeadEventDto {
  id: string;
  source: { id: string; name: string } | null;
  externalId: string | null;
  contact: { id: string; name: string | null; phoneE164: string } | null;
  assignedTo: UserRef | null;
  status: string;
  payload: unknown;
  createdAt: string;
}

export interface ScoreDto {
  overall: number;
  scriptAdherence: number | null;
  sentiment: Sentiment;
  objections: { objection: string; handled: boolean }[];
  nextStep: string | null;
  strengths: string[];
  improvements: string[];
  model: string;
  createdAt: string;
}
export interface Features {
  scoring: boolean;
  summaries: boolean;
}

/**
 * Template rendering, identical on the server and Android: {name} = first word of the contact name (else "there"),
 * {rep} = the rep's first name. Case-sensitive; unknown placeholders stay. split/join keeps "$" in names literal.
 * Vectors: ("Hi {name}, {rep} here","Priya Shah","Kirti Arora") → "Hi Priya, Kirti here"; ("Hi {name}",null,"Kirti") →
 * "Hi there"; ("{x} {name}","A","B") → "{x} A".
 */
export function renderTemplate(body: string, contactName: string | null | undefined, repName: string | null | undefined) {
  const first = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] ?? "";
  const name = first(contactName) || "there";
  const rep = first(repName);
  return body.split("{name}").join(name).split("{rep}").join(rep);
}
/** A user's display name for {rep}: the name, else the email local part. */
export const repName = (u: { name: string | null; email: string }) => (u.name?.trim() ? u.name : (u.email.split("@")[0] ?? ""));
