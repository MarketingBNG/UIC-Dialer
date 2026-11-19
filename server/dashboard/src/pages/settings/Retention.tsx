import { useMutation } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { api, type Features } from "../../api";
import { PrivacyPanel } from "../../components/Privacy";

/** Recording retention in days (+ optional transcript deletion) and PII masking; also the AI score backfill. */
export function RetentionTab() {
  return (
    <>
      <PrivacyPanel />
      <ScoreBackfill />
    </>
  );
}

function ScoreBackfill() {
  const features = useQuery({ queryKey: ["features"], queryFn: () => api<Features>("/api/features"), staleTime: 5 * 60_000 });
  const run = useMutation({ mutationFn: () => api<{ queued: number }>("/api/admin/score-backfill", { method: "POST", body: {} }) });
  if (!features.data?.scoring) return null;
  return (
    <section className="card mt-4 p-4 sm:p-6">
      <h2 className="font-semibold">AI call scoring</h2>
      <p className="hint">Scores are made for new summarised calls. Backfill queues a score for summarised calls that don't have one yet; it counts toward the monthly AI budget.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-outline" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Queuing…" : "Score older calls"}
        </button>
        <span aria-live="polite" className="text-sm">
          {run.data && <span className="text-emerald-700 dark:text-emerald-400">{run.data.queued} calls queued.</span>}
          {run.error && <span className="text-red-600 dark:text-red-400">{run.error.message}</span>}
        </span>
      </div>
    </section>
  );
}
