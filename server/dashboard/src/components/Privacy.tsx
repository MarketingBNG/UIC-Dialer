import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ClientImportResult, type ClientNumber, type PrivacySettings } from "../api";
import { formatWhen } from "../format";
import { ConfirmDialog, Empty, ErrorBox, Spinner, Toggle } from "../ui";

/** Recording retention (off = keep forever, by days) and PII masking. Admin only. */
export function PrivacyPanel() {
  const settings = useQuery({ queryKey: ["privacy"], queryFn: () => api<PrivacySettings>("/api/settings/privacy") });
  return (
    <section className="card p-4 sm:p-6">
      <h2 className="font-semibold">Recording retention and privacy</h2>
      {settings.isPending ? (
        <Spinner label="Loading privacy settings" />
      ) : settings.isError ? (
        <ErrorBox error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <PrivacyForm key={JSON.stringify(settings.data)} initial={settings.data} />
      )}
    </section>
  );
}

/**
 * Days shown in the form: the days setting, else the legacy months setting converted with a ceiling (calendar months
 * average 30.44 days), so switching to days never deletes audio the months setting would still have kept.
 */
const initialDays = (p: PrivacySettings) => p.retentionDays ?? (p.retentionMonths != null ? Math.ceil((p.retentionMonths * 365.25) / 12) : null);

function PrivacyForm({ initial }: { initial: PrivacySettings }) {
  const qc = useQueryClient();
  const startDays = initialDays(initial);
  const [on, setOn] = useState(startDays !== null);
  const [days, setDays] = useState(String(startDays ?? 365));
  const [deleteTranscript, setDeleteTranscript] = useState(initial.retentionDeleteTranscript ?? false);
  const [maskPii, setMaskPii] = useState(initial.maskPii);
  // Retention is only written when its controls were touched; a PII-only change sends just maskPii.
  const [retentionTouched, setRetentionTouched] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const daysOk = !on || (/^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 3650);
  const nextDays = on ? Number(days) : null;
  const nextDeleteTranscript = on && deleteTranscript;
  const retentionChanged =
    retentionTouched &&
    (nextDays !== startDays || nextDeleteTranscript !== (initial.retentionDeleteTranscript ?? false) || (initial.retentionMonths != null && initial.retentionDays == null));
  // The dashboard edits days only; writing days clears the legacy months value (one source of truth).
  const next: Partial<PrivacySettings> = retentionChanged
    ? { retentionDays: nextDays, retentionMonths: null, retentionDeleteTranscript: nextDeleteTranscript, maskPii }
    : { maskPii };
  const dirty = retentionChanged || maskPii !== initial.maskPii;
  // Turning deletion on, shortening it, or adding transcript deletion deletes data: ask first.
  const deletesMore =
    retentionChanged && nextDays !== null && (startDays === null || nextDays < startDays || (nextDeleteTranscript && !initial.retentionDeleteTranscript));

  const save = useMutation({
    mutationFn: () => api<PrivacySettings>("/api/settings/privacy", { method: "PUT", body: next }),
    onSuccess: (data) => {
      setSaved(true);
      qc.setQueryData(["privacy"], data);
    },
  });
  const submit = () => (deletesMore ? setConfirm(true) : save.mutate());
  const touch = () => setSaved(false);
  const touchRetention = () => {
    setSaved(false);
    setRetentionTouched(true);
  };

  return (
    <form
      className="mt-2 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && daysOk) submit();
      }}
    >
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        <Toggle
          label="Delete old recordings"
          hint="Off by default: recordings are kept forever. When on, audio of calls older than the days below is deleted once a day."
          checked={on}
          onChange={(v) => {
            touchRetention();
            setOn(v);
          }}
        />
        {on && (
          <div className="space-y-2 py-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label htmlFor="p-days">Delete recordings after</label>
              <input
                id="p-days"
                inputMode="numeric"
                className="input w-24"
                value={days}
                aria-invalid={!daysOk}
                onChange={(e) => {
                  touchRetention();
                  setDays(e.target.value);
                }}
              />
              <span>days</span>
            </div>
            <p className={`hint ${daysOk ? "" : "text-red-600"}`}>1 to 3650. Deleted audio can't be recovered.</p>
            {initial.retentionMonths != null && initial.retentionDays == null && (
              <p className="hint">Currently set as {initial.retentionMonths} months by an older version; saving switches it to days.</p>
            )}
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-brand-600"
                checked={deleteTranscript}
                onChange={(e) => {
                  touchRetention();
                  setDeleteTranscript(e.target.checked);
                }}
              />
              Also delete transcript text (summary and score are kept)
            </label>
          </div>
        )}
        <Toggle
          label="Mask Aadhaar and card numbers in new transcripts"
          hint="Replaces them with the last 4 digits before the transcript is stored. Existing transcripts are not changed. PAN and GST numbers are kept."
          checked={maskPii}
          onChange={(v) => {
            touch();
            setMaskPii(v);
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn-primary" disabled={!dirty || !daysOk || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <span aria-live="polite" className="text-sm">
          {saved && !dirty && <span className="text-emerald-700 dark:text-emerald-400">Saved.</span>}
          {save.error && <span className="text-red-600 dark:text-red-400">{save.error.message}</span>}
        </span>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Delete old recordings?"
        body={`Audio of calls older than ${nextDays} days will be deleted permanently in the next daily run.${
          nextDeleteTranscript ? " Their transcript text is cleared too; summaries and scores stay." : " Transcripts stay."
        }`}
        confirmLabel="Turn on deletion"
        busy={save.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          save.mutate();
        }}
      />
    </form>
  );
}

