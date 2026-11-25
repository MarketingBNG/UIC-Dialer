import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CostSettingsPatch, type TranslationUsage } from "../api";
import { Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMe } from "../App";
import { ErrorBox, Spinner } from "../ui";

const KEY = ["translation"];
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Claude translation spend this month; the monthly cap for admins. */
export function TranslationPanel() {
  const me = useMe();
  const usage = useQuery({ queryKey: KEY, queryFn: () => api<TranslationUsage>("/api/translation/usage"), refetchInterval: 60_000 });
  return (
    <Card id="translation" className="mb-4 scroll-mt-20 p-4 sm:p-6">
      {usage.isPending ? (
        <Spinner label="Loading translation spend" />
      ) : usage.isError ? (
        <ErrorBox error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <>
          <Usage u={usage.data} />
          {me.role === "ADMIN" && <AdminForm key={usage.data.budgetUsd} u={usage.data} />}
        </>
      )}
    </Card>
  );
}

function Usage({ u }: { u: TranslationUsage }) {
  const bar = Math.min(100, u.pct);
  const tone = u.pct >= 100 ? "bg-red-600" : u.pct >= 80 ? "bg-amber-500" : "bg-brand-600";
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Translation spend this month · {u.month}</h2>
        <div className="flex flex-wrap gap-1">
          {u.capped && <Badge variant="red">Cap reached: translations paused</Badge>}
          {u.queuedJobs > 0 && <Badge variant="amber">{u.queuedJobs} waiting</Badge>}
        </div>
      </div>
      <div className="mt-3 flex items-baseline justify-between text-sm">
        <span>
          <span className="text-xl font-semibold tabular-nums">{usd(u.spentUsd)}</span> / {usd(u.budgetUsd)}
        </span>
        <span className="font-medium tabular-nums">{u.pct}% used</span>
      </div>
      <div
        className="relative mt-2 h-3 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-label="Claude translation spend"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={bar}
      >
        <div className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${bar}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-muted-foreground">Calls translated</dt>
        <dd className="tabular-nums">{u.translatedThisMonth}</dd>
        {u.summarizedThisMonth !== undefined && (
          <>
            <dt className="text-muted-foreground">Calls summarized</dt>
            <dd className="tabular-nums">{u.summarizedThisMonth}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Average per call</dt>
        <dd className="tabular-nums">{u.avgCostUsd === null ? "-" : `$${u.avgCostUsd.toFixed(4)}`}</dd>
      </dl>
    </div>
  );
}

function AdminForm({ u }: { u: TranslationUsage }) {
  const qc = useQueryClient();
  const [budget, setBudget] = useState(String(u.budgetUsd));
  const [saved, setSaved] = useState(false);
  const budgetOk = /^\d+(\.\d{1,2})?$/.test(budget.trim()) && Number(budget) <= 1_000_000;

  const patch: CostSettingsPatch = {};
  if (budgetOk && Number(budget) !== u.budgetUsd) patch.translateBudgetUsd = Number(budget);
  const dirty = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: (body: CostSettingsPatch) => api<TranslationUsage>("/api/settings/costs", { method: "PUT", body }),
    onSuccess: (data) => {
      setSaved(true);
      qc.setQueryData(KEY, data);
      void qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });

  return (
    <form
      className="mt-5 space-y-4 border-t border-slate-200 pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (budgetOk && dirty) save.mutate(patch);
      }}
    >
      <h3 className="font-semibold">Cost settings</h3>
      <div className="max-w-xs">
        <Label htmlFor="tr-budget">
          Claude monthly cap (USD)
        </Label>
        <Input
          id="tr-budget"
          inputMode="decimal"
          
          value={budget}
          onChange={(e) => {
            setSaved(false);
            setBudget(e.target.value);
          }}
          aria-invalid={!budgetOk}
          aria-describedby="tr-budget-hint"
        />
        <p id="tr-budget-hint" className={`mt-1 text-xs text-muted-foreground ${budgetOk ? "" : "text-destructive"}`}>
          English translations wait once this month's spend reaches the cap. Jobs already started still finish, so spend can go a little over (one batch per running worker).
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
        <Button type="submit" className="min-h-11" disabled={!dirty || !budgetOk || save.isPending}>
          <Save /> {save.isPending ? "Saving…" : "Save changes"}
        </Button>
        <span aria-live="polite" className="text-sm">
          {saved && !dirty && <span className="text-emerald-700">Saved.</span>}
          {save.error && <span className="text-destructive">{save.error.message}</span>}
        </span>
      </div>
    </form>
  );
}
