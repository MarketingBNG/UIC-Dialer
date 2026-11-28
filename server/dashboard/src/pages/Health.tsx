import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation } from "react-router";
import { api, type CallStatus, type ClientErrorDto, type CrmStats, type Device, type FirefliesUsage, type Stats, type Throughput } from "../api";
import { useMe } from "../App";
import { STATUS_LABEL, ago, formatBytes, formatWhen, personName } from "../format";
import { FirefliesPanel } from "../components/Fireflies";
import { TranslationPanel } from "../components/Translation";
import { ComputersPanel } from "../components/Computers";
import { DeviceSims } from "../components/DeviceSims";
import { Empty, ErrorBox, FormError, PageHeader, Spinner } from "../ui";
import { cn } from "@/lib/utils";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CircleCheck, RefreshCw, Smartphone, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const STALE_MS = 24 * 3600_000;
const GOOGLE_DIALER = "com.google.android.dialer";

/** WorkInfo.STOP_REASON_* names (Android 12+); same table as the app. */
const STOP_REASONS: Record<number, string> = {
  [-256]: "Not stopped", 0: "Unknown", 1: "Cancelled", 2: "Preempted", 3: "Timeout", 4: "Device state", 5: "Battery low",
  6: "Charging", 7: "Connectivity", 8: "Idle", 9: "Storage low", 10: "Quota", 11: "Background restriction",
  12: "App standby", 13: "User", 14: "System processing", 15: "Estimated app launch time changed",
};
export function stopReasonLabel(r: number): string {
  return STOP_REASONS[r] ?? `Code ${r}`;
}

