import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Plus, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, qs, type ClientImportResult, type DncDto, type DncPage, type DncSource } from "../../api";
import { useMe } from "../../App";
import { formatShortWhen, personName } from "../../format";
import { Empty, ErrorBox, FormError, Hint, PageHeader, Spinner } from "../../ui";

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
      toast.success(`${phone.trim()} added to do-not-call.`);
      setPhone("");
      setReason("");
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/api/dnc/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Removed from do-not-call.");
      setRemoving(null);
      refresh();
    },
  });
  const importCsv = useMutation({
    mutationFn: async (file: File) => api<ClientImportResult>("/api/dnc/import", { method: "POST", body: { csv: await file.text() } }),
    onSuccess: (r) => {
      setImported(r);
      toast.success(`Imported: ${r.added} added, ${r.updated} updated.`);
      refresh();
    },
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const count = list.data?.pages[0]?.count;

  return (
    <>
      {standalone && <PageHeader title="Do-not-call list" subtitle="Numbers that are never put on call lists or given new leads. Dialling one asks first." />}
      <Card>
        {!standalone && (
          <CardHeader>
            <CardTitle>Do-not-call list</CardTitle>
            <CardDescription>Numbers here are never put on call lists or given new leads, and dialling one asks first. Matching uses the last 10 digits.</CardDescription>
          </CardHeader>
        )}
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (phone.trim()) add.mutate();
            }}
          >
            <div>
              <Label htmlFor="dnc-phone">Phone number</Label>
              <Input id="dnc-phone" inputMode="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="min-w-48 flex-1 sm:max-w-sm">
              <Label htmlFor="dnc-reason">Reason (optional)</Label>
              <Input id="dnc-reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button type="submit" disabled={!phone.trim() || add.isPending}>
              <Plus aria-hidden />
              Add number
            </Button>
            {me.role === "ADMIN" && (
              <Button variant="outline" asChild>
                <label className="cursor-pointer">
                  <Upload aria-hidden />
                  {importCsv.isPending ? "Importing…" : "Import CSV"}
                  <Input
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
              </Button>
            )}
          </form>
          {me.role === "ADMIN" && <Hint>CSV: one number per line, optional reason after a comma.</Hint>}
          <div aria-live="polite" className="mt-1 text-sm">
            <FormError error={add.error} />
            <FormError error={importCsv.error} />
            {imported && (
              <p className="text-success-text">
                Imported: {imported.added} added, {imported.updated} updated, {imported.rejected} lines skipped
                {imported.rejectedSample.length > 0 && ` (e.g. ${imported.rejectedSample.slice(0, 3).join("; ")})`}.
              </p>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Label htmlFor="dnc-q" className="sr-only">
              Search do-not-call numbers
            </Label>
            <div className="relative w-full sm:max-w-xs">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="dnc-q" type="search" className="pl-9" placeholder="Search number or reason" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {count != null && <span className="text-sm text-muted-foreground">{count} numbers</span>}
          </div>
          {list.isPending ? (
            <Spinner label="Loading do-not-call list" />
          ) : list.isError && items.length === 0 ? (
            <div className="mt-3">
              <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="mt-3">
              <Empty icon={<Ban />}>{dq ? "No numbers match. Try fewer digits." : "No numbers on the do-not-call list. Add one above when someone asks not to be called."}</Empty>
            </div>
          ) : (
            <>
              <Table className="mt-3">
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="hidden sm:table-cell">Added</TableHead>
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="font-mono">{d.phoneE164 ?? d.raw}</TableCell>
                      <TableCell>
                        <Badge variant={d.source === "OUTCOME" ? "amber" : "gray"}>{SOURCE_LABEL[d.source]}</Badge>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-muted-foreground">{d.reason}</TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                        {d.createdBy ? `${personName(d.createdBy)} · ` : ""}
                        {formatShortWhen(d.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setRemoving(d)} aria-label={`Remove ${d.phoneE164 ?? d.raw}`}>
                          <Trash2 aria-hidden />
                          Remove
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {list.hasNextPage && (
                <Button variant="outline" className="mt-3 w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {list.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <AlertDialog open={!!removing} onOpenChange={(o) => !o && !remove.isPending && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from do-not-call?</AlertDialogTitle>
            <AlertDialogDescription>{removing?.phoneE164 ?? removing?.raw ?? ""} can be called and added to lists again.</AlertDialogDescription>
          </AlertDialogHeader>
          <FormError error={remove.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing.id)}>
              {remove.isPending ? "Working…" : "Remove"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
