import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ScriptDto, type ScriptSection } from "../../api";
import { formatShortWhen } from "../../format";
import { Badge, Empty, ErrorBox, Modal, Spinner } from "../../ui";

type ScriptRow = ScriptDto & { listCount: number };
const DEFAULT_SECTIONS: ScriptSection[] = [
  { heading: "Open", text: "" },
  { heading: "Ask", text: "" },
  { heading: "If busy", text: "" },
];

export function ScriptsTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["scripts"], queryFn: () => api<{ items: ScriptRow[] }>("/api/scripts") });
  const [editing, setEditing] = useState<ScriptRow | "new" | null>(null);
  return (
    <section className="card p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Call scripts</h2>
          <p className="hint">Shown to reps while they work a call list. AI scoring checks calls against the list's script.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditing("new")}>
          New script
        </button>
      </div>
      {list.isPending ? (
        <Spinner label="Loading scripts" />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <div className="mt-3">
          <Empty>No scripts yet.</Empty>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
          {list.data.items.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="font-medium">{s.name}</span>
              {!s.active && <Badge>Inactive</Badge>}
              <span className="min-w-0 flex-1 text-slate-500">
                {s.sections.length} section{s.sections.length === 1 ? "" : "s"} · used by {s.listCount} list{s.listCount === 1 ? "" : "s"} · updated {formatShortWhen(s.updatedAt)}
              </span>
              <button type="button" className="btn-ghost" onClick={() => setEditing(s)}>
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ScriptDialog
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ["scripts"] })}
        />
      )}
    </section>
  );
}

function ScriptDialog({ initial, onClose, onSaved }: { initial: ScriptDto | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [sections, setSections] = useState<ScriptSection[]>(initial?.sections.length ? initial.sections : DEFAULT_SECTIONS);
  const setSec = (i: number, k: keyof ScriptSection, v: string) => setSections((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const clean = sections.map((s) => ({ heading: s.heading.trim(), text: s.text.trim() })).filter((s) => s.heading || s.text);
  const ok = !!name.trim() && clean.length >= 1 && clean.length <= 10 && clean.every((s) => s.heading && s.heading.length <= 40 && s.text.length <= 2000);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), sections: clean, active };
      return initial ? api<ScriptDto>(`/api/scripts/${initial.id}`, { method: "PATCH", body }) : api<ScriptDto>("/api/scripts", { method: "POST", body });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={initial ? "Edit script" : "New script"}
      onClose={() => !save.isPending && onClose()}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="sc-name">
            Name
          </label>
          <input id="sc-name" className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {sections.map((s, i) => (
          <fieldset key={i} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <legend className="sr-only">Section {i + 1}</legend>
            <div className="flex gap-2">
              <input aria-label={`Section ${i + 1} heading`} className="input font-semibold" maxLength={40} placeholder="Heading" value={s.heading} onChange={(e) => setSec(i, "heading", e.target.value)} />
              <button type="button" className="btn-ghost" aria-label={`Remove section ${i + 1}`} disabled={sections.length <= 1} onClick={() => setSections((xs) => xs.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
            <textarea aria-label={`Section ${i + 1} text`} className="input py-2" rows={3} maxLength={2000} value={s.text} onChange={(e) => setSec(i, "text", e.target.value)} />
          </fieldset>
        ))}
        <button type="button" className="btn-outline" disabled={sections.length >= 10} onClick={() => setSections((xs) => [...xs, { heading: "", text: "" }])}>
          Add section
        </button>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-brand-600" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        {save.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {save.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
