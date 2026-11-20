import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type User } from "../../api";
import { personName } from "../../format";
import { Empty, ErrorBox, FormError, Spinner } from "../../ui";

/** "" → null; otherwise a whole number in range, or undefined when invalid. */
function parseTarget(v: string, max: number): number | null | undefined {
  if (v.trim() === "") return null;
  if (!/^\d+$/.test(v.trim())) return undefined;
  const n = Number(v);
  return n <= max ? n : undefined;
}
const str = (n: number | null | undefined) => (n == null ? "" : String(n));

/** Daily targets per rep: calls per day and talk minutes per day. Shown on Today and the Team page. */
export function TargetsTab() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users") });
  const active = (users.data ?? []).filter((u) => u.active);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkCalls, setBulkCalls] = useState("");
  const [bulkTalk, setBulkTalk] = useState("");
  const bc = parseTarget(bulkCalls, 1000);
  const bt = parseTarget(bulkTalk, 1440);
  const bulk = useMutation({
    mutationFn: () => api<{ updated: number }>("/api/targets", { method: "PUT", body: { userIds: selected, targetCallsPerDay: bc, targetTalkMinPerDay: bt } }),
    onSuccess: (r) => {
      setSelected([]);
      toast.success(`${r.updated} updated.`);
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const allOn = active.length > 0 && selected.length === active.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily targets</CardTitle>
        <CardDescription>Calls per day and talk minutes per day. Leave empty for no target. Reps see their progress on Today.</CardDescription>
      </CardHeader>
      <CardContent>
        {users.isPending ? (
          <Spinner label="Loading users" />
        ) : users.isError ? (
          <ErrorBox error={users.error} onRetry={() => void users.refetch()} />
        ) : active.length === 0 ? (
          <Empty>No active users. Add reps on the Users page first.</Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3 rounded-lg bg-muted p-3">
              <span className="w-full text-sm font-medium">Set for {selected.length} selected (tick reps in the table)</span>
              <div>
                <Label htmlFor="tg-bc">Calls/day</Label>
                <Input id="tg-bc" inputMode="numeric" className="w-28" value={bulkCalls} aria-invalid={bc === undefined} onChange={(e) => setBulkCalls(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="tg-bt">Talk min/day</Label>
                <Input id="tg-bt" inputMode="numeric" className="w-28" value={bulkTalk} aria-invalid={bt === undefined} onChange={(e) => setBulkTalk(e.target.value)} />
              </div>
              <Button disabled={!selected.length || bc === undefined || bt === undefined || bulk.isPending} onClick={() => bulk.mutate()}>
                {bulk.isPending ? "Saving…" : "Apply"}
              </Button>
              <span aria-live="polite">
                <FormError error={bulk.error} />
              </span>
            </div>
            <Table className="mt-3">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox aria-label="Select all" checked={allOn} onCheckedChange={(v) => setSelected(v === true ? active.map((u) => u.id) : [])} />
                  </TableHead>
                  <TableHead>Rep</TableHead>
                  <TableHead>Calls/day</TableHead>
                  <TableHead>Talk min/day</TableHead>
                  <TableHead>
                    <span className="sr-only">Save</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {active.map((u) => (
                  <TargetRow
                    key={`${u.id}-${str(u.targetCallsPerDay)}-${str(u.targetTalkMinPerDay)}`}
                    user={u}
                    selected={selected.includes(u.id)}
                    onSelect={(v) => setSelected((s) => (v ? [...s, u.id] : s.filter((x) => x !== u.id)))}
                  />
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TargetRow({ user, selected, onSelect }: { user: User; selected: boolean; onSelect: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [calls, setCalls] = useState(str(user.targetCallsPerDay));
  const [talk, setTalk] = useState(str(user.targetTalkMinPerDay));
  const c = parseTarget(calls, 1000);
  const t = parseTarget(talk, 1440);
  const dirty = calls !== str(user.targetCallsPerDay) || talk !== str(user.targetTalkMinPerDay);
  const save = useMutation({
    mutationFn: () => api(`/api/users/${user.id}`, { method: "PATCH", body: { targetCallsPerDay: c, targetTalkMinPerDay: t } }),
    onSuccess: () => {
      toast.success(`Targets saved for ${personName(user)}.`);
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  return (
    <TableRow>
      <TableCell>
        <Checkbox aria-label={`Select ${personName(user)}`} checked={selected} onCheckedChange={(v) => onSelect(v === true)} />
      </TableCell>
      <TableCell className="max-w-48 truncate font-medium">{personName(user)}</TableCell>
      <TableCell>
        <Input aria-label={`Calls per day for ${personName(user)}`} inputMode="numeric" className="w-24" value={calls} aria-invalid={c === undefined} onChange={(e) => setCalls(e.target.value)} />
      </TableCell>
      <TableCell>
        <Input aria-label={`Talk minutes per day for ${personName(user)}`} inputMode="numeric" className="w-24" value={talk} aria-invalid={t === undefined} onChange={(e) => setTalk(e.target.value)} />
      </TableCell>
      <TableCell className="text-right">
        <Button variant="outline" disabled={!dirty || c === undefined || t === undefined || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {save.error && <span className="ml-2 text-xs text-destructive">{save.error.message}</span>}
      </TableCell>
    </TableRow>
  );
}
