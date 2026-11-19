import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, qs, type ClientImportResult, type DncDto, type DncPage, type DncSource } from "../../api";
import { useMe } from "../../App";
import { formatShortWhen, personName } from "../../format";
import { Badge, ConfirmDialog, Empty, ErrorBox, PageHeader, Spinner } from "../../ui";

const SOURCE_LABEL: Record<DncSource, string> = { MANUAL: "Added", OUTCOME: "From outcome", IMPORT: "Imported" };

/** Do-not-call list: managers search, add and remove; admins also import a CSV. */
export function DncTab({ standalone = false }: { standalone?: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [removing, setRemoving] = useState<DncDto | null>(null);
  const [imported, setImported] = useState<ClientImportResult | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["dnc"] });
    void qc.invalidateQueries({ queryKey: ["contacts"] });
    void qc.invalidateQueries({ queryKey: ["contact"] });
  };

  const list = useInfiniteQuery({
    queryKey: ["dnc", dq],
    queryFn: ({ pageParam }) => api<DncPage>(`/api/dnc${qs({ q: dq, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const add = useMutation({
    mutationFn: () => api<DncDto>("/api/dnc", { method: "POST", body: { phone: phone.trim(), reason: reason.trim() || undefined } }),
    onSuccess: () => {
      setPhone("");
      setReason("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/api/dnc/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
  });
  const importCsv = useMutation({
    mutationFn: async (file: File) => api<ClientImportResult>("/api/dnc/import", { method: "POST", body: { csv: await file.text() } }),
    onSuccess: (r) => {
      setImported(r);
      refresh();
    },
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const count = list.data?.pages[0]?.count;

  return (
    <>
      {standalone && <PageHeader title="Do-not-call list" subtitle="Numbers that are never put on call lists or given new leads. Dialling one asks first." />}
      <section className="card p-4 sm:p-6">
        {!standalone && (
          <>
            <h2 className="font-semibold">Do-not-call list</h2>
            <p className="hint">Numbers here are never put on call lists or given new leads, and dialling one asks first. Matching uses the last 10 digits.</p>
          </>
        )}
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (phone.trim()) add.mutate();
          }}
        >
          <div>
            <label className="label" htmlFor="dnc-phone">
              Phone number
            </label>
            <input id="dnc-phone" className="input" inputMode="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="min-w-48 flex-1 sm:max-w-sm">
            <label className="label" htmlFor="dnc-reason">
              Reason (optional)
            </label>
            <input id="dnc-reason" className="input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <button type="submit" className="btn-primary" disabled={!phone.trim() || add.isPending}>
            Add
          </button>
          {me.role === "ADMIN" && (
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
          )}
        </form>
        {me.role === "ADMIN" && <p className="hint">CSV: one number per line, optional reason after a comma.</p>}
        <div aria-live="polite" className="text-sm">
          {add.error && <p className="text-red-600 dark:text-red-400">{add.error.message}</p>}
          {importCsv.error && <p className="text-red-600 dark:text-red-400">{importCsv.error.message}</p>}
          {imported && (
            <p className="text-emerald-700 dark:text-emerald-400">
              Imported: {imported.added} added, {imported.updated} updated, {imported.rejected} lines skipped
              {imported.rejectedSample.length > 0 && ` (e.g. ${imported.rejectedSample.slice(0, 3).join("; ")})`}.
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label htmlFor="dnc-q" className="sr-only">
            Search do-not-call numbers
          </label>
          <input id="dnc-q" type="search" className="input sm:max-w-xs" placeholder="Search number or reason" value={q} onChange={(e) => setQ(e.target.value)} />
          {count != null && <span className="text-sm text-slate-500">{count} numbers</span>}
        </div>
        {list.isPending ? (
          <Spinner label="Loading do-not-call list" />
        ) : list.isError && items.length === 0 ? (
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <div className="mt-3">
            <Empty>{dq ? "No numbers match." : "No numbers on the do-not-call list."}</Empty>
          </div>
        ) : (
          <>
            <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="font-mono">{d.phoneE164 ?? d.raw}</span>
                  <Badge tone={d.source === "OUTCOME" ? "amber" : "gray"}>{SOURCE_LABEL[d.source]}</Badge>
                  <span className="min-w-0 flex-1 truncate text-slate-500">{d.reason}</span>
                  <span className="hidden text-xs text-slate-400 sm:inline">
                    {d.createdBy ? `${personName(d.createdBy)} · ` : ""}
                    {formatShortWhen(d.createdAt)}
                  </span>
                  <button type="button" className="btn-ghost text-red-700 dark:text-red-300" onClick={() => setRemoving(d)} aria-label={`Remove ${d.phoneE164 ?? d.raw}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            {list.hasNextPage && (
              <button type="button" className="btn-outline mt-3 w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            )}
          </>
        )}
        <ConfirmDialog
          open={!!removing}
          title="Remove from do-not-call?"
          body={`${removing?.phoneE164 ?? removing?.raw ?? ""} can be called and added to lists again.`}
          confirmLabel="Remove"
          busy={remove.isPending}
          error={remove.error}
          onClose={() => setRemoving(null)}
          onConfirm={() => removing && remove.mutate(removing.id)}
        />
      </section>
    </>
  );
}
