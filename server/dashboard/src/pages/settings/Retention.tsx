import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type Features } from "../../api";
import { PrivacyPanel } from "../../components/Privacy";
import { FormError } from "../../ui";

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
  const run = useMutation({
    mutationFn: () => api<{ queued: number }>("/api/admin/score-backfill", { method: "POST", body: {} }),
    onSuccess: (r) => toast.success(`${r.queued} calls queued for scoring.`),
  });
  if (!features.data?.scoring) return null;
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>AI call scoring</CardTitle>
        <CardDescription>Scores are made for new summarised calls. Backfill queues a score for summarised calls that don't have one yet; it counts toward the monthly AI budget.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
          <Sparkles aria-hidden />
          {run.isPending ? "Queuing…" : "Score older calls"}
        </Button>
        <span aria-live="polite" className="text-sm">
          {run.data && <span className="text-emerald-700">{run.data.queued} calls queued.</span>}
          <FormError error={run.error} />
        </span>
      </CardContent>
    </Card>
  );
}