export function HealthPage() {
  const me = useMe();
  const isAdmin = me.role === "ADMIN";
  // The admin banner links to #fireflies: open the details so the link lands.
  const { hash } = useLocation();
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<Device[]>("/api/devices") });
  // Stats failing (e.g. disk probe) shouldn't hide the device list.
  const stats = useQuery({ queryKey: ["stats"], queryFn: () => api<Stats>("/api/stats") });
  const [confirm, setConfirm] = useState<Device | null>(null);

  const revoke = useMutation({
    mutationFn: (d: Device) => api<void>(`/api/devices/${d.id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ["devices"] });
      void qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });

  const now = Date.now();
  // Active devices first, revoked at the bottom; server order (last seen desc) otherwise.
  const sorted = devices.data ? [...devices.data].sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt)) : [];

  return (
    <>
      <PageHeader
        title="Sync health"
        subtitle="Are phones uploading and transcripts coming in?"
        actions={
          <Button variant="outline"
            disabled={devices.isFetching}
            onClick={() => {
              void devices.refetch();
              void stats.refetch();
            }}
          >
            <RefreshCw className={devices.isFetching ? "animate-spin" : undefined} />
            {devices.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {stats.data && <Summary s={stats.data} offline={sorted.filter((d) => isStale(d, now))} />}
      {stats.isError && <p className="mb-4 text-sm text-warning-text">Couldn't load the summary. Try Refresh.</p>}

      <CrmPanel isAdmin={isAdmin} />
      <ClientErrors isAdmin={isAdmin} />

      {devices.isPending ? (
        <Spinner label="Loading devices" />
      ) : devices.isError ? (
        <ErrorBox error={devices.error} onRetry={() => void devices.refetch()} />
      ) : sorted.length === 0 ? (
        <Empty icon={<Smartphone />}>No phones have signed in yet. Install the UIC Dialer app on a rep's Android phone and sign in with their company account.</Empty>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {sorted.map((d) => {
            const stale = isStale(d, now);
            return (
              <li key={d.id}>
                <Card className={cn("h-full p-4", d.revokedAt && "opacity-60", stale && "border-warning")}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{personName(d.user)}</div>
                    <div className="truncate text-sm text-muted-foreground">
                      {d.model ?? "Unknown phone"}
                      {d.androidVersion ? ` · Android ${d.androidVersion}` : ""}
                      {d.appVersion ? ` · app ${d.appVersion}` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    {d.revokedAt ? <Badge variant="neutral">Signed out</Badge> : stale ? <Badge variant="warning">Offline over a day</Badge> : <Badge variant="success">OK</Badge>}
                    {!d.revokedAt && !d.permissionsOk && <Badge variant="danger">Permissions missing</Badge>}
                    {!d.revokedAt && d.throttled && <Badge variant="warning">Phone is slowing the app</Badge>}
                    {!d.revokedAt && d.callsWithoutRecordings && <Badge variant="danger">Calls but no recordings</Badge>}
                    {!d.revokedAt && d.fewRecordings && <Badge variant="warning">Missing most recordings</Badge>}
                    {!d.revokedAt && d.backlogFgsError && d.pendingCount > 0 && (
                      <Badge variant="warning" title={`Android refused the upload notification (${d.backlogFgsError}). Older recordings upload in short bursts; opening the app speeds them up.`}>Slow background upload</Badge>
                    )}
                    {!d.revokedAt && d.sims?.some((x) => x.isNew) && <Badge variant="warning">New SIM</Badge>}
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Last seen</dt>
                  <dd title={formatWhen(d.lastSeenAt)}>{ago(d.lastSeenAt, now)}</dd>
                  <dt className="text-muted-foreground">Last sync</dt>
                  <dd title={formatWhen(d.lastSyncAt)}>{ago(d.lastSyncAt, now)}</dd>
                  <dt className="text-muted-foreground">Waiting to upload</dt>
                  <dd className={d.pendingCount > 0 ? "font-medium text-warning-text" : ""}>{d.pendingCount}</dd>
                  <dt className="text-muted-foreground">Free space</dt>
                  <dd>{formatBytes(d.freeBytes)}</dd>
                  {d.calls7d != null && (
                    <>
                      <dt className="text-muted-foreground">Calls / recordings (7 d)</dt>
                      <dd className={d.callsWithoutRecordings ? "font-medium text-danger-text" : d.fewRecordings ? "font-medium text-warning-text" : ""}>
                        {d.calls7d} / {d.recordings7d ?? "–"}
                      </dd>
                    </>
                  )}
                  {isAdmin && d.standbyBucketName && (
                    <>
                      <dt className="text-muted-foreground">Standby bucket</dt>
                      <dd className={d.throttled ? "font-medium text-warning-text" : ""}>{d.standbyBucketName}</dd>
                    </>
                  )}
                  {isAdmin && d.lastStopReason != null && (
                    <>
                      <dt className="text-muted-foreground">Last job stop</dt>
                      <dd>{stopReasonLabel(d.lastStopReason)}</dd>
                    </>
                  )}
                  {d.defaultDialer && (
                    <>
                      <dt className="text-muted-foreground">Dialer</dt>
                      <dd className="truncate" title={d.defaultDialer}>
                        {d.defaultDialer === GOOGLE_DIALER ? "Google Phone (recordings not readable)" : d.defaultDialer}
                      </dd>
                    </>
                  )}
                  {isAdmin && d.autostartIntent && (
                    <>
                      <dt className="text-muted-foreground">Autostart screen</dt>
                      <dd className="truncate" title={d.autostartIntent}>{d.autostartIntent.split("/")[0]}</dd>
                    </>
                  )}
                  {d.revokedAt && (
                    <>
                      <dt className="text-muted-foreground">Revoked</dt>
                      <dd>{formatWhen(d.revokedAt)}</dd>
                    </>
                  )}
                </dl>
                <DeviceSims deviceId={d.id} sims={d.sims ?? []} isAdmin={isAdmin} />
                {isAdmin && !d.revokedAt && (
                  <Button variant="ghost" className="mt-3 -ml-3 px-3 text-destructive hover:text-destructive" onClick={() => setConfirm(d)}>
                    Sign out phone
                  </Button>
                )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <ComputersPanel isAdmin={isAdmin} />

      {isAdmin && (
        <details className="mt-4 rounded-xl border bg-card p-4" open={hash === "#fireflies" || hash === "#translation"}>
          <summary className="cursor-pointer font-medium">Technical details</summary>
          <div className="mt-4">
            {stats.data && <TechDetails s={stats.data} />}
            <FirefliesPanel />
            <TranslationPanel />
            <p className="text-sm text-muted-foreground">
              Catch-up jobs and the test alert are in <Link to="/settings/advanced" className="underline">Settings, Advanced</Link>.
            </p>
          </div>
        </details>
      )}

      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o && !revoke.isPending) {
            setConfirm(null);
            revoke.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out this phone?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm && (
                <>
                  {confirm.model ?? "This device"} ({personName(confirm.user)}) will be signed out and stop uploading until the user signs in again.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormError error={revoke.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={revoke.isPending} onClick={() => confirm && revoke.mutate(confirm)}>
              {revoke.isPending ? "Working…" : "Sign out phone"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Phone not seen for a day (signed-out phones don't count). */
function isStale(d: Device, now: number): boolean {
  return !d.revokedAt && (!d.lastSeenAt || now - new Date(d.lastSeenAt).getTime() > STALE_MS);
}

// Job states in plain words; managers never see provider or budget names.
const JOB_WORDS: Record<string, string> = {
  QUEUED: "Waiting",
  RUNNING: "In progress",
  DONE: "Done",
  FAILED: "Gave up after retries",
  WAITING_BUDGET: "Paused (monthly limit)",
};
const jobWords = (k: string) => JOB_WORDS[k] ?? k.charAt(0) + k.slice(1).toLowerCase();

function hoursText(h: number): string {
  return h >= 48 ? `about ${Math.round(h / 24)} days` : `about ${Math.max(1, Math.round(h))} h`;
}

/** One sentence that says if anything needs attention, then soft tiles. */
function Summary({ s, offline }: { s: Stats; offline: Device[] }) {
  // Usage feeds only the "paused until" date; the endpoint is open to managers (the app banner uses it).
  const ff = useQuery({ queryKey: ["fireflies"], queryFn: () => api<FirefliesUsage>("/api/fireflies/usage"), refetchInterval: 60_000 });
  const t = s.throughput;
  const waiting = t?.backlogCalls ?? (s.jobs["QUEUED"] ?? 0) + (s.jobs["RUNNING"] ?? 0) + (s.jobs["WAITING_BUDGET"] ?? 0);
  const paused = s.fireflies?.blocked || (s.jobs["WAITING_BUDGET"] ?? 0) > 0;
  const failed = s.calls.FAILED ?? 0;
  const sentence = paused
    ? `Transcripts paused${ff.data?.blockedUntil ? ` until ${formatWhen(ff.data.blockedUntil)}` : ""}. Recordings are safe.`
    : waiting > 0
      ? `Transcripts: ${waiting} waiting${t?.backlogEtaHours != null ? `, ${hoursText(t.backlogEtaHours)}` : ""}.`
      : "Transcripts: all caught up.";
  const ok = !paused && offline.length === 0;
  // Approximate counts from the 24 h rate: jobs per hour x 24, and the failure share of those.
  const tried = t ? Math.round(t.jobsPerHour * 24) : 0;
  const didntWork = t ? Math.round((tried * t.failureRatePct) / 100) : 0;
  return (
    <div className="mb-4 space-y-3">
      <Card className={cn("flex items-start gap-3 p-4", ok ? "bg-success-soft" : "bg-warning-soft")} role="status">
        {ok ? <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-success-text" /> : <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warning-text" />}
        <div className="min-w-0">
          <p className="font-medium">{sentence}</p>
          {offline.length > 0 && (
            <p className="mt-1 text-sm">Phones offline for more than a day: {offline.map((d) => personName(d.user)).join(", ")}</p>
          )}
          {t && tried > 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              Transcripts that didn't work (24 h): {didntWork} of {tried}
            </p>
          )}
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="Phones offline over a day" value={offline.length} tone={offline.length > 0 ? "warning" : "neutral"} />
        <Tile label="Waiting for transcript" value={waiting} tone="neutral" />
        <Tile label="Calls without transcript" value={failed} tone={failed > 0 ? "warning" : "neutral"} to={failed > 0 ? "/calls?status=FAILED" : undefined} />
      </div>
    </div>
  );
}

const TILE_TONE = { neutral: "bg-card", warning: "bg-warning-soft text-warning-text" } as const;

function Tile({ label, value, tone, to }: { label: string; value: string | number; tone: keyof typeof TILE_TONE; to?: string }) {
  const body = (
    <Card className={cn("h-full p-3", TILE_TONE[tone], to && "transition-colors hover:border-primary")}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {to && <div className="mt-1 text-xs text-primary underline">See calls</div>}
    </Card>
  );
  return to ? (
    <Link to={to} className="block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Admin only: rates, disk, and counts by state. */
function TechDetails({ s }: { s: Stats }) {
  const tile = (label: string, value: string | number, warn = false) => <Tile label={label} value={value} tone={warn ? "warning" : "neutral"} />;
  return (
    <div className="mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{tile("Server disk used", `${s.disk.usedPct}%`, s.disk.usedPct > 80)}</div>
      {s.throughput && <ThroughputTiles t={s.throughput} tile={tile} />}
      <div className="grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Calls by status</div>
          {(Object.keys(STATUS_LABEL) as CallStatus[]).map((k) => (
            <div key={k} className="flex justify-between">
              <span>{STATUS_LABEL[k]}</span>
              <span className="tabular-nums">{s.calls[k] ?? 0}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Jobs</div>
          {Object.keys(s.jobs).length === 0 && <div className="text-muted-foreground">None</div>}
          {Object.entries(s.jobs).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span>{jobWords(k)}</span>
              <span className="tabular-nums">{v}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Disk</div>
          <div className="flex justify-between">
            <span>Free</span>
            <span>{formatBytes(s.disk.freeBytes)}</span>
          </div>
          <div className="flex justify-between">
            <span>Total</span>
            <span>{formatBytes(s.disk.totalBytes)}</span>
          </div>
          <meter className="mt-2 w-full" min={0} max={100} low={70} high={85} optimum={0} value={s.disk.usedPct} aria-label="Disk used" />
          {s.compression && (
            <div className="mt-2 flex justify-between">
              <span>Saved by compression</span>
              <span>
                {formatBytes(s.compression.bytesSaved)} ({s.compression.compressedCalls} calls)
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Rough "how long until the backlog is done" text. */
function etaText(t: Throughput): string {
  if (t.backlogCalls === 0) return "No backlog";
  const parts: string[] = [];
  if (t.backlogEtaMonths !== null) parts.push(`${t.backlogEtaMonths} mo of Fireflies budget`);
  if (t.backlogEtaHours !== null) parts.push(t.backlogEtaHours >= 48 ? `${Math.round(t.backlogEtaHours / 24)} d at current rate` : `${t.backlogEtaHours} h at current rate`);
  return parts.join(" · ") || "Unknown";
}

function ThroughputTiles({ t, tile }: { t: Throughput; tile: (label: string, value: string | number, warn?: boolean) => React.ReactNode }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tile("Jobs per hour (24 h)", t.jobsPerHour)}
        {tile("Failure rate (24 h)", `${t.failureRatePct}%`, t.failureRatePct > 5)}
        {tile("Avg seconds per job", t.avgJobSeconds ?? "–")}
        {tile("Backlog", `${t.backlogCalls} calls · ${t.backlogMinutes} min`)}
      </div>
      <p className="text-sm text-muted-foreground">Backlog ETA: {etaText(t)}</p>
    </>
  );
}

const SOURCE_LABEL: Record<ClientErrorDto["source"], string> = { android: "Phone", desktop: "Windows app", web: "Browser" };

/** Problems staff phones / laptops reported in the last 7 days, newest first. */
function ClientErrors({ isAdmin }: { isAdmin: boolean }) {
  const q = useQuery({ queryKey: ["client-errors"], queryFn: () => api<{ items: ClientErrorDto[] }>("/api/client-errors?days=7") });
  return (
    <Card role="region" aria-labelledby="client-errors-h" className="mb-4 p-4">
      <h2 id="client-errors-h" className="font-semibold">
        Problems on staff devices
      </h2>
      <p className="text-sm text-muted-foreground">Last 7 days.</p>
      {q.isPending ? (
        <Spinner label="Loading problems" />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No problems reported</p>
      ) : (
        <ul className="mt-2 max-h-80 divide-y overflow-y-auto text-sm">
          {q.data.items.map((e) => (
            <li key={e.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{e.user.name}</span>
                <Badge variant="outline">{e.device ?? SOURCE_LABEL[e.source]}</Badge>
                <span className="font-mono text-xs">{e.kind}</span>
                <span className="ml-auto text-xs text-muted-foreground" title={formatWhen(e.createdAt)}>
                  {ago(e.createdAt)}
                </span>
              </div>
              {isAdmin && e.message && <p className="mt-0.5 break-words text-muted-foreground">{e.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Zoho CRM sync counts; admins can queue the last 30 days. */
function CrmPanel({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const crm = useQuery({ queryKey: ["crm"], queryFn: () => api<CrmStats>("/api/crm") });
  const run = useMutation({
    mutationFn: () => api<{ queued: number }>("/api/admin/crm/backfill", { method: "POST", body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["crm"] }),
  });
  const d = crm.data;
  if (!d) return null;
  return (
    <Card role="region" aria-labelledby="crm-h" className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="crm-h" className="font-semibold">
            Zoho CRM
          </h2>
          <p className="text-sm text-muted-foreground">
            {d.enabled
              ? `${d.synced} added · ${d.noMatch} not found in Zoho · ${d.errors} not added${d.queued ? ` · ${d.queued} waiting` : ""}`
              : isAdmin
                ? "Off: set ZOHO_REFRESH_TOKEN (and client ID / secret) on the server. See docs/zoho-crm-setup.md."
                : "Not turned on."}
          </p>
          {d.enabled && d.failing && (
            <p className="text-sm text-warning-text">Zoho is not answering. Trying again by itself{isAdmin && d.globalError ? ` (${d.globalError})` : ""}.</p>
          )}
          {isAdmin && d.enabled && d.errors > 0 && d.lastError && <p className="text-sm text-danger-text">Couldn't add to Zoho – {d.lastError}</p>}
        </div>
        {isAdmin && (
          <Button variant="outline" disabled={run.isPending || !d.enabled} onClick={() => run.mutate()}>
            {run.isPending ? "Queuing…" : "Sync last 30 days"}
          </Button>
        )}
      </div>
      <p className="mt-2 text-sm" role="status" aria-live="polite">
        {run.isSuccess && (run.data.queued ? `Added ${run.data.queued} call${run.data.queued === 1 ? "" : "s"}; they go to Zoho over the next minutes.` : "Nothing to add.")}
      </p>
      {run.isError && <p className="mt-1 text-sm text-destructive">{run.error.message}</p>}
    </Card>
  );
}
