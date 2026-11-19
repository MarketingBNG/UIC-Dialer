import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, isManager, type CallCrm, type CallDetail, type Features, type ScoreDto, type SpeakerRole } from "../api";
import { useMe } from "../App";
import { formatBytes, formatDuration, formatWhen, parseSegments, personName } from "../format";
import { CallButton } from "../dialer";
import { ConfirmDialog, DirectionTag, ErrorBox, Spinner, StatusBadge, ViaTag } from "../ui";

const SPEEDS = [1, 1.25, 1.5, 2];

export function CallDetailPage() {
  const { id = "" } = useParams();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const call = useQuery({ queryKey: ["call", id], queryFn: () => api<CallDetail>(`/api/calls/${id}`), enabled: validId });

  const audioRef = useRef<HTMLAudioElement>(null);
  const [posMs, setPosMs] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // null = not chosen yet: default to English whenever a translation exists.
  const [langChoice, setLangChoice] = useState<"en" | "orig" | null>(null);

  const segments = useMemo(() => parseSegments(call.data?.transcript?.segments), [call.data]);
  const hasAudio = !!call.data?.filePath;
  const hasEnglish = !!call.data?.transcript?.textEn;
  const english = hasEnglish && (langChoice ?? "en") === "en";
  const segText = (s: { text: string; en: string | null }) => (english ? s.en ?? s.text : s.text);
  // Agent / Customer label per speaker name, from the AI summary.
  const roles = useMemo(() => roleMap(call.data?.transcript?.speakerRoles), [call.data]);
  const speakerLabel = (sp: string) => (roles.get(sp) ? `${sp} (${roles.get(sp)})` : sp);

  const del = useMutation({
    mutationFn: () => api<void>(`/api/calls/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["call", id] });
      void qc.invalidateQueries({ queryKey: ["calls"] });
      navigate("/calls", { replace: true });
    },
  });

  /** Seek and play. Before metadata loads (iOS Safari), seek once it arrives. */
  const playFrom = (ms: number) => {
    const a = audioRef.current;
    if (!a) return;
    const seek = () => {
      a.currentTime = ms / 1000;
    };
    if (a.readyState >= 1) seek();
    else a.addEventListener("loadedmetadata", seek, { once: true });
    a.playbackRate = speed;
    void a.play().catch(() => {});
  };

  const copy = async () => {
    const t = call.data?.transcript;
    if (!t) return;
    const text = segments.length ? segments.map((s) => (s.speaker ? `${speakerLabel(s.speaker)}: ${segText(s)}` : segText(s))).join("\n")
      : english
        ? (t.textEn ?? t.text)
        : t.text;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; user can still select the text */
    }
  };

  const notFound = !validId || (call.error instanceof ApiError && [400, 403, 404].includes(call.error.status));
  if (notFound)
    return (
      <>
        <BackLink />
        <p className="card p-4 text-sm">This call doesn't exist, was deleted, or isn't visible to you.</p>
      </>
    );
  if (call.isPending) return <Spinner label="Loading call" />;
  if (call.isError)
    return (
      <>
        <BackLink />
        <ErrorBox error={call.error} onRetry={() => void call.refetch()} />
      </>
    );
  const c = call.data;
  const number = c.phoneE164 || c.phoneRaw;
  // Index of the segment being played: the last one that started at or before the position.
  let active = -1;
  segments.forEach((s, i) => {
    if (s.startMs != null && posMs >= s.startMs) active = i;
  });

  return (
    <>
      <BackLink />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold sm:text-2xl">{c.contactName || number || "Unknown number"}</h1>
          {c.contactName && number && (
            <a href={`tel:${number}`} className="text-sm text-brand-700 hover:underline dark:text-brand-100">
              {number}
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          <CallButton phone={number} label={c.contactName || number || undefined} />
          <StatusBadge status={c.status} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section aria-label="Call details" className="card p-4 lg:order-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Direction</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <DirectionTag direction={c.direction} />
              <ViaTag via={c.via} />
            </dd>
            <dt className="text-slate-500">When</dt>
            <dd>{formatWhen(c.startedAt)}</dd>
            <dt className="text-slate-500">Duration</dt>
            <dd>{formatDuration(c.durationS)}</dd>
            {(isManager(me.role) || c.user.id !== me.id) && (
              <>
                <dt className="text-slate-500">Person</dt>
                <dd className="break-all">{personName(c.user)}</dd>
              </>
            )}
            {c.transcript?.language && (
              <>
                <dt className="text-slate-500">Language</dt>
                <dd>{c.transcript.language}</dd>
              </>
            )}
            {c.fileSize && (
              <>
                <dt className="text-slate-500">File size</dt>
                <dd>{formatBytes(c.fileSize)}</dd>
              </>
            )}
          </dl>
          {c.crm?.enabled && <CrmStatus callId={c.id} crm={c.crm} isAdmin={me.role === "ADMIN"} transcribed={c.status === "TRANSCRIBED"} />}
          {me.role === "ADMIN" && (
            <button type="button" className="btn-outline mt-4 w-full border-red-300 text-red-700 dark:border-red-900 dark:text-red-300" onClick={() => setConfirmDelete(true)}>
              Delete call
            </button>
          )}
        </section>

        <div className="space-y-4 lg:col-span-2">
          <section aria-label="Recording" className="card p-4">
            {hasAudio ? (
              <>
                {/* preload="none": opening the page must not count as a play in the audit log. */}
                <audio
                  ref={audioRef}
                  controls
                  preload="none"
                  src={`/api/calls/${c.id}/audio`}
                  className="w-full"
                  onTimeUpdate={(e) => setPosMs(e.currentTarget.currentTime * 1000)}
                  onPlay={(e) => {
                    e.currentTarget.playbackRate = speed;
                  }}
                />
                {/* Downloads are recorded in the audit log. */}
                <a className="btn-ghost mt-2 inline-flex text-sm" href={`/api/calls/${c.id}/audio?download=1`} download>
                  Download recording
                </a>
                <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Playback speed">
                  <span className="text-xs text-slate-500">Speed</span>
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={speed === s}
                      className={`min-h-9 rounded-full border px-3 text-xs font-medium ${
                        speed === s ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 dark:border-slate-700"
                      }`}
                      onClick={() => {
                        setSpeed(s);
                        if (audioRef.current) audioRef.current.playbackRate = s;
                      }}
                    >
                      {s}x
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-500">
                {c.audioDeletedAt
                  ? `Audio deleted on ${formatWhen(c.audioDeletedAt)} by the retention setting. The transcript is kept.`
                  : "No audio yet. The phone hasn't uploaded this recording."}
              </p>
            )}
          </section>

          {c.transcript && <SummaryCard t={c.transcript} />}
          <ScoreCard score={c.score ?? null} pending={!!c.scorePending} />

          <section aria-labelledby="transcript-h" className="card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 id="transcript-h" className="font-semibold">
                Transcript
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                {hasEnglish && (
                  <div className="flex gap-1" role="group" aria-label="Transcript language">
                    {(
                      [
                        ["en", "English"],
                        ["orig", "Original"],
                      ] as const
                    ).map(([k, label]) => {
                      const on = (k === "en") === english;
                      return (
                        <button
                          key={k}
                          type="button"
                          aria-pressed={on}
                          className={`min-h-9 rounded-full border px-3 text-xs font-medium ${
                            on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 dark:border-slate-700"
                          }`}
                          onClick={() => setLangChoice(k)}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {c.transcript && (
                  <button type="button" className="btn-ghost min-h-9 px-3" onClick={() => void copy()}>
                    <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
                  </button>
                )}
              </div>
            </div>
            {c.transcript?.translationPending && !hasEnglish && (
              <p className="mb-2 text-xs text-slate-500" role="status">
                English translation in progress.
              </p>
            )}
            {!c.transcript ? (
              <p className="text-sm text-slate-500">
                {c.status === "FAILED" ? "Transcription failed." : c.status === "TRANSCRIBING" ? "Transcribing now…" : "Not transcribed yet."}
              </p>
            ) : segments.length ? (
              <ol className="space-y-1">
                {segments.map((s, i) => {
                  const clickable = hasAudio && s.startMs != null;
                  const body = (
                    <>
                      <span className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-slate-500">
                        {s.startMs != null ? formatDuration(Math.floor(s.startMs / 1000)) : ""}
                      </span>
                      <span className="min-w-0">
                        {s.speaker && <span className="mr-1 text-xs font-semibold">{speakerLabel(s.speaker)}</span>}
                        <span className="text-sm leading-relaxed">{segText(s)}</span>
                      </span>
                    </>
                  );
                  const cls = `flex w-full gap-3 rounded-lg px-2 py-1.5 text-left ${i === active ? "bg-brand-50 dark:bg-slate-800" : ""}`;
                  return (
                    <li key={i} aria-current={i === active ? "true" : undefined}>
                      {clickable ? (
                        <button type="button" className={`${cls} hover:bg-slate-100 dark:hover:bg-slate-800`} onClick={() => playFrom(s.startMs!)} aria-label={`Play from ${formatDuration(Math.floor(s.startMs! / 1000))}: ${segText(s)}`}>
                          {body}
                        </button>
                      ) : (
                        <div className={cls}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{(english ? c.transcript.textEn : c.transcript.text) || "Empty transcript."}</p>
            )}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this call?"
        body="The recording and transcript are removed permanently. This can't be undone."
        confirmLabel="Delete"
        busy={del.isPending}
        error={del.error}
        onConfirm={() => del.mutate()}
        onClose={() => {
          setConfirmDelete(false);
          del.reset();
        }}
      />
    </>
  );
}

function roleMap(v: SpeakerRole[] | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of Array.isArray(v) ? v : []) if (r.role !== "Unknown") m.set(r.speaker, r.role);
  return m;
}

const SENTIMENT_TONE: Record<string, string> = {
  positive: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  negative: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  mixed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

/** AI summary, action items, sentiment and tags (same layout as the Android call screen). */
const SCORE_SENTIMENT: Record<string, string> = {
  positive: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  negative: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  mixed: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

/** AI score of the call: overall /100, script adherence, sentiment, objections, next step, strengths, improvements. */
function ScoreCard({ score, pending }: { score: ScoreDto | null; pending: boolean }) {
  const features = useQuery({ queryKey: ["features"], queryFn: () => api<Features>("/api/features"), staleTime: 5 * 60_000 });
  if (!score) {
    if (pending)
      return (
        <section className="card p-4 text-sm text-slate-500" aria-label="AI score">
          <span className="font-semibold text-slate-900 dark:text-slate-100">AI score</span> · Scoring…
        </section>
      );
    // Nothing when scoring is off (or unknown); a short note when it's on but this call has no score yet.
    return features.data?.scoring ? (
      <p className="card p-4 text-sm text-slate-500">
        <span className="font-semibold text-slate-900 dark:text-slate-100">AI score</span> · Not scored yet. Calls are scored after their summary is made.
      </p>
    ) : null;
  }
  const tone = score.overall >= 75 ? "text-call" : score.overall >= 50 ? "text-amber-ui" : "text-overdue";
  return (
    <section aria-labelledby="score-h" className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="score-h" className="font-semibold">
          AI score
        </h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${SCORE_SENTIMENT[score.sentiment] ?? SCORE_SENTIMENT["neutral"]}`}>Customer: {score.sentiment}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-6">
        <div>
          <span className={`text-4xl font-semibold tabular-nums ${tone}`}>{score.overall}</span>
          <span className="text-sm text-slate-500"> /100</span>
        </div>
        {score.scriptAdherence != null && (
          <div className="min-w-48 flex-1">
            <div className="flex justify-between text-sm">
              <span className="text-slate-600 dark:text-slate-400">Script adherence</span>
              <span className="tabular-nums">{score.scriptAdherence}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" role="progressbar" aria-label="Script adherence" aria-valuenow={score.scriptAdherence} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, score.scriptAdherence)}%` }} />
            </div>
          </div>
        )}
      </div>
      {score.objections.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Objections</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {score.objections.map((o, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className={o.handled ? "text-call" : "text-overdue"}>
                  {o.handled ? "✓" : "✗"}
                </span>
                <span>
                  {o.objection}
                  <span className="sr-only">{o.handled ? " (handled)" : " (not handled)"}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {score.nextStep && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next step</h3>
          <p className="mt-1 text-sm">{score.nextStep}</p>
        </div>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {score.strengths.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Strengths</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {score.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {score.improvements.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">To improve</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {score.improvements.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <p className="hint mt-3">
        {score.model} · {formatWhen(score.createdAt)}
      </p>
    </section>
  );
}

function SummaryCard({ t }: { t: NonNullable<CallDetail["transcript"]> }) {
  if (!t.summary) {
    return t.summaryPending ? (
      <p className="card p-4 text-sm text-slate-500" role="status">
        AI summary in progress.
      </p>
    ) : null;
  }
  const items = Array.isArray(t.actionItems) ? t.actionItems : [];
  const tags = Array.isArray(t.tags) ? t.tags : [];
  return (
    <section aria-labelledby="summary-h" className="card p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="summary-h" className="font-semibold">
          Summary
        </h2>
        {t.sentiment && (
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${SENTIMENT_TONE[t.sentiment] ?? SENTIMENT_TONE["neutral"]}`}>
            Customer: {t.sentiment}
          </span>
        )}
      </div>
      <p className="text-sm leading-relaxed">{t.summary}</p>
      {items.length > 0 && (
        <>
          <h3 className="mt-3 text-sm font-semibold">Action items</h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
            {items.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {tags.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tags">
          {tags.map((tag) => (
            <li key={tag} className="rounded-full border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-700">
              {tag}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-slate-500">Written by AI from the transcript; check before acting on it.</p>
    </section>
  );
}

function BackLink() {
  const navigate = useNavigate();
  return (
    <div className="mb-3">
      {window.history.length > 1 ? (
        <button type="button" className="btn-ghost -ml-3 px-3" onClick={() => navigate(-1)}>
          ← Back
        </button>
      ) : (
        <Link to="/calls" className="btn-ghost -ml-3 px-3">
          ← All calls
        </Link>
      )}
    </div>
  );
}

const CRM_LABEL = { SYNCED: "Synced", NO_MATCH: "No matching lead or contact", ERROR: "Sync failed" } as const;

/** Zoho CRM link state; admins can resync. */
function CrmStatus({ callId, crm, isAdmin, transcribed }: { callId: string; crm: CallCrm; isAdmin: boolean; transcribed: boolean }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: () => api<{ status: string; error: string | null }>(`/api/admin/crm/resync/${callId}`, { method: "POST", body: {} }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["call", callId] }),
  });
  return (
    <div className="mt-4 border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
      <p className="font-medium">Zoho CRM</p>
      <p className="text-slate-600 dark:text-slate-300">
        {crm.status ? CRM_LABEL[crm.status] : transcribed ? "Waiting to sync" : "Syncs after transcription"}
        {crm.syncedAt && crm.status !== "ERROR" && ` · ${formatWhen(crm.syncedAt)}`}
      </p>
      {crm.module && crm.recordId && (
        <p>
          {crm.module === "Contacts" ? "Contact" : "Lead"}{" "}
          {crm.recordUrl ? (
            <a href={crm.recordUrl} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-100">
              open in Zoho CRM
            </a>
          ) : (
            crm.recordId
          )}
        </p>
      )}
      {crm.status === "ERROR" && crm.error && <p className="break-words text-red-600 dark:text-red-400">{crm.error}</p>}
      {isAdmin && transcribed && (
        <button type="button" className="btn-outline mt-2 w-full" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Syncing…" : "Resync to CRM"}
        </button>
      )}
      {run.isError && <p className="mt-1 text-red-600 dark:text-red-400">{run.error.message}</p>}
    </div>
  );
}
