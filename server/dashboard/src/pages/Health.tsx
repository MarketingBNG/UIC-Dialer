import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CallStatus, type CompressionStats, type CrmStats, type TranslateBackfillResult, type Device, type Stats, type Throughput } from "../api";
import { useMe } from "../App";
import { STATUS_LABEL, ago, jobStatusLabel, formatBytes, formatWhen, personName } from "../format";
import { FirefliesPanel } from "../components/Fireflies";
import { TranslationPanel } from "../components/Translation";
import { ComputersPanel } from "../components/Computers";
import { Empty, ErrorBox, FormError, PageHeader, Spinner } from "../ui";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { RefreshCw, Send, Smartphone } from "lucide-react";
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
        subtitle="Phones that upload recordings (a phone not seen for 24 hours is flagged), and computers signed in to the dashboard."
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

      {stats.data && <StatsHeader s={stats.data} />}
      {stats.isError && <p className="mb-4 text-sm text-amber-700">Server stats unavailable: {stats.error.message}</p>}

      <FirefliesPanel />
      <TranslationPanel />
      {isAdmin && <TranslateBackfill />}
      {isAdmin && <SummarizeBackfill />}
      {isAdmin && stats.data?.compression && <CompressBackfill c={stats.data.compression} />}
      {isAdmin && <TestAlert enabled={stats.data?.alertsEnabled} />}
      <CrmPanel isAdmin={isAdmin} />

      {devices.isPending ? (
        <Spinner label="Loading devices" />
      ) : devices.isError ? (
        <ErrorBox error={devices.error} onRetry={() => void devices.refetch()} />
      ) : sorted.length === 0 ? (
        <Empty icon={<Smartphone />}>No phones have signed in yet. Install the UIC Dialer app on a rep's Android phone and sign in with their company account.</Empty>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {sorted.map((d) => {
            const stale = !d.revokedAt && (!d.lastSeenAt || now - new Date(d.lastSeenAt).getTime() > STALE_MS);
            return (
              <li key={d.id}>
                <Card className={`h-full p-4 ${d.revokedAt ? "opacity-60" : ""} ${stale ? "border-amber-300" : ""}`}>
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
                    {d.revokedAt ? <Badge variant="red">Revoked</Badge> : stale ? <Badge variant="amber">Not seen 24h+</Badge> : <Badge variant="green">OK</Badge>}
                    {!d.revokedAt && !d.permissionsOk && <Badge variant="red">Permissions missing</Badge>}
                    {!d.revokedAt && d.throttled && <Badge variant="amber">Throttled ({d.standbyBucketName})</Badge>}
                    {!d.revokedAt && d.callsWithoutRecordings && <Badge variant="red">Calls but no recordings</Badge>}
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Last seen</dt>
                  <dd title={formatWhen(d.lastSeenAt)}>{ago(d.lastSeenAt, now)}</dd>
                  <dt className="text-muted-foreground">Last sync</dt>
                  <dd title={formatWhen(d.lastSyncAt)}>{ago(d.lastSyncAt, now)}</dd>
                  <dt className="text-muted-foreground">Waiting to upload</dt>
                  <dd className={d.pendingCount > 0 ? "font-medium text-amber-700" : ""}>{d.pendingCount}</dd>
                  <dt className="text-muted-foreground">Free space</dt>
                  <dd>{formatBytes(d.freeBytes)}</dd>
                  {d.calls7d != null && (
                    <>
                      <dt className="text-muted-foreground">Calls / recordings (7 d)</dt>
                      <dd className={d.callsWithoutRecordings ? "font-medium text-destructive" : ""}>
                        {d.calls7d} / {d.recordings7d ?? "–"}
                      </dd>
                    </>
                  )}
                  {d.standbyBucketName && (
                    <>
                      <dt className="text-muted-foreground">Standby bucket</dt>
                      <dd className={d.throttled ? "font-medium text-amber-700" : ""}>{d.standbyBucketName}</dd>
                    </>
                  )}
                  {d.lastStopReason != null && (
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
                  {d.autostartIntent && (
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
                {isAdmin && !d.revokedAt && (
                  <Button variant="ghost" className="mt-3 -ml-3 px-3 text-destructive hover:text-destructive" onClick={() => setConfirm(d)}>
                    Revoke device
                  </Button>
                )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <ComputersPanel isAdmin={isAdmin} />

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
              {revoke.isPending ? "Working…" : "Revoke"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function StatsHeader({ s }: { s: Stats }) {
  const tile = (label: string, value: string | number, warn = false) => (
    <Card className="p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${warn ? "text-amber-700" : ""}`}>{value}</div>
    </Card>
  );
  const jobsWaiting = (s.jobs["QUEUED"] ?? 0) + (s.jobs["RUNNING"] ?? 0) + (s.jobs["WAITING_BUDGET"] ?? 0);
  return (
    <div className="mb-4 space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tile("Stale phones", s.staleDevices, s.staleDevices > 0)}
        {tile("Failed calls", s.calls.FAILED ?? 0, (s.calls.FAILED ?? 0) > 0)}
        {tile("Transcription queue", jobsWaiting)}
        {tile("Server disk used", `${s.disk.usedPct}%`, s.disk.usedPct > 80)}
      </div>
      {s.throughput && <ThroughputTiles t={s.throughput} tile={tile} />}
      <Card className="p-3 text-sm">
      <details>
        <summary className="flex min-h-10 cursor-pointer items-center font-medium">Details</summary>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
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
                <span>{jobStatusLabel(k)}</span>
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
      </details>
      </Card>
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

/** Admin: post a test message to the Zoho Cliq alert channel. */
function TestAlert({ enabled }: { enabled: boolean | undefined }) {
  const run = useMutation({ mutationFn: () => api<{ sent: boolean }>("/api/admin/test-alert", { method: "POST", body: {} }) });
  return (
    <Card role="region" aria-labelledby="alerts-h" className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="alerts-h" className="font-semibold">
            Alerts
          </h2>
          <p className="text-sm text-muted-foreground">
            {enabled === false
              ? "Off: set CLIQ_WEBHOOK_URL on the server to get Zoho Cliq alerts."
              : "Zoho Cliq gets a message when the worker stops, Fireflies blocks us, the disk passes 80%, jobs fail or a phone stops syncing."}
          </p>
        </div>
        <Button variant="outline" disabled={run.isPending || enabled === false} onClick={() => run.mutate()}>
          <Send />
          {run.isPending ? "Sending…" : "Send test alert"}
        </Button>
      </div>
      <p className="mt-2 text-sm" role="status" aria-live="polite">
        {run.isSuccess && "Test alert sent. Check the Cliq channel."}
      </p>
      {run.isError && <p className="mt-1 text-sm text-destructive">{run.error.message}</p>}
    </Card>
  );
}

/** Admin: queue English translations for every transcript that has none yet. */
function TranslateBackfill() {
  const run = useMutation({
    mutationFn: () => api<TranslateBackfillResult>("/api/admin/translate-backfill", { method: "POST", body: {} }),
  });
  return (
    <Card role="region" aria-labelledby="translate-h" className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="translate-h" className="font-semibold">
            English translations
          </h2>
          <p className="text-sm text-muted-foreground">New transcripts are translated automatically. Queue older ones here (batch rate, may take hours).</p>
        </div>
        <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Queuing…" : "Translate existing transcripts"}
        </Button>
      </div>
      <p className="mt-2 text-sm" role="status" aria-live="polite">
        {run.isSuccess && (run.data.queued ? `Queued ${run.data.queued} transcript${run.data.queued === 1 ? "" : "s"} for translation.` : "Nothing to queue: every transcript is translated or already queued.")}
      </p>
      {run.isError && <p className="mt-1 text-sm text-destructive">{run.error.message}</p>}
    </Card>
  );
}

/** Admin: queue AI summaries for every transcript that has none yet (counts toward the Claude cap). */
function SummarizeBackfill() {
  const run = useMutation({
    mutationFn: () => api<TranslateBackfillResult>("/api/admin/summarize-backfill", { method: "POST", body: {} }),
  });
  return (
    <Card role="region" aria-labelledby="summarize-h" className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="summarize-h" className="font-semibold">
            AI call summaries
          </h2>
          <p className="text-sm text-muted-foreground">
            Summary, action items, sentiment, tags and Agent / Customer labels. Queue older calls here (batch rate; uses the Claude monthly cap).
          </p>
        </div>
        <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Queuing…" : "Summarize existing calls"}
        </Button>
      </div>
      <p className="mt-2 text-sm" role="status" aria-live="polite">
        {run.isSuccess && (run.data.queued ? `Queued ${run.data.queued} call${run.data.queued === 1 ? "" : "s"} for a summary.` : "Nothing to queue: every call is summarized or already queued.")}
      </p>
      {run.isError && <p className="mt-1 text-sm text-destructive">{run.error.message}</p>}
    </Card>
  );
}

/** Admin: re-encode large old recordings to the phones' small AAC format (after transcription only). */
function CompressBackfill({ c }: { c: CompressionStats }) {
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: (limit?: number) =>
      api<TranslateBackfillResult>("/api/admin/compress-backfill", { method: "POST", body: limit ? { limit } : {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["stats"] }),
  });
  return (
    <Card role="region" aria-labelledby="compress-h" className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="compress-h" className="font-semibold">
            Compress old recordings
          </h2>
          <p className="text-sm text-muted-foreground">
            Saved {formatBytes(c.bytesSaved)} on {c.compressedCalls} calls. {c.eligibleCalls} large transcribed recordings left
            {c.queuedJobs ? `, ${c.queuedJobs} queued` : ""}. The original is kept if anything fails.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate(5)}>
            Try 5 calls
          </Button>
          <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate(undefined)}>
            {run.isPending ? "Queuing…" : "Compress all"}
          </Button>
        </div>
      </div>
      <p className="mt-2 text-sm" role="status" aria-live="polite">
        {run.isSuccess && (run.data.queued ? `Queued ${run.data.queued} recording${run.data.queued === 1 ? "" : "s"} for compression.` : "Nothing to queue.")}
      </p>
      {run.isError && <p className="mt-1 text-sm text-destructive">{run.error.message}</p>}
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
            Zoho CRM sync
          </h2>
          <p className="text-sm text-muted-foreground">
            {d.enabled
              ? `${d.synced} synced · ${d.noMatch} no match · ${d.errors} errors${d.queued ? ` · ${d.queued} queued` : ""}`
              : "Off: set ZOHO_REFRESH_TOKEN (and client ID / secret) on the server. See docs/zoho-crm-setup.md."}
          </p>
          {d.enabled && d.failing && (
            <p className="text-sm text-destructive">Paused: {d.globalError ?? "Zoho is not responding"}. Retrying automatically.</p>
          )}
          {d.enabled && d.errors > 0 && d.lastError && <p className="text-sm text-destructive">Last error: {d.lastError}</p>}
        </div>
        {isAdmin && (
          <Button variant="outline" disabled={run.isPending || !d.enabled} onClick={() => run.mutate()}>
            {run.isPending ? "Queuing…" : "Sync last 30 days"}
          </Button>
        )}
      </div>
      <p className="mt-2 text-sm" role="status" aria-live="polite">
        {run.isSuccess && (run.data.queued ? `Queued ${run.data.queued} call${run.data.queued === 1 ? "" : "s"}; they sync over the next minutes.` : "Nothing to queue.")}
      </p>
      {run.isError && <p className="mt-1 text-sm text-destructive">{run.error.message}</p>}
    </Card>
  );
}
