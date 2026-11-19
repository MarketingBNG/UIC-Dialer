import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ImportMapping, type ImportPreview, type ImportResult } from "../api";
import { Badge } from "../ui";

const MAX_BYTES = 10 * 1024 * 1024;
const FIELDS: { key: keyof ImportMapping; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "company", label: "Company" },
  { key: "city", label: "City" },
];
const STATUS_TONE = { new: "green", existing: "blue", bad: "red", dnc: "amber" } as const;

/**
 * CSV contacts import state: pick a file → server preview (auto-matched columns) → change columns (preview again)
 * → import. Parsing is server-side (in-house parser); this only reads the file text.
 */
export function useCsvImport() {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const preview = useMutation({
    mutationFn: (body: { csv: string; mapping?: ImportMapping; hasHeader?: boolean }) =>
      api<ImportPreview>("/api/contacts/import/preview", { method: "POST", body }),
  });
  const run = useMutation({
    mutationFn: (opts: { ownerId?: string | null; listId?: string }) => {
      if (!csv || !preview.data) throw new Error("Pick a file first");
      return api<ImportResult>("/api/contacts/import", {
        method: "POST",
        body: { csv, mapping: preview.data.mapping, hasHeader: preview.data.hasHeader, ...opts },
      });
    },
  });
  const pick = async (f: File) => {
    setFileError(null);
    preview.reset();
    run.reset();
    if (f.size > MAX_BYTES) {
      setFileError("The file is over 10 MB.");
      return;
    }
    const text = await f.text();
    setCsv(text);
    setFileName(f.name);
    preview.mutate({ csv: text });
  };
  // A changed mapping or header choice means a different import: a kept result no longer applies.
  const remap = (m: ImportMapping, hasHeader = preview.data?.hasHeader) => {
    if (!csv) return;
    run.reset();
    preview.mutate({ csv, mapping: m, ...(hasHeader === undefined ? {} : { hasHeader }) });
  };
  /** "First row is a header" toggled: auto-match the columns again for that choice. */
  const setHeader = (hasHeader: boolean) => {
    if (!csv) return;
    run.reset();
    preview.mutate({ csv, hasHeader });
  };
  return { csv, fileName, fileError, preview, run, pick, remap, setHeader };
}
export type CsvImportState = ReturnType<typeof useCsvImport>;

/** File picker, counts, column dropdowns and the sample table. */
export function CsvImportView({ state }: { state: CsvImportState }) {
  const { preview, fileName, fileError } = state;
  const p = preview.data;
  return (
    <div className="space-y-3">
      <div>
        <label className="btn-outline cursor-pointer">
          {fileName ? "Choose another file" : "Choose CSV file"}
          <input
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void state.pick(f);
              e.target.value = "";
            }}
          />
        </label>
        {fileName && <span className="ml-2 text-sm text-slate-500">{fileName}</span>}
        <p className="hint">Columns named Name, Phone, Company and City are matched automatically. Up to 20 000 rows.</p>
      </div>
      {fileError && <p className="text-sm text-red-600 dark:text-red-400">{fileError}</p>}
      {preview.isPending && <p className="text-sm text-slate-500">Reading the file…</p>}
      {preview.error && <p className="text-sm text-red-600 dark:text-red-400">{preview.error.message}</p>}
      {p && (
        <>
          <p className="rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-800/60">
            {p.total} rows · {p.new} new · {p.existing - p.existingElsewhere} already exist (will be updated)
            {p.existingElsewhere ? ` · ${p.existingElsewhere} belong to another team (left alone, not added to lists)` : ""} ·{" "}
            {p.bad} bad numbers skipped
            {p.duplicateInFile ? ` · ${p.duplicateInFile} repeated in the file` : ""}
            {p.dnc ? ` · ${p.dnc} on do-not-call (not added to lists)` : ""}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-brand-600"
              checked={p.hasHeader}
              disabled={preview.isPending}
              onChange={(e) => state.setHeader(e.target.checked)}
            />
            First row is a header (column names)
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="text-xs font-medium text-slate-600 dark:text-slate-400" htmlFor={`csv-${f.key}`}>
                  {f.label}
                </label>
                <select
                  id={`csv-${f.key}`}
                  className="input"
                  value={p.mapping[f.key] ?? ""}
                  disabled={preview.isPending}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : Number(e.target.value);
                    if (f.key === "phone" && v === null) return;
                    state.remap({ ...p.mapping, [f.key]: v } as ImportMapping);
                  }}
                >
                  {f.key !== "phone" && <option value="">— none —</option>}
                  {p.columns.map((c, i) => (
                    <option key={i} value={i}>
                      {c || `Column ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {p.badSample.length > 0 && <p className="hint">Bad: {p.badSample.slice(0, 5).join("; ")}</p>}
          {p.sample.length > 0 && (
            <div className="max-h-56 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-500 dark:bg-slate-800">
                  <tr>
                    {["Name", "Phone", "Company", "City", ""].map((h, i) => (
                      <th key={i} scope="col" className="px-2 py-1.5 font-medium">
                        {h || <span className="sr-only">Status</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {p.sample.map((r, i) => (
                    <tr key={i}>
                      <td className="max-w-32 truncate px-2 py-1">{r.name ?? "—"}</td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono">{r.phoneE164 ?? "—"}</td>
                      <td className="max-w-32 truncate px-2 py-1">{r.company ?? "—"}</td>
                      <td className="max-w-24 truncate px-2 py-1">{r.city ?? "—"}</td>
                      <td className="px-2 py-1">
                        <Badge tone={STATUS_TONE[r.status]}>{r.status === "dnc" ? "DNC" : r.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Rows the import will write (new + your existing + DNC); bad rows and other teams' contacts are skipped. */
export const importCount = (p: ImportPreview | undefined) => (p ? p.new + p.existing - p.existingElsewhere + p.dnc : 0);

/** Rows that can go on a call list: like importCount, but do-not-call numbers never go on a list. */
export const listableCount = (p: ImportPreview | undefined) => (p ? p.new + p.existing - p.existingElsewhere : 0);
