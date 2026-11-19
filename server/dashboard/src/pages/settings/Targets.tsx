import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type User } from "../../api";
import { personName } from "../../format";
import { Empty, ErrorBox, Spinner } from "../../ui";

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
    onSuccess: () => {
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
  const allOn = active.length > 0 && selected.length === active.length;

  return (
    <section className="card p-4 sm:p-6">
      <h2 className="font-semibold">Daily targets</h2>
      <p className="hint">Calls per day and talk minutes per day. Leave empty for no target. Reps see their progress on Today.</p>
      {users.isPending ? (
        <Spinner label="Loading users" />
      ) : users.isError ? (
        <ErrorBox error={users.error} onRetry={() => void users.refetch()} />
      ) : active.length === 0 ? (
        <Empty>No active users.</Empty>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50">
            <span className="w-full text-sm font-medium">Set for {selected.length} selected</span>
            <div>
              <label className="label" htmlFor="tg-bc">
                Calls/day
              </label>
              <input id="tg-bc" inputMode="numeric" className="input w-28" value={bulkCalls} onChange={(e) => setBulkCalls(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="tg-bt">
                Talk min/day
              </label>
              <input id="tg-bt" inputMode="numeric" className="input w-28" value={bulkTalk} onChange={(e) => setBulkTalk(e.target.value)} />
            </div>
            <button type="button" className="btn-primary" disabled={!selected.length || bc === undefined || bt === undefined || bulk.isPending} onClick={() => bulk.mutate()}>
              {bulk.isPending ? "Saving…" : "Apply"}
            </button>
            <span aria-live="polite" className="text-sm">
              {bulk.data && <span className="text-emerald-700 dark:text-emerald-400">{bulk.data.updated} updated.</span>}
              {bulk.error && <span className="text-red-600 dark:text-red-400">{bulk.error.message}</span>}
            </span>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <tr>
                  <th scope="col" className="px-2 py-2">
                    <input type="checkbox" aria-label="Select all" className="size-4 accent-brand-600" checked={allOn} onChange={(e) => setSelected(e.target.checked ? active.map((u) => u.id) : [])} />
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Rep
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Calls/day
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    Talk min/day
                  </th>
                  <th scope="col" className="px-2 py-2">
                    <span className="sr-only">Save</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {active.map((u) => (
                  <TargetRow
                    key={`${u.id}-${str(u.targetCallsPerDay)}-${str(u.targetTalkMinPerDay)}`}
                    user={u}
                    selected={selected.includes(u.id)}
                    onSelect={(v) => setSelected((s) => (v ? [...s, u.id] : s.filter((x) => x !== u.id)))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["users"] }),
  });
  return (
    <tr>
      <td className="px-2 py-2">
        <input type="checkbox" aria-label={`Select ${personName(user)}`} className="size-4 accent-brand-600" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
      </td>
      <th scope="row" className="max-w-48 truncate px-2 py-2 font-medium">
        {personName(user)}
      </th>
      <td className="px-2 py-2">
        <input aria-label={`Calls per day for ${personName(user)}`} inputMode="numeric" className="input w-24" value={calls} aria-invalid={c === undefined} onChange={(e) => setCalls(e.target.value)} />
      </td>
      <td className="px-2 py-2">
        <input aria-label={`Talk minutes per day for ${personName(user)}`} inputMode="numeric" className="input w-24" value={talk} aria-invalid={t === undefined} onChange={(e) => setTalk(e.target.value)} />
      </td>
      <td className="px-2 py-2 text-right">
        <button type="button" className="btn-outline" disabled={!dirty || c === undefined || t === undefined || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {save.error && <span className="ml-2 text-xs text-red-600 dark:text-red-400">{save.error.message}</span>}
      </td>
    </tr>
  );
}
