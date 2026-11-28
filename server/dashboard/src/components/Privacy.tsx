import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState, type ReactNode } from "react";
import { api, type ClientImportResult, type ClientNumber, type PrivacySettings } from "../api";
import { Plus, Save, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { formatWhen } from "../format";
import { Empty, ErrorBox, FormError, Spinner, SwitchRow, ConfirmDialog } from "../ui";

/** Recording retention (off = keep forever, by days) and PII masking. Admin only. */
export function PrivacyPanel() {
  const settings = useQuery({ queryKey: ["privacy"], queryFn: () => api<PrivacySettings>("/api/settings/privacy") });
  return (
    <Card className="p-4 sm:p-6">
      <h2 className="font-semibold">Call audio and privacy</h2>
      {settings.isPending ? (
        <Spinner label="Loading privacy settings" />
      ) : settings.isError ? (
        <ErrorBox error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <PrivacyForm key={JSON.stringify(settings.data)} initial={settings.data} />
      )}
    </Card>
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
      <div className="divide-y">
        <SwitchRow
          label="Delete old call audio"
          hint="Off: audio is kept forever. On: audio older than the days below is deleted once a day. Transcripts are kept."
          checked={on}
          onChange={(v) => {
            touchRetention();
            setOn(v);
          }}
        />
        {on && (
          <div className="space-y-2 py-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Label htmlFor="p-days" className="mb-0">
                Delete call audio after
              </Label>
              <Input
                id="p-days"
                inputMode="numeric"
                className="w-24"
                value={days}
                aria-invalid={!daysOk}
                onChange={(e) => {
                  touchRetention();
                  setDays(e.target.value);
                }}
              />
              <span>{deleteTranscript ? "days" : "days (transcripts are kept)"}</span>
            </div>
            <p className={`mt-1 text-xs ${daysOk ? "text-muted-foreground" : "text-destructive"}`}>1 to 3650. Deleted audio can't be brought back.</p>
            {initial.retentionMonths != null && initial.retentionDays == null && (
              <p className="mt-1 text-xs text-muted-foreground">Currently set as {initial.retentionMonths} months by an older version; saving switches it to days.</p>
            )}
            <div className="flex items-start gap-2 text-sm">
              <Checkbox
                id="p-del-transcript"
                checked={deleteTranscript}
                onCheckedChange={(v) => {
                  touchRetention();
                  setDeleteTranscript(v === true);
                }}
              />
              <Label htmlFor="p-del-transcript" className="mb-0 cursor-pointer font-normal">
                Also delete transcript text (summary and score are kept)
              </Label>
            </div>
          </div>
        )}
        <SwitchRow
          label="Hide Aadhaar and card numbers in transcripts"
          hint="Only the last 4 digits are kept, for new transcripts. Older transcripts are not changed. PAN and GST numbers are kept."
          checked={maskPii}
          onChange={(v) => {
            touch();
            setMaskPii(v);
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" className="min-h-11" disabled={!dirty || !daysOk || save.isPending}>
          <Save /> {save.isPending ? "Saving…" : "Save changes"}
        </Button>
        <span aria-live="polite" className="text-sm">
          {saved && !dirty && <span className="text-success-text">Saved.</span>}
          {save.error && <span className="text-destructive">{save.error.message}</span>}
        </span>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Delete old call audio?"
        body={`Audio of calls older than ${nextDays} days will be deleted permanently in the next daily run.${
          nextDeleteTranscript ? " Their transcript text is cleared too; summaries and scores stay." : " Transcripts stay."
        }`}
        confirmLabel="Delete old audio"
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
  const fileRef = useRef<HTMLInputElement>(null);
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
    <Card className="mt-4 p-4 sm:p-6">
      <h2 className="font-semibold">Client list</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Numbers on this list always upload, even when a rep has saved them in their phone contacts.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (number.trim()) add.mutate();
        }}
      >
        <div>
          <Label htmlFor="cn-number">
            Phone number
          </Label>
          <Input id="cn-number"  inputMode="tel" value={number} onChange={(e) => setNumber(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cn-label">
            Label (optional)
          </Label>
          <Input id="cn-label"  value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <Button type="submit" className="min-h-11" disabled={!number.trim() || add.isPending}>
          <Plus /> Add number
        </Button>
        <Button variant="outline" className="min-h-11" disabled={importCsv.isPending} onClick={() => fileRef.current?.click()}>
          <Upload /> {importCsv.isPending ? "Importing…" : "Import CSV"}
        </Button>
        <Input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="sr-only"
          tabIndex={-1}
          aria-label="CSV file of client numbers"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importCsv.mutate(f);
            e.target.value = "";
          }}
        />
      </form>
      <p className="mt-1 text-xs text-muted-foreground">CSV: one number per line, optional label after a comma. A header row is skipped.</p>
      <div aria-live="polite" className="text-sm">
        {add.error && <p className="text-destructive">{add.error.message}</p>}
        {importCsv.error && <p className="text-destructive">{importCsv.error.message}</p>}
        {remove.error && <p className="text-destructive">{remove.error.message}</p>}
        {imported && (
          <p className="text-success-text">
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
          <Empty>No client numbers yet. Add a number above, or import a CSV with one number per line.</Empty>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Label htmlFor="cn-filter" className="sr-only">
              Filter client numbers
            </Label>
            <Input id="cn-filter" type="search" className="sm:max-w-xs" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="text-sm text-muted-foreground">{list.data.count} numbers</span>
          </div>
          <ul className="mt-2 max-h-96 divide-y overflow-y-auto">
            {items.slice(0, 500).map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="font-mono">{i.raw}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{i.label}</span>
                <span className="hidden text-xs text-muted-foreground sm:inline">{formatWhen(i.createdAt)}</span>
                <Button variant="ghost" className="min-h-11 text-destructive hover:text-destructive" disabled={remove.isPending} onClick={() => remove.mutate(i.id)} aria-label={`Remove ${i.raw}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {items.length > 500 && <p className="mt-1 text-xs text-muted-foreground">Showing 500 of {items.length}. Use the filter to find a number.</p>}
        </>
      )}
    </Card>
  );
}

/** A labelled shadcn Switch with helper text. */

/** Destructive confirmation on shadcn AlertDialog. */
