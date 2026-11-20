import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ImportMapping, type ImportPreview, type ImportResult } from "../api";
import { FileSpreadsheet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FormError, Hint } from "../ui";

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
        <Label htmlFor="csv-file">{fileName ? "Choose another CSV file" : "CSV file"}</Label>
        <Input
          id="csv-file"
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="cursor-pointer py-2"
          aria-describedby="csv-file-hint"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void state.pick(f);
            e.target.value = "";
          }}
        />
        {fileName && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <FileSpreadsheet className="size-4" aria-hidden /> {fileName}
          </p>
        )}
        <Hint id="csv-file-hint">Columns named Name, Phone, Company and City are matched automatically. Up to 20 000 rows.</Hint>
      </div>
      {fileError && <FormError error={new Error(fileError)} />}
      {preview.isPending && <p className="text-sm text-muted-foreground">Reading the file…</p>}
      {preview.error && <FormError error={preview.error} />}
      {p && (
        <>
          <p className="rounded-lg bg-muted p-3 text-sm">
            {p.total} rows · {p.new} new · {p.existing - p.existingElsewhere} already exist (will be updated)
            {p.existingElsewhere ? ` · ${p.existingElsewhere} belong to another team (left alone, not added to lists)` : ""} ·{" "}
            {p.bad} bad numbers skipped
            {p.duplicateInFile ? ` · ${p.duplicateInFile} repeated in the file` : ""}
            {p.dnc ? ` · ${p.dnc} on do-not-call (not added to lists)` : ""}
          </p>
          <div className="flex min-h-10 items-center gap-2">
            <Checkbox id="csv-header" checked={p.hasHeader} disabled={preview.isPending} onCheckedChange={(c) => state.setHeader(c === true)} />
            <Label htmlFor="csv-header" className="mb-0 cursor-pointer font-normal">
              First row is a header (column names)
            </Label>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <Label className="text-xs" htmlFor={`csv-${f.key}`}>
                  {f.label} column
                </Label>
                <NativeSelect
                  id={`csv-${f.key}`}
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
                </NativeSelect>
              </div>
            ))}
          </div>
          {p.badSample.length > 0 && <Hint>Bad: {p.badSample.slice(0, 5).join("; ")}</Hint>}
          {p.sample.length > 0 && (
            <div className="max-h-56 overflow-auto rounded-lg border">
              <Table className="text-xs">
                <TableHeader className="sticky top-0">
                  <TableRow>
                    {["Name", "Phone", "Company", "City", ""].map((h, i) => (
                      <TableHead key={i} scope="col" className="h-8 px-2">
                        {h || <span className="sr-only">Status</span>}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.sample.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="max-w-32 truncate px-2 py-1">{r.name ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap px-2 py-1 font-mono">{r.phoneE164 ?? "—"}</TableCell>
                      <TableCell className="max-w-32 truncate px-2 py-1">{r.company ?? "—"}</TableCell>
                      <TableCell className="max-w-24 truncate px-2 py-1">{r.city ?? "—"}</TableCell>
                      <TableCell className="px-2 py-1">
                        <Badge variant={STATUS_TONE[r.status]}>{r.status === "dnc" ? "DNC" : r.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
