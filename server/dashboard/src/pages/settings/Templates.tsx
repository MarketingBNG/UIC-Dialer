import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, renderTemplate, repName, type TemplateDto } from "../../api";
import { useMe } from "../../App";
import { Badge, ConfirmDialog, Empty, ErrorBox, Modal, Spinner } from "../../ui";

export function TemplatesTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["templates", "all"], queryFn: () => api<{ items: TemplateDto[] }>("/api/templates?all=1") });
  const [editing, setEditing] = useState<TemplateDto | "new" | null>(null);
  const [deleting, setDeleting] = useState<TemplateDto | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["templates"] });
  const del = useMutation({
    mutationFn: (id: string) => api<void>(`/api/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
  });
  return (
    <section className="card p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">Message templates</h2>
          <p className="hint">
            Reps pick these to send a WhatsApp or SMS. Use <code>{"{name}"}</code> for the contact's first name and <code>{"{rep}"}</code> for the rep's.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setEditing("new")}>
          New template
        </button>
      </div>
      {list.isPending ? (
        <Spinner label="Loading templates" />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <div className="mt-3">
          <Empty>No templates yet.</Empty>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
          {list.data.items.map((t) => (
            <li key={t.id} className={`flex flex-wrap items-start gap-3 py-3 text-sm ${t.active ? "" : "opacity-60"}`}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  {t.whatsapp && <Badge tone="green">WhatsApp</Badge>}
                  {t.sms && <Badge tone="blue">SMS</Badge>}
                  {!t.active && <Badge>Inactive</Badge>}
                </div>
                <p className="mt-1 line-clamp-2 whitespace-pre-line text-slate-500">{t.body}</p>
              </div>
              <button type="button" className="btn-ghost" onClick={() => setEditing(t)}>
                Edit
              </button>
              <button type="button" className="btn-ghost text-red-700 dark:text-red-300" onClick={() => setDeleting(t)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <TemplateDialog key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      <ConfirmDialog
        open={!!deleting}
        title="Delete template?"
        body={`"${deleting?.name ?? ""}" is removed for everyone. Past messages keep their text.`}
        confirmLabel="Delete"
        busy={del.isPending}
        error={del.error}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </section>
  );
}

function TemplateDialog({ initial, onClose, onSaved }: { initial: TemplateDto | null; onClose: () => void; onSaved: () => void }) {
  const me = useMe();
  const [name, setName] = useState(initial?.name ?? "");
  const [body, setBody] = useState(initial?.body ?? "Hi {name}, this is {rep} from UIC. ");
  const [whatsapp, setWhatsapp] = useState(initial?.whatsapp ?? true);
  const [sms, setSms] = useState(initial?.sms ?? true);
  const [active, setActive] = useState(initial?.active ?? true);
  const ok = !!name.trim() && !!body.trim() && (whatsapp || sms);
  const save = useMutation({
    mutationFn: () => {
      const b = { name: name.trim(), body: body.trim(), whatsapp, sms, active };
      return initial ? api<TemplateDto>(`/api/templates/${initial.id}`, { method: "PATCH", body: b }) : api<TemplateDto>("/api/templates", { method: "POST", body: b });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={initial ? "Edit template" : "New template"}
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
          <label className="label" htmlFor="tp-name">
            Name
          </label>
          <input id="tp-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="tp-body">
            Message
          </label>
          <textarea id="tp-body" className="input py-2" rows={5} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
          <p className="hint">{body.length}/1000</p>
        </div>
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="label">Channels</legend>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" className="size-4 accent-brand-600" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} />
            WhatsApp
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" className="size-4 accent-brand-600" checked={sms} onChange={(e) => setSms(e.target.checked)} />
            SMS
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" className="size-4 accent-brand-600" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
        </fieldset>
        {!whatsapp && !sms && <p className="text-sm text-amber-700 dark:text-amber-400">Pick at least one channel.</p>}
        <div>
          <div className="label">Preview (to Priya Shah)</div>
          <p className="whitespace-pre-line rounded-lg bg-emerald-50 p-3 text-sm text-slate-800 dark:bg-emerald-950 dark:text-slate-100">{renderTemplate(body, "Priya Shah", repName(me))}</p>
        </div>
        {save.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {save.error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}
