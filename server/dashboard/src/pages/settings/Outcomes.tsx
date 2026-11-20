import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Pencil, Plus, Power } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { api, type CallOutcome, type OutcomeDto, type OutcomeInput, type OutcomeRule } from "../../api";
import { OUTCOME_LABEL } from "../../format";
import { OutcomeChip, RULE_LABEL } from "../../components/Outcomes";
import { Empty, ErrorBox, FormError, Hint, Spinner } from "../../ui";

const RULES = Object.keys(RULE_LABEL) as OutcomeRule[];
const BASES = Object.keys(OUTCOME_LABEL) as CallOutcome[];

/** Same checks as the server: Call back needs a date-asking rule or RETRY; RETRY needs hours. */
function invalid(f: OutcomeInput): string | null {
  if (!f.label.trim()) return "Enter a label.";
  if (f.label.trim().length > 40) return "Label: 40 characters at most.";
  if (!/^#[0-9A-Fa-f]{6}$/.test(f.color)) return "Pick a colour.";
  if (f.baseOutcome === "CALL_BACK" && !(f.rule.startsWith("ASK_") || f.rule === "RETRY")) return "A Call back outcome must ask for a date or retry.";
  if (f.rule === "RETRY" && !(f.retryHours && f.retryHours >= 1 && f.retryHours <= 720)) return "Retry needs hours, 1 to 720.";
  return null;
}

export function OutcomesTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["outcomes", "all"], queryFn: () => api<{ items: OutcomeDto[] }>("/api/outcomes?all=1") });
  const [editing, setEditing] = useState<OutcomeDto | "new" | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["outcomes"] });
  };
  const order = useMutation({
    mutationFn: (ids: string[]) => api<{ items: OutcomeDto[] }>("/api/outcomes/order", { method: "PUT", body: { ids } }),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: (o: OutcomeDto) => api<OutcomeDto>(`/api/outcomes/${o.id}`, { method: "PATCH", body: { active: !o.active } }),
    onSuccess: (o) => {
      toast.success(`${o.label} ${o.active ? "activated" : "deactivated"}.`);
      refresh();
    },
  });
  const items = [...(list.data?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
  const move = (i: number, d: -1 | 1) => {
    const ids = items.map((o) => o.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    order.mutate(ids);
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Call outcomes</CardTitle>
          <CardDescription>The buttons reps pick after a call, in this order. Each maps to a base outcome so reports and Zoho keep working.</CardDescription>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus aria-hidden />
          Add outcome
        </Button>
      </CardHeader>
      <CardContent>
        {list.isPending ? (
          <Spinner label="Loading outcomes" />
        ) : list.isError ? (
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <Empty
            action={
              <Button onClick={() => setEditing("new")}>
                <Plus aria-hidden />
                Add outcome
              </Button>
            }
          >
            No outcomes. Add the choices reps pick after each call.
          </Empty>
        ) : (
          <ol className="divide-y">
            {items.map((o, i) => (
              <li key={o.id} className={cn("flex flex-wrap items-center gap-2 py-2", !o.active && "opacity-60")}>
                <div className="flex">
                  <Button variant="ghost" size="icon" aria-label={`Move ${o.label} up`} disabled={i === 0 || order.isPending} onClick={() => move(i, -1)}>
                    <ChevronUp aria-hidden />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={`Move ${o.label} down`} disabled={i === items.length - 1 || order.isPending} onClick={() => move(i, 1)}>
                    <ChevronDown aria-hidden />
                  </Button>
                </div>
                <OutcomeChip label={o.label} color={o.color} />
                <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                  {OUTCOME_LABEL[o.baseOutcome]} · {RULE_LABEL[o.rule]}
                  {o.rule === "RETRY" && o.retryHours ? ` in ${o.retryHours} h` : ""}
                  {o.addToDnc ? " · adds to do-not-call" : ""}
                </span>
                {!o.active && <Badge variant="gray">Inactive</Badge>}
                <Button variant="ghost" onClick={() => setEditing(o)} aria-label={`Edit ${o.label}`}>
                  <Pencil aria-hidden />
                  Edit
                </Button>
                <Button variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(o)}>
                  <Power aria-hidden />
                  {o.active ? "Deactivate" : "Activate"}
                </Button>
              </li>
            ))}
          </ol>
        )}
        <div className="mt-2">
          <FormError error={order.error ?? toggle.error} />
        </div>
      </CardContent>
      {editing && <OutcomeDialog key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </Card>
  );
}

function OutcomeDialog({ initial, onClose, onSaved }: { initial: OutcomeDto | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<OutcomeInput>(
    initial
      ? { label: initial.label, color: initial.color, baseOutcome: initial.baseOutcome, rule: initial.rule, retryHours: initial.retryHours, addToDnc: initial.addToDnc, active: initial.active }
      : { label: "", color: "#2C63AD", baseOutcome: "INTERESTED", rule: "NONE", retryHours: null, addToDnc: false, active: true },
  );
  const set = <K extends keyof OutcomeInput>(k: K, v: OutcomeInput[K]) => setF((x) => ({ ...x, [k]: v }));
  const error = invalid(f);
  const save = useMutation({
    mutationFn: () => {
      const body: OutcomeInput = {
        ...f,
        label: f.label.trim(),
        retryHours: f.rule === "RETRY" ? f.retryHours : null,
        addToDnc: f.rule === "REMOVE_FROM_LISTS" ? !!f.addToDnc : false,
      };
      return initial ? api<OutcomeDto>(`/api/outcomes/${initial.id}`, { method: "PATCH", body }) : api<OutcomeDto>("/api/outcomes", { method: "POST", body });
    },
    onSuccess: () => {
      toast.success(initial ? "Outcome saved." : "Outcome added.");
      onSaved();
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit outcome" : "Add outcome"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div>
              <Label htmlFor="o-label">Label</Label>
              <Input id="o-label" maxLength={40} value={f.label} onChange={(e) => set("label", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="o-color">Colour</Label>
              <Input id="o-color" type="color" className="h-10 w-14 cursor-pointer p-1" value={f.color} onChange={(e) => set("color", e.target.value.toUpperCase())} />
            </div>
          </div>
          <div>
            <Label htmlFor="o-base">Base outcome</Label>
            <NativeSelect id="o-base" value={f.baseOutcome} onChange={(e) => set("baseOutcome", e.target.value as CallOutcome)}>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {OUTCOME_LABEL[b]}
                </option>
              ))}
            </NativeSelect>
            <Hint>Sets the contact status and what reports and Zoho see.</Hint>
          </div>
          <div>
            <Label htmlFor="o-rule">After picking it</Label>
            <NativeSelect id="o-rule" value={f.rule} onChange={(e) => set("rule", e.target.value as OutcomeRule)}>
              {RULES.map((r) => (
                <option key={r} value={r}>
                  {RULE_LABEL[r]}
                </option>
              ))}
            </NativeSelect>
          </div>
          {f.rule === "RETRY" && (
            <div className="max-w-xs">
              <Label htmlFor="o-hours">Retry after (hours)</Label>
              <Input id="o-hours" inputMode="numeric" value={f.retryHours ?? ""} onChange={(e) => set("retryHours", e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")))} />
            </div>
          )}
          {f.rule === "REMOVE_FROM_LISTS" && (
            <div className="flex min-h-11 items-center gap-2">
              <Checkbox id="o-dnc" checked={!!f.addToDnc} onCheckedChange={(v) => set("addToDnc", v === true)} />
              <Label htmlFor="o-dnc" className="mb-0 cursor-pointer">
                Also mark the number do-not-call (e.g. wrong number)
              </Label>
            </div>
          )}
          <div className="flex min-h-11 items-center gap-2">
            <Checkbox id="o-active" checked={f.active !== false} onCheckedChange={(v) => set("active", v === true)} />
            <Label htmlFor="o-active" className="mb-0 cursor-pointer">
              Active
            </Label>
          </div>
          {error && f.label && <p className="text-sm text-amber-700">{error}</p>}
          <FormError error={save.error} />
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!!error || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
