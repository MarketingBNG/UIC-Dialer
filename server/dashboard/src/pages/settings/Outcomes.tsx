import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CallOutcome, type OutcomeDto, type OutcomeInput, type OutcomeRule } from "../../api";
import { OUTCOME_LABEL } from "../../format";
import { OutcomeChip, RULE_LABEL } from "../../components/Outcomes";
import { Badge, Empty, ErrorBox, Modal, Spinner } from "../../ui";

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
    onSuccess: refresh,
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
    <section className="card p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Call outcomes</h2>
          <p className="hint">The buttons reps pick after a call, in this order. Each maps to a base outcome so reports and Zoho keep working.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditing("new")}>
          Add outcome
        </button>
      </div>
      {list.isPending ? (
        <Spinner label="Loading outcomes" />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <Empty>No outcomes.</Empty>
      ) : (
        <ol className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((o, i) => (
            <li key={o.id} className={`flex flex-wrap items-center gap-3 py-2 ${o.active ? "" : "opacity-60"}`}>
              <div className="flex flex-col">
                <button type="button" className="btn-ghost min-h-6 px-2 py-0" aria-label={`Move ${o.label} up`} disabled={i === 0 || order.isPending} onClick={() => move(i, -1)}>
                  ▲
                </button>
                <button type="button" className="btn-ghost min-h-6 px-2 py-0" aria-label={`Move ${o.label} down`} disabled={i === items.length - 1 || order.isPending} onClick={() => move(i, 1)}>
                  ▼
                </button>
              </div>
              <OutcomeChip label={o.label} color={o.color} />
              <span className="min-w-0 flex-1 text-sm text-slate-600 dark:text-slate-400">
                {OUTCOME_LABEL[o.baseOutcome]} · {RULE_LABEL[o.rule]}
                {o.rule === "RETRY" && o.retryHours ? ` in ${o.retryHours} h` : ""}
                {o.addToDnc ? " · adds to do-not-call" : ""}
              </span>
              {!o.active && <Badge>Inactive</Badge>}
              <button type="button" className="btn-ghost" onClick={() => setEditing(o)}>
                Edit
              </button>
              <button type="button" className="btn-ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(o)}>
                {o.active ? "Deactivate" : "Activate"}
              </button>
            </li>
          ))}
        </ol>
      )}
      {(order.error || toggle.error) && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{(order.error ?? toggle.error)?.message}</p>}
      {editing && <OutcomeDialog key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </section>
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
      onSaved();
      onClose();
    },
  });

  return (
    <Modal
      open
      title={initial ? "Edit outcome" : "Add outcome"}
      onClose={() => !save.isPending && onClose()}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!!error || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div>
            <label className="label" htmlFor="o-label">
              Label
            </label>
            <input id="o-label" className="input" maxLength={40} value={f.label} onChange={(e) => set("label", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="o-color">
              Colour
            </label>
            <input id="o-color" type="color" className="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 dark:border-slate-700" value={f.color} onChange={(e) => set("color", e.target.value.toUpperCase())} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="o-base">
            Base outcome
          </label>
          <select id="o-base" className="input" value={f.baseOutcome} onChange={(e) => set("baseOutcome", e.target.value as CallOutcome)}>
            {BASES.map((b) => (
              <option key={b} value={b}>
                {OUTCOME_LABEL[b]}
              </option>
            ))}
          </select>
          <p className="hint">Sets the contact status and what reports and Zoho see.</p>
        </div>
        <div>
          <label className="label" htmlFor="o-rule">
            After picking it
          </label>
          <select id="o-rule" className="input" value={f.rule} onChange={(e) => set("rule", e.target.value as OutcomeRule)}>
            {RULES.map((r) => (
              <option key={r} value={r}>
                {RULE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        {f.rule === "RETRY" && (
          <div className="max-w-xs">
            <label className="label" htmlFor="o-hours">
              Retry after (hours)
            </label>
            <input
              id="o-hours"
              inputMode="numeric"
              className="input"
              value={f.retryHours ?? ""}
              onChange={(e) => set("retryHours", e.target.value === "" ? null : Number(e.target.value.replace(/\D/g, "")))}
            />
          </div>
        )}
        {f.rule === "REMOVE_FROM_LISTS" && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand-600" checked={!!f.addToDnc} onChange={(e) => set("addToDnc", e.target.checked)} />
            Also mark the number do-not-call (e.g. wrong number)
          </label>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-brand-600" checked={f.active !== false} onChange={(e) => set("active", e.target.checked)} />
          Active
        </label>
        {error && f.label && <p className="text-sm text-amber-700 dark:text-amber-400">{error}</p>}
        {save.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {save.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