/** Business-only mode: numbers that always upload, even when saved as a personal contact. */
export function ClientListPanel() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["client-numbers"], queryFn: () => api<{ items: ClientNumber[]; count: number }>("/api/client-numbers") });
  const [number, setNumber] = useState("");
  const [label, setLabel] = useState("");
  const [filter, setFilter] = useState("");
  const [imported, setImported] = useState<ClientImportResult | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["client-numbers"] });

  const add = useMutation({
    mutationFn: () => api<ClientNumber>("/api/client-numbers", { method: "POST", body: { number, label: label || undefined } }),
    onSuccess: () => {
      setNumber("");
      setLabel("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/api/client-numbers/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const importCsv = useMutation({
    mutationFn: async (file: File) => api<ClientImportResult>("/api/client-numbers/import", { method: "POST", body: { csv: await file.text() } }),
    onSuccess: (r) => {
      setImported(r);
      refresh();
    },
  });

  const items = (list.data?.items ?? []).filter((i) => {
    const f = filter.trim().toLowerCase();
    return !f || i.raw.includes(f) || (i.label ?? "").toLowerCase().includes(f);
  });

  return (
    <section className="card mt-4 p-4 sm:p-6">
      <h2 className="font-semibold">Client list</h2>
      <p className="hint">
        With "Business calls only" on, phones skip calls with numbers saved as personal contacts, unless the number is on this list. Phones get the list
        as hashes, which hides it from casual view only.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (number.trim()) add.mutate();
        }}
      >
        <div>
          <label className="label" htmlFor="cn-number">
            Phone number
          </label>
          <input id="cn-number" className="input" inputMode="tel" value={number} onChange={(e) => setNumber(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cn-label">
            Label (optional)
          </label>
          <input id="cn-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <button type="submit" className="btn-primary" disabled={!number.trim() || add.isPending}>
          Add
        </button>
        <label className="btn-outline cursor-pointer">
          {importCsv.isPending ? "Importing…" : "Import CSV"}
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importCsv.mutate(f);
              e.target.value = "";
            }}
          />
        </label>
      </form>
      <p className="hint">CSV: one number per line, optional label after a comma. A header row is skipped.</p>
      <div aria-live="polite" className="text-sm">
        {add.error && <p className="text-red-600 dark:text-red-400">{add.error.message}</p>}
        {importCsv.error && <p className="text-red-600 dark:text-red-400">{importCsv.error.message}</p>}
        {remove.error && <p className="text-red-600 dark:text-red-400">{remove.error.message}</p>}
        {imported && (
          <p className="text-emerald-700 dark:text-emerald-400">
            Imported: {imported.added} added, {imported.updated} labels updated, {imported.rejected} lines skipped
            {imported.rejectedSample.length > 0 && ` (e.g. ${imported.rejectedSample.slice(0, 3).join("; ")})`}.
          </p>
        )}
      </div>

      {list.isPending ? (
        <Spinner label="Loading client list" />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.count === 0 ? (
        <div className="mt-3">
          <Empty>No client numbers yet.</Empty>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <label htmlFor="cn-filter" className="sr-only">
              Filter client numbers
            </label>
            <input id="cn-filter" type="search" className="input sm:max-w-xs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="text-sm text-slate-500">{list.data.count} numbers</span>
          </div>
          <ul className="mt-2 max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {items.slice(0, 500).map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="font-mono">{i.raw}</span>
                <span className="min-w-0 flex-1 truncate text-slate-500">{i.label}</span>
                <span className="hidden text-xs text-slate-400 sm:inline">{formatWhen(i.createdAt)}</span>
                <button type="button" className="btn-ghost text-red-700 dark:text-red-300" disabled={remove.isPending} onClick={() => remove.mutate(i.id)} aria-label={`Remove ${i.raw}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {items.length > 500 && <p className="hint">Showing 500 of {items.length}. Use the filter to find a number.</p>}
        </>
      )}
    </section>
  );
}
