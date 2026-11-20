import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { api, type FirefliesSettingsPatch, type FirefliesUsage } from "../api";
import { CircleAlert, Info, Save, ShieldOff, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { useMe } from "../App";
import { formatWhen } from "../format";
import { ErrorBox, FormError, Spinner, SwitchRow, ConfirmDialog } from "../ui";

const KEY = ["fireflies"];
const useUsage = () => useQuery({ queryKey: KEY, queryFn: () => api<FirefliesUsage>("/api/fireflies/usage"), refetchInterval: 60_000 });

type Level = "info" | "warning" | "error";
const LEVEL_VARIANT: Record<Level, "info" | "warning" | "destructive"> = { info: "info", warning: "warning", error: "destructive" };
const LEVEL_ICON: Record<Level, typeof Info> = { info: Info, warning: TriangleAlert, error: CircleAlert };

export function firefliesAlerts(u: FirefliesUsage): { level: Level; text: string }[] {
  const out: { level: Level; text: string }[] = [];
  if (u.blocked) {
    out.push({
      level: "error",
      text: `Fireflies is blocked until ${formatWhen(u.blockedUntil)}${u.lastError ? `: ${u.lastError}` : ""}`,
    });
  }
  if (u.pct >= 100) out.push({ level: "error", text: `Fireflies budget used up: ${u.pct}% of ${u.budgetMinutes} min this month.` });
  else if (u.pct >= 80) out.push({ level: "warning", text: `Fireflies budget at ${u.pct}% of ${u.budgetMinutes} min this month.` });
  else if (u.pct >= 50) out.push({ level: "info", text: `Fireflies budget at ${u.pct}% of ${u.budgetMinutes} min this month.` });
  if (u.enabled && u.backlogSent >= u.approvedBacklogCount) {
    out.push({
      level: "warning",
      text: `Backlog paused after ${u.approvedBacklogCount} calls - check Fireflies billing, then raise the limit.`,
    });
  }
  return out;
}

/** Shown in the app shell for managers and admins on every page. */
export function FirefliesBanner() {
  const me = useMe();
  const usage = useUsage();
  if (!usage.data) return null;
  const alerts = firefliesAlerts(usage.data);
  if (alerts.length === 0) return null;
  return (
    <div className="mb-4 space-y-2">
      {alerts.map((a) => {
        const Icon = LEVEL_ICON[a.level];
        return (
          <Alert key={a.text} variant={LEVEL_VARIANT[a.level]} role={a.level === "info" ? "status" : "alert"}>
            <Icon />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 break-words">{a.text}</span>
              <Link to="/health#fireflies" className="inline-flex min-h-11 items-center font-medium underline sm:min-h-0">
                {me.role === "ADMIN" ? "Manage" : "Details"}
              </Link>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}

/** Usage for managers; the settings form and "Clear block" for admins. */
export function FirefliesPanel() {
  const me = useMe();
  const usage = useUsage();
  const [saved, setSaved] = useState(false);
  return (
    <Card id="fireflies" className="mb-4 scroll-mt-20 p-4 sm:p-6">
      {usage.isPending ? (
        <Spinner label="Loading Fireflies usage" />
      ) : usage.isError ? (
        <ErrorBox error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <>
          <Usage u={usage.data} />
          {me.role === "ADMIN" && <AdminForm key={formKey(usage.data)} u={usage.data} saved={saved} setSaved={setSaved} />}
        </>
      )}
    </Card>
  );
}

const formKey = (u: FirefliesUsage) => [u.enabled, u.budgetMinutes, u.liveReservePct, u.approvedBacklogCount, u.deleteAfterFetch].join("|");

function Usage({ u }: { u: FirefliesUsage }) {
  const total = u.usedMinutes + u.reservedMinutes;
  const pctBar = Math.min(100, u.pct);
  const usedBar = u.budgetMinutes > 0 ? Math.min(100, (u.usedMinutes / u.budgetMinutes) * 100) : 100;
  const barTone = u.pct >= 100 ? "bg-red-600" : u.pct >= 80 ? "bg-amber-500" : "bg-brand-600";
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Fireflies transcription · {u.month}</h2>
        <div className="flex flex-wrap gap-1">
          {u.enabled ? <Badge variant="green">Enabled</Badge> : <Badge variant="gray">Disabled</Badge>}
          {u.blocked && <Badge variant="red">Blocked</Badge>}
          {u.waitingBudgetJobs > 0 && <Badge variant="amber">{u.waitingBudgetJobs} waiting for budget</Badge>}
        </div>
      </div>
      <div className="mt-3 flex items-baseline justify-between text-sm">
        <span>
          <span className="text-xl font-semibold tabular-nums">{total}</span> / {u.budgetMinutes} min
        </span>
        <span className="font-medium tabular-nums">{u.pct}% used</span>
      </div>
      <div
        className="relative mt-2 h-3 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-label="Fireflies minutes used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pctBar}
      >
        <div className={`absolute inset-y-0 left-0 opacity-40 ${barTone}`} style={{ width: `${pctBar}%` }} />
        <div className={`absolute inset-y-0 left-0 ${barTone}`} style={{ width: `${usedBar}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-muted-foreground">Used</dt>
        <dd className="tabular-nums">{u.usedMinutes} min</dd>
        <dt className="text-muted-foreground">Reserved</dt>
        <dd className="tabular-nums">{u.reservedMinutes} min</dd>
        <dt className="text-muted-foreground">Live reserve</dt>
        <dd className="tabular-nums">{u.liveReservePct}%</dd>
        <dt className="text-muted-foreground">Backlog sent</dt>
        <dd className={`tabular-nums ${u.backlogSent >= u.approvedBacklogCount ? "font-medium text-amber-700" : ""}`}>
          {u.backlogSent} of {u.approvedBacklogCount} approved
        </dd>
        <dt className="text-muted-foreground">Delete after fetch</dt>
        <dd>{u.deleteAfterFetch ? "Yes" : "No"}</dd>
        {u.blocked && (
          <>
            <dt className="text-muted-foreground">Blocked until</dt>
            <dd>{formatWhen(u.blockedUntil)}</dd>
          </>
        )}
      </dl>
      {u.lastError && (
        <p className="mt-3 break-words text-sm text-slate-600">
          Last error{u.lastErrorAt ? ` (${formatWhen(u.lastErrorAt)})` : ""}: {u.lastError}
        </p>
      )}
    </div>
  );
}

function AdminForm({ u, saved, setSaved }: { u: FirefliesUsage; saved: boolean; setSaved: (v: boolean) => void }) {
  const qc = useQueryClient();
  const init = {
    enabled: u.enabled,
    deleteAfterFetch: u.deleteAfterFetch,
    budget: String(u.budgetMinutes),
    reserve: String(u.liveReservePct),
    approved: String(u.approvedBacklogCount),
  };
  const [form, setForm] = useState(init);
  const [confirmClear, setConfirmClear] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const int = (s: string, max: number) => /^\d+$/.test(s.trim()) && Number(s) <= max;
  const budgetOk = int(form.budget, 1_000_000);
  const reserveOk = /^\d+(\.\d+)?$/.test(form.reserve.trim()) && Number(form.reserve) <= 100;
  const approvedOk = int(form.approved, 10_000_000);
  const valid = budgetOk && reserveOk && approvedOk;

  const patch: FirefliesSettingsPatch = {};
  if (form.enabled !== u.enabled) patch.enabled = form.enabled;
  if (form.deleteAfterFetch !== u.deleteAfterFetch) patch.deleteAfterFetch = form.deleteAfterFetch;
  if (budgetOk && Number(form.budget) !== u.budgetMinutes) patch.budgetMinutes = Number(form.budget);
  if (reserveOk && Number(form.reserve) !== u.liveReservePct) patch.liveReservePct = Number(form.reserve);
  if (approvedOk && Number(form.approved) !== u.approvedBacklogCount) patch.approvedBacklogCount = Number(form.approved);
  const dirty = Object.keys(patch).length > 0;

  const onSaved = (data: FirefliesUsage) => {
    qc.setQueryData(KEY, data);
    void qc.invalidateQueries({ queryKey: ["stats"] });
  };
  const save = useMutation({
    mutationFn: (body: FirefliesSettingsPatch) => api<FirefliesUsage>("/api/settings/fireflies", { method: "PUT", body }),
    onSuccess: (data) => {
      setSaved(true);
      onSaved(data);
    },
  });
  const clear = useMutation({
    mutationFn: () => api<FirefliesUsage>("/api/settings/fireflies", { method: "PUT", body: { clearBlock: true } }),
    onSuccess: (data) => {
      setConfirmClear(false);
      onSaved(data);
    },
  });

  return (
    <form
      className="mt-5 space-y-4 border-t border-slate-200 pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && dirty) save.mutate(patch);
      }}
    >
      <h3 className="font-semibold">Fireflies settings</h3>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="ff-budget">
            Monthly budget (minutes)
          </Label>
          <Input id="ff-budget" inputMode="numeric"  value={form.budget} onChange={(e) => set("budget", e.target.value)} aria-invalid={!budgetOk} aria-describedby="ff-budget-hint" />
          <p id="ff-budget-hint" className={`mt-1 text-xs text-muted-foreground ${budgetOk ? "" : "text-destructive"}`}>
            Whole number, 0 to 1,000,000.
          </p>
        </div>
        <div>
          <Label htmlFor="ff-reserve">
            Live reserve (%)
          </Label>
          <Input id="ff-reserve" inputMode="decimal"  value={form.reserve} onChange={(e) => set("reserve", e.target.value)} aria-invalid={!reserveOk} aria-describedby="ff-reserve-hint" />
          <p id="ff-reserve-hint" className={`mt-1 text-xs text-muted-foreground ${reserveOk ? "" : "text-destructive"}`}>
            0 to 100. Only live calls may use this share.
          </p>
        </div>
        <div>
          <Label htmlFor="ff-approved">
            Approved backlog calls
          </Label>
          <div className="flex gap-2">
            <Input id="ff-approved" inputMode="numeric"  value={form.approved} onChange={(e) => set("approved", e.target.value)} aria-invalid={!approvedOk} aria-describedby="ff-approved-hint" />
            <Button variant="outline" className="min-h-11 shrink-0"
              disabled={!approvedOk}
              onClick={() => set("approved", String(Math.min(10_000_000, Number(form.approved) + 20)))}
            >
              +20
            </Button>
          </div>
          <p id="ff-approved-hint" className={`mt-1 text-xs text-muted-foreground ${approvedOk ? "" : "text-destructive"}`}>
            Total imported calls allowed. {u.backlogSent} sent so far.
          </p>
        </div>
      </div>
      <div className="divide-y divide-slate-200">
        <SwitchRow checked={form.enabled} onChange={(v) => set("enabled", v)} label="Send calls to Fireflies" hint="When off, no new calls are sent." />
        <SwitchRow
          checked={form.deleteAfterFetch}
          onChange={(v) => set("deleteAfterFetch", v)}
          label="Delete from Fireflies after fetching"
          hint="Removes the meeting from Fireflies once the transcript is saved here."
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
        <Button type="submit" className="min-h-11" disabled={!dirty || !valid || save.isPending}>
          <Save /> {save.isPending ? "Saving…" : "Save changes"}
        </Button>
        <Button variant="ghost" className="min-h-11"
          disabled={(!dirty && valid) || save.isPending}
          onClick={() => {
            save.reset();
            setForm(init);
          }}
        >
          Discard changes
        </Button>
        {u.blocked && (
          <Button variant="outline" className="min-h-11 text-destructive hover:text-destructive" onClick={() => setConfirmClear(true)}>
            <ShieldOff /> Clear block
          </Button>
        )}
        <span aria-live="polite" className="text-sm">
          {saved && !dirty && <span className="text-emerald-700">Saved.</span>}
          {save.error && <span className="text-destructive">{save.error.message}</span>}
        </span>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear the Fireflies block?"
        body={
          <>
            Calls will be sent to Fireflies again right away. Only do this after fixing the cause in Fireflies (billing, plan or quota).
            {u.lastError && <span className="mt-2 block text-muted-foreground">Last error: {u.lastError}</span>}
          </>
        }
        confirmLabel="Clear block"
        busy={clear.isPending}
        error={clear.error}
        onConfirm={() => clear.mutate()}
        onClose={() => {
          setConfirmClear(false);
          clear.reset();
        }}
      />
    </form>
  );
}

/** A labelled shadcn Switch with helper text. */

/** Destructive confirmation on shadcn AlertDialog. */
