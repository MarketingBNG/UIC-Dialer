import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  api,
  ApiError,
  isManager,
  type CallCrm,
  type CallDetail,
  type Contact,
  type ContactDetail,
  type ContactPage,
  type Features,
  type OutcomeDto,
  type ScoreDto,
  type SpeakerRole,
} from "../api";
import { useMe } from "../App";
import { formatBytes, formatDuration, formatWhen, fromLabel, fromLocalInput, parseSegments, personName } from "../format";
import { CallButton } from "../dialer";
import { ArrowLeft, CalendarClock, Check, ChevronDown, Copy, Download, MoreHorizontal, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { OutcomeButtons, OutcomeChip, datePrompt, quickPicks, useOutcomes } from "@/components/Outcomes";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { callRowStatusText } from "../callStatus";
import { DirectionTag, ErrorBox, FormError, Spinner, StatusBadge, TalkTag, ViaTag } from "../ui";

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

  const [dialog, setDialog] = useState<"followup" | "outcome" | null>(null);

  // The contact for this number (if any): its timeline holds the outcome logged for this call.
  const phone = call.data ? call.data.phoneE164 || call.data.phoneRaw : null;
  const contactSearch = useQuery({
    queryKey: ["contacts", "by-phone", phone],
    queryFn: () => api<ContactPage>(`/api/contacts?limit=5&q=${encodeURIComponent(phone!)}`),
    enabled: !!phone,
    staleTime: 60_000,
  });
  const contact = contactSearch.data?.items.find((x) => samePhone(x.phoneE164, phone)) ?? null;
  const contactDetail = useQuery({
    queryKey: ["contact", contact?.id],
    queryFn: () => api<ContactDetail>(`/api/contacts/${contact!.id}`),
    enabled: !!contact,
  });

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
        <Card className="p-4 text-sm">This call doesn't exist, was deleted, or isn't visible to you. Go back to Calls to pick another one.</Card>
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

  const result = callRowStatusText(c.status, c.logType, c.direction, c.durationS);
  const canDelete = me.role === "ADMIN";

  return (
    <>
      <BackLink />
      {/* Header: who, how it went, and the next actions. */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold sm:text-2xl">{c.contactName || number || "Unknown number"}</h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {c.contactName && number && (
                <a href={`tel:${number}`} className="text-primary hover:underline">
                  {number}
                </a>
              )}
              <span>{formatWhen(c.startedAt)}</span>
              {c.durationS != null && c.durationS > 0 && <span>· {formatDuration(c.durationS)}</span>}
            </p>
          </div>
          {(hasAudio || canDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-11" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {hasAudio && (
                  <DropdownMenuItem asChild>
                    {/* Downloads are recorded in the audit log. */}
                    <a href={`/api/calls/${c.id}/audio?download=1`} download>
                      <Download /> Download recording
                    </a>
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                    <Trash2 /> Delete call
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={c.status} logType={c.logType} direction={c.direction} durationS={c.durationS} />
          {contactDetail.data && <OutcomeOfCall callId={c.id} detail={contactDetail.data} />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CallButton phone={number} label={c.contactName || number || undefined} />
          {contact && (
            <>
              <Button variant="outline" className="min-h-11" onClick={() => setDialog("followup")}>
                <CalendarClock /> Set follow-up
              </Button>
              <Button variant="outline" className="min-h-11" onClick={() => setDialog("outcome")}>
                <Pencil /> Change outcome
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <Card role="region" aria-label="Recording" className="p-3">
          {hasAudio ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* preload="none": opening the page must not count as a play in the audit log. */}
              <audio
                ref={audioRef}
                controls
                preload="none"
                src={`/api/calls/${c.id}/audio`}
                className="h-10 min-w-0 flex-1"
                onTimeUpdate={(e) => setPosMs(e.currentTarget.currentTime * 1000)}
                onPlay={(e) => {
                  e.currentTarget.playbackRate = speed;
                }}
              />
              <NativeSelect
                aria-label="Playback speed"
                className="w-20"
                value={String(speed)}
                onChange={(e) => {
                  const s = Number(e.target.value);
                  setSpeed(s);
                  if (audioRef.current) audioRef.current.playbackRate = s;
                }}
              >
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}x
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {c.audioDeletedAt
                ? `Audio deleted on ${formatWhen(c.audioDeletedAt)} by the retention setting. The transcript is kept.`
                : c.status === "NO_RECORDING"
                  ? "No recording for this call. It comes from the phone's call log."
                  : "No audio yet. The phone hasn't uploaded this recording."}
            </p>
          )}
        </Card>

        {c.transcript && <SummaryCard t={c.transcript} />}

        <Card role="region" aria-labelledby="transcript-h" className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 id="transcript-h" className="flex items-center gap-2 font-semibold">
              Transcript <TalkTag tag={c.transcript?.tag} />
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
                      <Button
                        key={k}
                        aria-pressed={on}
                        size="sm"
                        variant={on ? "default" : "outline"}
                        className="min-h-11 rounded-full px-3 text-xs sm:min-h-9"
                        onClick={() => setLangChoice(k)}
                      >
                        {label}
                      </Button>
                    );
                  })}
                </div>
              )}
              {c.transcript && (
                <Button variant="ghost" className="min-h-11 px-3 sm:min-h-9" onClick={() => void copy()}>
                  {copied ? <Check /> : <Copy />}
                  <span aria-live="polite">{copied ? "Copied" : "Copy text"}</span>
                </Button>
              )}
            </div>
          </div>
          {c.transcript?.translationPending && !hasEnglish && (
            <p className="mb-2 text-xs text-muted-foreground" role="status">
              English translation in progress.
            </p>
          )}
          {!c.transcript ? (
            <p className="text-sm text-muted-foreground">{result.explanation}</p>
          ) : segments.length ? (
            <ol className="space-y-1">
              {segments.map((s, i) => {
                const clickable = hasAudio && s.startMs != null;
                const body = (
                  <>
                    <span className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                      {s.startMs != null ? formatDuration(Math.floor(s.startMs / 1000)) : ""}
                    </span>
                    <span className="min-w-0">
                      {s.speaker && <span className="mr-1 text-xs font-semibold">{speakerLabel(s.speaker)}</span>}
                      <span className="text-sm leading-relaxed">{segText(s)}</span>
                    </span>
                  </>
                );
                const cls = cn("flex w-full gap-3 rounded-lg px-2 py-1.5 text-left", i === active && "bg-brand-50");
                return (
                  <li key={i} aria-current={i === active ? "true" : undefined}>
                    {clickable ? (
                      <Button variant="ghost" className={cn(cls, "h-auto items-start justify-start whitespace-normal font-normal")} onClick={() => playFrom(s.startMs!)} aria-label={`Play from ${formatDuration(Math.floor(s.startMs! / 1000))}: ${segText(s)}`}>
                        {body}
                      </Button>
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
        </Card>

        <ScoreCard score={c.score ?? null} pending={!!c.scorePending} />

        {/* Rarely needed facts stay folded away. */}
        <Card role="region" aria-label="Call details" className="p-0">
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-3 font-semibold">
              Details
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="px-4 pb-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Direction</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <DirectionTag direction={c.direction} />
                  <ViaTag via={c.via} />
                </dd>
                {fromLabel(c) && (
                  <>
                    <dt className="text-muted-foreground">Rep's number</dt>
                    <dd>{fromLabel(c)!.replace(/^From /, "")}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">When</dt>
                <dd>{formatWhen(c.startedAt)}</dd>
                <dt className="text-muted-foreground">Duration</dt>
                <dd>{formatDuration(c.durationS)}</dd>
                {(isManager(me.role) || c.user.id !== me.id) && (
                  <>
                    <dt className="text-muted-foreground">Person</dt>
                    <dd className="break-all">{personName(c.user)}</dd>
                  </>
                )}
                {c.transcript?.language && (
                  <>
                    <dt className="text-muted-foreground">Language</dt>
                    <dd>{c.transcript.language}</dd>
                  </>
                )}
                {c.fileSize && (
                  <>
                    <dt className="text-muted-foreground">File size</dt>
                    <dd>{formatBytes(c.fileSize)}</dd>
                  </>
                )}
                {contact && (
                  <>
                    <dt className="text-muted-foreground">Contact</dt>
                    <dd>
                      <Link to={`/contacts/${contact.id}`} className="text-primary hover:underline">
                        Open contact
                      </Link>
                    </dd>
                  </>
                )}
              </dl>
              {c.crm?.enabled && <CrmStatus callId={c.id} crm={c.crm} isAdmin={me.role === "ADMIN"} transcribed={c.status === "TRANSCRIBED"} />}
            </div>
          </details>
        </Card>
      </div>

      {contact && dialog === "followup" && <FollowUpDialog contact={contact} onClose={() => setDialog(null)} />}
      {contact && dialog === "outcome" && <ChangeOutcomeDialog contact={contact} occurredAt={c.startedAt} onClose={() => setDialog(null)} />}

      <AlertDialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (del.isPending) return;
          setConfirmDelete(o);
          if (!o) del.reset();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this call?</AlertDialogTitle>
            <AlertDialogDescription>The recording and transcript are removed permanently. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <FormError error={del.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={del.isPending}
              onClick={(e) => {
                e.preventDefault();
                del.mutate();
              }}
            >
              <Trash2 /> {del.isPending ? "Deleting…" : "Delete call"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Same number when the last 10 digits match (stored E.164 vs a raw call-log number). */
function samePhone(a: string, b: string | null) {
  const d = (s: string) => s.replace(/\D/g, "").slice(-10);
  return !!b && d(a).length >= 6 && d(a) === d(b);
}

/** The outcome logged for this call (newest), shown next to the call result. */
function OutcomeOfCall({ callId, detail }: { callId: string; detail: ContactDetail }) {
  const a = detail.timeline.find((t) => t.kind === "activity" && t.callId === callId && (t.outcomeLabel || t.outcome));
  const next = detail.contact.nextFollowUpAt;
  return (
    <>
      {a && a.kind === "activity" && <OutcomeChip label={a.outcomeLabel ?? OUTCOME_TEXT[a.outcome!] ?? "Logged"} color={a.outcomeColor} />}
      {next && <span className="text-sm text-muted-foreground">Follow-up {formatWhen(next)}</span>}
    </>
  );
}

const OUTCOME_TEXT: Record<string, string> = { INTERESTED: "Interested", CALL_BACK: "Call back", NOT_INTERESTED: "Not interested", NO_ANSWER: "No answer" };

function useRefreshContact(contactId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["contact", contactId] });
    void qc.invalidateQueries({ queryKey: ["contacts"] });
    void qc.invalidateQueries({ queryKey: ["followups-today"] });
    void qc.invalidateQueries({ queryKey: ["me-today"] });
  };
}

/** Pick a time: quick picks, or a custom date and time. */
function WhenPicker({ picks, label, disabled, onPick }: { picks: { key: string; label: string; at: Date }[]; label: string; disabled: boolean; onPick: (iso: string) => void }) {
  const [custom, setCustom] = useState("");
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {picks.map((q) => (
          <Button key={q.key} className="h-auto min-h-12 text-base" disabled={disabled} onClick={() => onPick(q.at.toISOString())}>
            {q.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grow">
          <Label htmlFor="cd-when">{label}</Label>
          <Input id="cd-when" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
        </div>
        <Button variant="outline" disabled={!custom || disabled} onClick={() => onPick(fromLocalInput(custom)!)}>
          <Check /> Save
        </Button>
      </div>
    </div>
  );
}

function FollowUpDialog({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const refresh = useRefreshContact(contact.id);
  const save = useMutation({
    mutationFn: (nextFollowUpAt: string | null) => api(`/api/contacts/${contact.id}`, { method: "PATCH", body: { nextFollowUpAt } }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  // Same quick picks as a "Call back" outcome.
  const picks = quickPicks({ rule: "ASK_CALLBACK", baseOutcome: "CALL_BACK" } as OutcomeDto);
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set follow-up</DialogTitle>
          <DialogDescription>
            When should you call {contact.name || contact.phoneE164} again?
            {contact.nextFollowUpAt && ` Now set for ${formatWhen(contact.nextFollowUpAt)}.`}
          </DialogDescription>
        </DialogHeader>
        <WhenPicker picks={picks} label="Pick a time" disabled={save.isPending} onPick={(iso) => save.mutate(iso)} />
        {contact.nextFollowUpAt && (
          <Button variant="link" className="justify-start px-0" disabled={save.isPending} onClick={() => save.mutate(null)}>
            Clear follow-up
          </Button>
        )}
        <FormError error={save.error} />
      </DialogContent>
    </Dialog>
  );
}

/** Logs a new outcome for this call's time; the newest one counts. */
function ChangeOutcomeDialog({ contact, occurredAt, onClose }: { contact: Contact; occurredAt: string; onClose: () => void }) {
  const refresh = useRefreshContact(contact.id);
  const outcomes = useOutcomes();
  const [picked, setPicked] = useState<OutcomeDto | null>(null);
  const save = useMutation({
    mutationFn: ({ o, followUpAt }: { o: OutcomeDto; followUpAt?: string }) =>
      api("/api/activities", {
        method: "POST",
        body: {
          clientId: crypto.randomUUID(),
          phone: contact.phoneE164,
          type: "CALL",
          outcomeId: o.id,
          outcome: o.baseOutcome,
          followUpAt: datePrompt(o) ? followUpAt : undefined,
          occurredAt,
        },
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const choose = (o: OutcomeDto) => {
    save.reset();
    if (datePrompt(o) || o.rule === "REMOVE_FROM_LISTS") setPicked(o);
    else save.mutate({ o });
  };
  const prompt = picked ? datePrompt(picked) : null;
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change outcome</DialogTitle>
          <DialogDescription>How did this call go? Your new pick replaces the old one.</DialogDescription>
        </DialogHeader>
        {!picked ? (
          outcomes.isPending ? (
            <Spinner label="Loading outcomes" />
          ) : (
            <OutcomeButtons items={outcomes.items} value={save.isPending ? (save.variables?.o.id ?? null) : null} disabled={save.isPending} onPick={choose} />
          )
        ) : (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: picked.color }} />
              {prompt ? `${picked.label}: ${prompt.toLowerCase()}?` : `${picked.label}: this removes the contact from all call lists${picked.addToDnc ? " and marks the number do-not-call" : ""}.`}
            </p>
            {prompt ? (
              <WhenPicker picks={quickPicks(picked)} label={prompt} disabled={save.isPending} onPick={(iso) => save.mutate({ o: picked, followUpAt: iso })} />
            ) : (
              <Button variant="destructive" disabled={save.isPending} onClick={() => save.mutate({ o: picked })}>
                <Check /> {save.isPending ? "Saving…" : "Confirm & save"}
              </Button>
            )}
            <Button variant="link" className="px-0" disabled={save.isPending} onClick={() => setPicked(null)}>
              Back to outcomes
            </Button>
          </div>
        )}
        <FormError error={save.error} />
      </DialogContent>
    </Dialog>
  );
}

function roleMap(v: SpeakerRole[] | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of Array.isArray(v) ? v : []) if (r.role !== "Unknown") m.set(r.speaker, r.role);
  return m;
}


const SENTIMENT_VARIANT: Record<string, "green" | "gray" | "red" | "amber"> = {
  positive: "green",
  neutral: "gray",
  negative: "red",
  mixed: "amber",
};

/** AI score of the call: overall /100, script adherence, sentiment, objections, next step, strengths, improvements. */
function ScoreCard({ score, pending }: { score: ScoreDto | null; pending: boolean }) {
  const features = useQuery({ queryKey: ["features"], queryFn: () => api<Features>("/api/features"), staleTime: 5 * 60_000 });
  if (!score) {
    if (pending)
      return (
        <Card role="status" aria-label="AI score" className="p-4 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">AI score</span> · Scoring…
        </Card>
      );
    // Nothing when scoring is off (or unknown); a short note when it's on but this call has no score yet.
    return features.data?.scoring ? (
      <Card className="p-4 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">AI score</span> · Not scored yet. Calls are scored after their summary is made.
      </Card>
    ) : null;
  }
  const tone = score.overall >= 75 ? "text-call" : score.overall >= 50 ? "text-amber-ui" : "text-overdue";
  return (
    <Card role="region" aria-labelledby="score-h" className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="score-h" className="font-semibold">
          AI score
        </h2>
        <Badge variant={SENTIMENT_VARIANT[score.sentiment] ?? "gray"} className="capitalize">Customer: {score.sentiment}</Badge>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-6">
        <div>
          <span className={`text-4xl font-semibold tabular-nums ${tone}`}>{score.overall}</span>
          <span className="text-sm text-muted-foreground"> /100</span>
        </div>
        {score.scriptAdherence != null && (
          <div className="min-w-48 flex-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Script adherence</span>
              <span className="tabular-nums">{score.scriptAdherence}%</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Script adherence" aria-valuenow={score.scriptAdherence} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, score.scriptAdherence)}%` }} />
            </div>
          </div>
        )}
      </div>
      {score.objections.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Objections</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {score.objections.map((o, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden className={cn("pt-0.5", o.handled ? "text-call" : "text-overdue")}>
                  {o.handled ? <Check className="size-4" /> : <X className="size-4" />}
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
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Next step</h3>
          <p className="mt-1 text-sm">{score.nextStep}</p>
        </div>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {score.strengths.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Strengths</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {score.strengths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {score.improvements.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">To improve</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {score.improvements.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {score.model} · {formatWhen(score.createdAt)}
      </p>
    </Card>
  );
}

/** AI summary, action items, sentiment and tags (same layout as the Android call screen). */
function SummaryCard({ t }: { t: NonNullable<CallDetail["transcript"]> }) {
  if (!t.summary) {
    return t.summaryPending ? (
      <Card className="p-4 text-sm text-muted-foreground" role="status">
        AI summary in progress.
      </Card>
    ) : null;
  }
  const items = Array.isArray(t.actionItems) ? t.actionItems : [];
  const tags = Array.isArray(t.tags) ? t.tags : [];
  return (
    <Card role="region" aria-labelledby="summary-h" className="p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="summary-h" className="font-semibold">
          Summary
        </h2>
        {t.sentiment && (
          <Badge variant={SENTIMENT_VARIANT[t.sentiment] ?? "gray"}>Customer: {t.sentiment}</Badge>
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
            <li key={tag}>
              <Badge variant="outline">{tag}</Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Written by AI from the transcript; check before acting on it.</p>
    </Card>
  );
}

function BackLink() {
  const navigate = useNavigate();
  return (
    <div className="mb-3">
      {window.history.length > 1 ? (
        <Button variant="ghost" className="-ml-3 min-h-11 px-3" onClick={() => navigate(-1)}>
          <ArrowLeft /> Back
        </Button>
      ) : (
        <Button asChild variant="ghost" className="-ml-3 min-h-11 px-3">
          <Link to="/calls">
            <ArrowLeft /> All calls
          </Link>
        </Button>
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
    <div className="mt-4 text-sm">
      <Separator className="mb-3" />
      <p className="font-medium">Zoho CRM</p>
      <p className="text-muted-foreground">
        {crm.status ? CRM_LABEL[crm.status] : transcribed ? "Waiting to sync" : "Syncs after transcription"}
        {crm.syncedAt && crm.status !== "ERROR" && ` · ${formatWhen(crm.syncedAt)}`}
      </p>
      {crm.module && crm.recordId && (
        <p>
          {crm.module === "Contacts" ? "Contact" : "Lead"}{" "}
          {crm.recordUrl ? (
            <a href={crm.recordUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
              open in Zoho CRM
            </a>
          ) : (
            crm.recordId
          )}
        </p>
      )}
      {crm.status === "ERROR" && crm.error && <p className="break-words text-destructive">{crm.error}</p>}
      {isAdmin && transcribed && (
        <Button variant="outline" className="mt-2 min-h-11 w-full" disabled={run.isPending} onClick={() => run.mutate()}>
          <RefreshCw /> {run.isPending ? "Syncing…" : "Resync to CRM"}
        </Button>
      )}
      {run.isError && <p className="mt-1 text-destructive">{run.error.message}</p>}
    </div>
  );
}
