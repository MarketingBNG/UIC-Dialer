import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, type CompressionStats, type Features, type Stats, type TranslateBackfillResult } from "../api";
import { formatBytes } from "../format";
import { ConfirmDialog, FormError } from "../ui";

/** Admin catch-up jobs (moved from Health and Retention into Settings > Advanced). */
export function MaintenanceJobs() {
  const stats = useQuery({ queryKey: ["stats"], queryFn: () => api<Stats>("/api/stats") });
  return (
    <>
      <h3 className="mb-2 mt-6 font-semibold">AI catch-up jobs</h3>
      <TranslateBackfill />
      <SummarizeBackfill />
      <ScoreBackfill />
      {stats.data?.compression && <CompressBackfill c={stats.data.compression} />}
      <h3 className="mb-2 mt-6 font-semibold">Alerts</h3>
      <TestAlert enabled={stats.data?.alertsEnabled} />
    </>
  );
}

function JobCard({ id, title, text, action, result, error }: { id: string; title: string; text: ReactNode; action: ReactNode; result: ReactNode; error: unknown }) {
  return (
    <Card role="region" aria-labelledby={id} className="mb-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 id={id} className="font-medium">
            {title}
          </h4>
          <p className="text-sm text-muted-foreground">{text}</p>
        </div>
        {action}
      </div>
      <p className="mt-2 text-sm" role="status" aria-live="polite">
        {result}
      </p>
      <FormError error={error} />
    </Card>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function TranslateBackfill() {
  const run = useMutation({ mutationFn: () => api<TranslateBackfillResult>("/api/admin/translate-backfill", { method: "POST", body: {} }) });
  return (
    <JobCard
      id="job-translate"
      title="English translations"
      text="New transcripts are translated by themselves. This adds older ones (may take hours)."
      action={
        <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Adding…" : "Translate older calls"}
        </Button>
      }
      result={run.isSuccess && (run.data.queued ? `Added ${plural(run.data.queued, "transcript")}.` : "Nothing to add: all done or already waiting.")}
      error={run.error}
    />
  );
}

function SummarizeBackfill() {
  const run = useMutation({ mutationFn: () => api<TranslateBackfillResult>("/api/admin/summarize-backfill", { method: "POST", body: {} }) });
  return (
    <JobCard
      id="job-summary"
      title="AI call summaries"
      text="Summary, action items and speaker names. This adds older calls (uses the monthly AI limit)."
      action={
        <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Adding…" : "Summarize older calls"}
        </Button>
      }
      result={run.isSuccess && (run.data.queued ? `Added ${plural(run.data.queued, "call")}.` : "Nothing to add: all done or already waiting.")}
      error={run.error}
    />
  );
}

function ScoreBackfill() {
  const features = useQuery({ queryKey: ["features"], queryFn: () => api<Features>("/api/features"), staleTime: 5 * 60_000 });
  const run = useMutation({ mutationFn: () => api<{ queued: number }>("/api/admin/score-backfill", { method: "POST", body: {} }) });
  if (!features.data?.scoring) return null;
  return (
    <JobCard
      id="job-score"
      title="AI call scores"
      text="New summarised calls get a score. This scores older ones (uses the monthly AI limit)."
      action={
        <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
          <Sparkles aria-hidden />
          {run.isPending ? "Adding…" : "Score older calls"}
        </Button>
      }
      result={run.isSuccess && <span className="text-success-text">Added {plural(run.data.queued, "call")}.</span>}
      error={run.error}
    />
  );
}

/** Re-encode large old recordings; "Compress all" asks first since it touches every old file. */
function CompressBackfill({ c }: { c: CompressionStats }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const run = useMutation({
    mutationFn: (limit?: number) => api<TranslateBackfillResult>("/api/admin/compress-backfill", { method: "POST", body: limit ? { limit } : {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["stats"] }),
  });
  return (
    <>
      <JobCard
        id="job-compress"
        title="Make old recordings smaller"
        text={`Saved ${formatBytes(c.bytesSaved)} on ${plural(c.compressedCalls, "call")}. ${c.eligibleCalls} large recordings left${c.queuedJobs ? `, ${c.queuedJobs} waiting` : ""}. The original is kept if anything fails.`}
        action={
          <div className="flex gap-2">
            <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate(5)}>
              Try 5 calls
            </Button>
            <Button variant="outline" disabled={run.isPending} onClick={() => setConfirm(true)}>
              {run.isPending ? "Adding…" : "Do all"}
            </Button>
          </div>
        }
        result={run.isSuccess && (run.data.queued ? `Added ${plural(run.data.queued, "recording")}.` : "Nothing to add.")}
        error={run.error}
      />
      <ConfirmDialog
        open={confirm}
        title="Make all old recordings smaller?"
        body={`${c.eligibleCalls} recordings will be re-saved in a smaller format. Try 5 calls first if you haven't.`}
        confirmLabel="Do all"
        busy={run.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          run.mutate(undefined);
        }}
      />
    </>
  );
}

function TestAlert({ enabled }: { enabled: boolean | undefined }) {
  const run = useMutation({ mutationFn: () => api<{ sent: boolean }>("/api/admin/test-alert", { method: "POST", body: {} }) });
  return (
    <JobCard
      id="job-alert"
      title="Test alert"
      text={
        enabled === false
          ? "Off: set CLIQ_WEBHOOK_URL on the server to get Zoho Cliq alerts."
          : "Zoho Cliq gets a message when something stops working, the disk is nearly full or a phone stops syncing."
      }
      action={
        <Button variant="outline" disabled={run.isPending || enabled === false} onClick={() => run.mutate()}>
          <Send aria-hidden />
          {run.isPending ? "Sending…" : "Send test alert"}
        </Button>
      }
      result={run.isSuccess && "Test alert sent. Check the Cliq channel."}
      error={run.error}
    />
  );
}
