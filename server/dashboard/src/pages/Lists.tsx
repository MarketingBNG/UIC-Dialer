import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
  ApiError,
  api,
  isManager,
  qs,
  type AddItemsResult,
  type CallListItemState,
  type CallListState,
  type ContactFilter,
  type CreateList,
  type ListDetail,
  type ListProgress,
  type ListResult,
  type ListSummary,
  type MyList,
  type NextResponse,
  type ScriptDto,
} from "../api";
import { useMe } from "../App";
import { CsvImportView, listableCount, useCsvImport } from "../components/CsvImport";
import { OutcomeChip } from "../components/Outcomes";
import { UserMultiSelect, useAssignableUsers } from "../components/UserPicker";
import { useDialer } from "../dialer";
import { CONTACT_STATUS_LABEL, formatShortWhen, personName } from "../format";
import { Badge, ConfirmDialog, Empty, ErrorBox, Modal, PageHeader, Spinner } from "../ui";

/** Router state the Contacts page passes to open "New call list" pre-filled. */
export interface NewListState {
  contactIds?: string[];
  filter?: ContactFilter;
}

const STATE_LABEL: Record<CallListState, string> = { ACTIVE: "Active", PAUSED: "Paused", ARCHIVED: "Archived" };
const STATE_TONE = { ACTIVE: "green", PAUSED: "amber", ARCHIVED: "gray" } as const;
const ITEM_LABEL: Record<CallListItemState, string> = { PENDING: "Waiting", IN_PROGRESS: "Calling", DONE: "Done", SKIPPED: "Skipped", REMOVED: "Removed" };
const ITEM_TONE = { PENDING: "gray", IN_PROGRESS: "blue", DONE: "green", SKIPPED: "amber", REMOVED: "red" } as const;

export const progressText = (p: ListProgress) => `${p.done} of ${p.total}`;

export function ProgressBar({ p }: { p: ListProgress }) {
  const w = p.total ? Math.round((100 * p.done) / p.total) : 0;
  return (
    <div className="min-w-32">
      <div className="mb-1 text-xs tabular-nums text-slate-600 dark:text-slate-400">{progressText(p)}</div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" role="progressbar" aria-valuenow={w} aria-valuemin={0} aria-valuemax={100} aria-label={`${progressText(p)} done`}>
        <div className="h-full rounded-full bg-brand-600" style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

export function ResultChips({ results }: { results: ListResult[] }) {
  if (!results.length) return <span className="text-xs text-slate-400">No outcomes yet</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {results.map((r) => (
        <OutcomeChip key={r.outcomeId ?? r.label} label={`${r.count} ${r.label.toLowerCase()}`} color={r.color} />
      ))}
    </div>
  );
}

/** Managers: every list in their scope. Everyone: "My lists" to work through. */
export function ListsPage() {
  const me = useMe();
  const manager = isManager(me.role);
  const location = useLocation();
  const navigate = useNavigate();
  const incoming = (location.state as { newList?: NewListState } | null)?.newList;
  const [creating, setCreating] = useState<NewListState | null>(manager && incoming ? incoming : null);
  // Drop the router state so a reload doesn't reopen the dialog.
  useEffect(() => {
    if (incoming) navigate(location.pathname, { replace: true, state: null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader
        title="Call lists"
        subtitle={manager ? "Build a list of numbers, assign reps, and watch it get worked." : "Lists your manager gave you. Start one to call through it."}
        actions={
          manager && (
            <button type="button" className="btn-primary" onClick={() => setCreating({})}>
              New call list
            </button>
          )
        }
      />
      <MyLists alwaysShow={!manager} />
      {manager && <ManagedLists />}
      {creating && (
        <NewListDialog
          initial={creating}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            navigate(`/lists/${id}`);
          }}
        />
      )}
    </>
  );
}

function MyLists({ alwaysShow }: { alwaysShow: boolean }) {
  const q = useQuery({ queryKey: ["my-lists"], queryFn: () => api<{ items: MyList[] }>("/api/my/call-lists") });
  if (q.isPending) return alwaysShow ? <Spinner label="Loading your lists" /> : null;
  if (q.isError) return alwaysShow ? <ErrorBox error={q.error} onRetry={() => void q.refetch()} /> : null;
  if (q.data.items.length === 0) return alwaysShow ? <Empty>No call lists assigned to you right now.</Empty> : null;
  return (
    <section aria-labelledby="my-lists-h" className="mb-6">
      <h2 id="my-lists-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        My lists · {q.data.items.length}
      </h2>
      <ul className="grid gap-3 md:grid-cols-2">
        {q.data.items.map((l) => (
          <li key={l.id} className="card flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-semibold">{l.name}</div>
                <div className="text-xs text-slate-500">
                  {l.createdBy ? `Assigned by ${personName(l.createdBy)}` : "Call list"}
                  {l.script ? ` · script: ${l.script.name}` : ""}
                </div>
              </div>
              {l.state !== "ACTIVE" && <Badge tone={STATE_TONE[l.state]}>{STATE_LABEL[l.state]}</Badge>}
            </div>
            <ProgressBar p={l.progress} />
            <ResultChips results={l.results} />
            <div className="flex gap-2">
              <Link to={`/lists/${l.id}/work`} className={`btn-call ${l.state !== "ACTIVE" ? "pointer-events-none opacity-50" : ""}`} aria-disabled={l.state !== "ACTIVE"}>
                {l.progress.inProgress ? "Continue" : "Start calling"}
              </Link>
              <Link to={`/lists/${l.id}`} className="btn-ghost">
                See numbers
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ManagedLists() {
  const [state, setState] = useState<CallListState | "">("");
  const q = useQuery({
    queryKey: ["call-lists", state],
    queryFn: () => api<{ items: ListSummary[] }>(`/api/call-lists${qs({ state })}`),
  });
  return (
    <section aria-labelledby="all-lists-h">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <h2 id="all-lists-h" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          All lists
        </h2>
        <div>
          <label className="sr-only" htmlFor="lists-state">
            Show
          </label>
          <select id="lists-state" className="input" value={state} onChange={(e) => setState(e.target.value as CallListState | "")}>
            <option value="">Active and paused</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="ARCHIVED">Archived</option>
          </select>
        </div>
      </div>
      {q.isPending ? (
        <Spinner label="Loading call lists" />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <Empty>No call lists yet. Pick contacts on the Contacts page, or press New call list.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <tr>
                {["Name", "Assigned to", "Script", "Progress", "Results"].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.items.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-4 py-3">
                    <Link to={`/lists/${l.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                      {l.name}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                      {l.state !== "ACTIVE" && <Badge tone={STATE_TONE[l.state]}>{STATE_LABEL[l.state]}</Badge>}
                      {formatShortWhen(l.createdAt)}
                    </div>
                  </td>
                  <td className="max-w-48 px-4 py-3">{l.assignees.map(personName).join(", ") || "—"}</td>
                  <td className="max-w-40 truncate px-4 py-3">{l.script?.name ?? "—"}</td>
                  <td className="px-4 py-3">
                    <ProgressBar p={l.progress} />
                  </td>
                  <td className="px-4 py-3">
                    <ResultChips results={l.results} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type Source = "filter" | "ids" | "csv";

function filterText(f: ContactFilter) {
  const parts = [
    f.q ? `"${f.q}"` : null,
    f.status ? CONTACT_STATUS_LABEL[f.status] : null,
    f.filter ? { interested: "Interested", callback: "Call back", never: "Never called", mine: "Mine", dnc: "Do-not-call" }[f.filter] : null,
    f.ownerId ? "one owner" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "all contacts you can see";
}

/** New call list from (a) a contacts filter, (b) selected contacts, or (c) a CSV (import first, then create). */
export function NewListDialog({ initial, onClose, onCreated }: { initial: NewListState; onClose: () => void; onCreated: (id: string) => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const users = useAssignableUsers(me);
  const scripts = useQuery({ queryKey: ["scripts"], queryFn: () => api<{ items: (ScriptDto & { listCount: number })[] }>("/api/scripts") });
  const [source, setSource] = useState<Source>(initial.contactIds?.length ? "ids" : initial.filter ? "filter" : "csv");
  const [name, setName] = useState("");
  const [scriptId, setScriptId] = useState("");
  const [assignees, setAssignees] = useState<string[]>([]);
  const csv = useCsvImport();
  const filter = initial.filter ?? {};

  const create = useMutation({
    mutationFn: async () => {
      const body: CreateList = { name: name.trim(), scriptId: scriptId || null, assigneeIds: assignees };
      if (source === "ids") body.contactIds = initial.contactIds ?? [];
      else if (source === "filter") body.filter = filter;
      else {
        // Import once: if the list create below fails, a retry reuses this import instead of running it again.
        const r = csv.run.data ?? (await csv.run.mutateAsync({ ownerId: null }));
        body.contactIds = r.contactIds;
      }
      return api<ListSummary & AddItemsResult>("/api/call-lists", { method: "POST", body });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["call-lists"] });
      void qc.invalidateQueries({ queryKey: ["my-lists"] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
      onCreated(r.id);
    },
  });
  const sourceOk = source === "ids" ? !!initial.contactIds?.length : source === "filter" ? true : !!csv.preview.data && listableCount(csv.preview.data) > 0;
  const ok = !!name.trim() && assignees.length > 0 && sourceOk && !csv.preview.isPending;

  const radio = (v: Source, label: string, disabled = false) => (
    <label className={`flex items-start gap-2 rounded-lg border border-slate-300 p-2 text-sm has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 dark:border-slate-700 dark:has-[:checked]:bg-slate-800 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input type="radio" name="list-source" className="mt-0.5 accent-brand-600" disabled={disabled} checked={source === v} onChange={() => setSource(v)} />
      <span>{label}</span>
    </label>
  );

  return (
    <Modal
      open
      title="New call list"
      onClose={() => !create.isPending && onClose()}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={create.isPending} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!ok || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create list"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="nl-name">
            Name
          </label>
          <input id="nl-name" className="input" maxLength={120} placeholder="Pune dealers, November" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <fieldset className="space-y-2">
          <legend className="label">Numbers</legend>
          {/* Only offered when the Contacts page passed its filter: an empty filter would list everyone in scope. */}
          {initial.filter && radio("filter", `Contacts filter: ${filterText(filter)}`)}
          {radio("ids", initial.contactIds?.length ? `${initial.contactIds.length} selected contacts` : "Selected contacts (pick them on the Contacts page)", !initial.contactIds?.length)}
          {radio("csv", "Upload a CSV")}
        </fieldset>
        {source === "csv" && <CsvImportView state={csv} />}
        {source === "csv" && csv.preview.data && listableCount(csv.preview.data) === 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">No number in this file can go on a list (do-not-call, another team&apos;s, or bad).</p>
        )}
        <p className="hint">Do-not-call numbers are left out automatically.</p>
        <UserMultiSelect label="Assign to" users={users.items} value={assignees} onChange={setAssignees} />
        <div>
          <label className="label" htmlFor="nl-script">
            Script (optional)
          </label>
          <select id="nl-script" className="input" value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
            <option value="">No script</option>
            {scripts.data?.items
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
        {(create.error || csv.run.error) && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {(create.error ?? csv.run.error)?.message}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** A list's numbers with state, last outcome, who and when. Managers can pause/resume/archive and reset/remove items. */
export function ListDetailPage() {
  const { id = "" } = useParams();
  const me = useMe();
  const manager = isManager(me.role);
  const qc = useQueryClient();
  const [state, setState] = useState<CallListItemState | "">("");
  const [confirm, setConfirm] = useState<{ kind: "archive" } | { kind: "remove"; itemId: string; label: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const detail = useInfiniteQuery({
    queryKey: ["call-list", id, state],
    queryFn: ({ pageParam }) => api<ListDetail>(`/api/call-lists/${id}${qs({ state, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["call-list", id] });
    void qc.invalidateQueries({ queryKey: ["call-lists"] });
    void qc.invalidateQueries({ queryKey: ["my-lists"] });
  };
  const patch = useMutation({
    mutationFn: (body: { state?: CallListState }) => api<ListSummary>(`/api/call-lists/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      setConfirm(null);
      refresh();
    },
  });
  const itemAction = useMutation({
    mutationFn: ({ itemId, action }: { itemId: string; action: "reset" | "remove" }) =>
      action === "reset" ? api(`/api/call-lists/${id}/items/${itemId}/reset`, { method: "POST", body: {} }) : api(`/api/call-lists/${id}/items/${itemId}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirm(null);
      refresh();
    },
  });

  if (detail.isPending) return <Spinner label="Loading call list" />;
  if (detail.isError && !detail.data) return <ErrorBox error={detail.error} onRetry={() => void detail.refetch()} />;
  const list = detail.data.pages[0]!.list;
  const items = detail.data.pages.flatMap((p) => p.items);
  const assigned = list.assignees.some((a) => a.id === me.id);

  return (
    <>
      <Link to="/lists" className="mb-3 inline-block text-sm text-brand-700 hover:underline dark:text-brand-100">
        ← Call lists
      </Link>
      <PageHeader
        title={list.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={STATE_TONE[list.state]}>{STATE_LABEL[list.state]}</Badge>
            <span>Assigned to {list.assignees.map(personName).join(", ") || "nobody"}</span>
            {list.script && <span>· script: {list.script.name}</span>}
          </span>
        }
        actions={
          <>
            {assigned && list.state === "ACTIVE" && (
              <Link to={`/lists/${id}/work`} className="btn-call">
                Start calling
              </Link>
            )}
            {manager && (
              <>
                <button type="button" className="btn-outline" onClick={() => setEditing(true)}>
                  Edit
                </button>
                {list.state === "ACTIVE" && (
                  <button type="button" className="btn-outline" disabled={patch.isPending} onClick={() => patch.mutate({ state: "PAUSED" })}>
                    Pause
                  </button>
                )}
                {list.state !== "ACTIVE" && (
                  <button type="button" className="btn-outline" disabled={patch.isPending} onClick={() => patch.mutate({ state: "ACTIVE" })}>
                    {list.state === "ARCHIVED" ? "Restore" : "Resume"}
                  </button>
                )}
                {list.state !== "ARCHIVED" && (
                  <button type="button" className="btn-ghost text-red-700 dark:text-red-300" onClick={() => setConfirm({ kind: "archive" })}>
                    Archive
                  </button>
                )}
              </>
            )}
          </>
        }
      />
      {patch.error && <ErrorBox error={patch.error} />}
      <div className="card mb-4 flex flex-wrap items-center gap-4 p-4">
        <div className="w-full max-w-sm">
          <ProgressBar p={list.progress} />
        </div>
        <div className="text-sm text-slate-600 dark:text-slate-400">
          {list.progress.pending} waiting · {list.progress.inProgress} being called · {list.progress.skipped} skipped · {list.progress.removed} removed
        </div>
        <ResultChips results={list.results} />
      </div>
      <div className="mb-3 max-w-xs">
        <label className="sr-only" htmlFor="ld-state">
          Show
        </label>
        <select id="ld-state" className="input" value={state} onChange={(e) => setState(e.target.value as CallListItemState | "")}>
          <option value="">All numbers</option>
          {(Object.keys(ITEM_LABEL) as CallListItemState[]).map((s) => (
            <option key={s} value={s}>
              {ITEM_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      {items.length === 0 ? (
        <Empty>No numbers here.</Empty>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <tr>
                {["#", "Contact", "State", "Last outcome", "Who", "When", ""].map((h, i) => (
                  <th key={i} scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
                    {h || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((it) => {
                const who = it.doneBy ?? it.claimedBy;
                const label = it.contact.name || it.contact.phoneE164;
                return (
                  <tr key={it.id}>
                    <td className="px-3 py-2 tabular-nums text-slate-500">{it.position + 1}</td>
                    <td className="px-3 py-2">
                      <Link to={`/activity/contacts/${it.contact.id}`} className="font-medium hover:underline">
                        {label}
                      </Link>
                      <div className="text-xs text-slate-500">
                        {[it.contact.name ? it.contact.phoneE164 : null, it.contact.company, it.contact.city].filter(Boolean).join(" · ")}
                        {it.contact.dnc && (
                          <span className="ml-1">
                            <Badge tone="red">DNC</Badge>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={ITEM_TONE[it.state]}>{ITEM_LABEL[it.state]}</Badge>
                      {it.retryAt && it.state === "PENDING" && <div className="text-xs text-slate-500">retry {formatShortWhen(it.retryAt)}</div>}
                      {it.attempts > 1 && <div className="text-xs text-slate-500">{it.attempts} attempts</div>}
                    </td>
                    <td className="px-3 py-2">{it.lastOutcome ? <OutcomeChip label={it.lastOutcome.label} color={it.lastOutcome.color} /> : "—"}</td>
                    <td className="max-w-36 truncate px-3 py-2">{who ? personName(who) : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">{it.lastActivityAt ? formatShortWhen(it.lastActivityAt) : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {manager && it.state !== "PENDING" && (
                        <button type="button" className="btn-ghost" disabled={itemAction.isPending} onClick={() => itemAction.mutate({ itemId: it.id, action: "reset" })}>
                          Reset
                        </button>
                      )}
                      {manager && it.state !== "REMOVED" && (
                        <button type="button" className="btn-ghost text-red-700 dark:text-red-300" onClick={() => setConfirm({ kind: "remove", itemId: it.id, label })}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {detail.hasNextPage && (
        <button type="button" className="btn-outline mt-4 w-full" disabled={detail.isFetchingNextPage} onClick={() => void detail.fetchNextPage()}>
          {detail.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
      {itemAction.error && !confirm && <ErrorBox error={itemAction.error} />}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === "archive" ? "Archive this list?" : "Remove this number?"}
        body={confirm?.kind === "archive" ? "Reps stop seeing it. You can restore it from the archived lists." : `${confirm?.kind === "remove" ? confirm.label : ""} is taken off this list.`}
        confirmLabel={confirm?.kind === "archive" ? "Archive" : "Remove"}
        busy={patch.isPending || itemAction.isPending}
        error={confirm?.kind === "archive" ? patch.error : itemAction.error}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.kind === "archive") patch.mutate({ state: "ARCHIVED" });
          else if (confirm?.kind === "remove") itemAction.mutate({ itemId: confirm.itemId, action: "remove" });
        }}
      />
      {editing && <EditListDialog list={list} onClose={() => setEditing(false)} onSaved={refresh} />}
    </>
  );
}

function EditListDialog({ list, onClose, onSaved }: { list: ListSummary; onClose: () => void; onSaved: () => void }) {
  const me = useMe();
  const users = useAssignableUsers(me);
  const scripts = useQuery({ queryKey: ["scripts"], queryFn: () => api<{ items: (ScriptDto & { listCount: number })[] }>("/api/scripts") });
  const [name, setName] = useState(list.name);
  const [scriptId, setScriptId] = useState(list.script?.id ?? "");
  const [assignees, setAssignees] = useState(list.assignees.map((a) => a.id));
  // Keep current assignees selectable even when outside the picker's scope.
  const pickable = [...users.items, ...list.assignees.filter((a) => !users.items.some((u) => u.id === a.id)).map((a) => ({ ...a, role: "AGENT" as const, team: null, active: true, excludedNumbers: [], lastLoginAt: null, createdAt: "" }))];
  const save = useMutation({
    mutationFn: () => api(`/api/call-lists/${list.id}`, { method: "PATCH", body: { name: name.trim(), scriptId: scriptId || null, assigneeIds: assignees } }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open
      title="Edit call list"
      onClose={() => !save.isPending && onClose()}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!name.trim() || !assignees.length || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="el-name">
            Name
          </label>
          <input id="el-name" className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <UserMultiSelect label="Assign to" users={pickable} value={assignees} onChange={setAssignees} />
        <div>
          <label className="label" htmlFor="el-script">
            Script
          </label>
          <select id="el-script" className="input" value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
            <option value="">No script</option>
            {scripts.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
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

function initials(name: string | null, phone: string) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return phone.slice(-2);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Power-dial session: the next number, Call now / Skip, the script; saving the outcome brings up the next number. */
export function ListSessionPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const dialer = useDialer();
  const lists = useQuery({ queryKey: ["my-lists"], queryFn: () => api<{ items: MyList[] }>("/api/my/call-lists") });
  const list = lists.data?.items.find((l) => l.id === id);
  // `next` is idempotent while I hold the lease, so refetching (remount, after an outcome) is safe.
  const next = useQuery({
    queryKey: ["list-next", id],
    queryFn: () => api<NextResponse>(`/api/my/call-lists/${id}/next`, { method: "POST", body: {} }),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const skip = useMutation({
    mutationFn: (itemId: string) => api<NextResponse>(`/api/my/call-list-items/${itemId}/skip`, { method: "POST", body: {} }),
    onSuccess: (r) => {
      qc.setQueryData(["list-next", id], r);
      void qc.invalidateQueries({ queryKey: ["my-lists"] });
    },
  });
  const pause = useMutation({
    mutationFn: () => api<void>(`/api/my/call-lists/${id}/release`, { method: "POST", body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["my-lists"] });
      qc.removeQueries({ queryKey: ["list-next", id] });
      navigate("/lists");
    },
  });

  const header = (
    <>
      <Link to="/lists" className="mb-3 inline-block text-sm text-brand-700 hover:underline dark:text-brand-100">
        ← Call lists
      </Link>
      <PageHeader
        title={list?.name ?? "Call list"}
        subtitle={list?.createdBy ? `Call list · assigned by ${personName(list.createdBy)}` : "Call list"}
        actions={
          <button type="button" className="btn-outline" disabled={pause.isPending} onClick={() => pause.mutate()}>
            {pause.isPending ? "Pausing…" : "Pause"}
          </button>
        }
      />
    </>
  );

  if (next.isPending) return (
    <>
      {header}
      <Spinner label="Getting the next number" />
    </>
  );
  if (next.isError) {
    const e = next.error;
    const msg =
      e instanceof ApiError && e.code === "LIST_PAUSED"
        ? "This list is paused by your admin."
        : e instanceof ApiError && e.code === "NOT_ASSIGNED"
          ? "You're not assigned to this list."
          : null;
    return (
      <>
        {header}
        {msg ? <Empty>{msg}</Empty> : <ErrorBox error={e} onRetry={() => void next.refetch()} />}
      </>
    );
  }
  const r = next.data;
  const results = r.results;
  const interested = results.find((x) => x.label.toLowerCase() === "interested")?.count;
  const callBack = results.find((x) => x.label.toLowerCase() === "call back")?.count;
  const it = r.item;
  const c = it?.contact;
  const label = c ? c.name || c.phoneE164 : "";
  const onThisCall = !!it && dialer.pending?.callListItemId === it.id;

  return (
    <>
      {header}
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <div className="card flex flex-wrap items-center gap-4 p-4">
            <div className="w-full max-w-xs">
              <ProgressBar p={r.progress} />
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400">
              {[interested != null ? `${interested} interested` : null, callBack != null ? `${callBack} call back` : null].filter(Boolean).join(" · ")}
            </div>
          </div>

          {!it ? (
            <section className="card p-6 text-center">
              <h2 className="text-lg font-semibold">All done</h2>
              <p className="mt-1 text-sm text-slate-500">Nothing left to call on this list right now. Retries come back here when they're due.</p>
              <div className="mt-3 flex justify-center">
                <ResultChips results={results} />
              </div>
              <Link to="/lists" className="btn-outline mt-4">
                Back to lists
              </Link>
            </section>
          ) : (
            <section aria-labelledby="next-h" className="card p-5">
              <h2 id="next-h" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Next up
              </h2>
              <div className="mt-3 flex items-center gap-4">
                <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-full bg-brand-50 text-lg font-semibold text-brand-700 dark:bg-slate-800 dark:text-brand-100">
                  {initials(c!.name, c!.phoneE164)}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-xl font-semibold">{label}</div>
                  <div className="truncate text-sm text-slate-500">{[c!.name ? c!.phoneE164 : null, c!.company, c!.city].filter(Boolean).join(" · ")}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {it.attempts > 0 && <Badge>Attempt {it.attempts + 1}</Badge>}
                    {it.lastOutcome && <OutcomeChip label={it.lastOutcome.label} color={it.lastOutcome.color} />}
                    {c!.dnc && <Badge tone="red">Do not call</Badge>}
                  </div>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {onThisCall ? (
                  <button type="button" className="btn-primary flex-1 py-3" onClick={dialer.openOutcome}>
                    Log outcome
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-call flex-1 py-3"
                    onClick={() => void dialer.call(c!.phoneE164, label, { callListItemId: it.id, listId: id, dncReason: c!.dnc?.reason ?? null, dnc: !!c!.dnc })}
                  >
                    Call now
                  </button>
                )}
                <button type="button" className="btn-outline" disabled={skip.isPending} onClick={() => skip.mutate(it.id)}>
                  {skip.isPending ? "Skipping…" : "Skip"}
                </button>
                <Link to={`/activity/contacts/${c!.id}`} className="btn-ghost">
                  Details
                </Link>
              </div>
              {skip.error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{skip.error.message}</p>}
              <p className="hint mt-4">Auto-advance: after you save the outcome, the next number is ready.</p>
            </section>
          )}
        </div>
        <ScriptPanel script={list?.script ?? null} />
      </div>
    </>
  );
}

function ScriptPanel({ script }: { script: ScriptDto | null }) {
  if (!script) return null;
  return (
    <aside aria-labelledby="script-h" className="card h-fit p-4">
      <h2 id="script-h" className="mb-3 font-semibold">
        Script · {script.name}
      </h2>
      <div className="space-y-3">
        {script.sections.map((s, i) => (
          <div key={i}>
            <div className="text-xs font-bold uppercase tracking-wide text-brand-700 dark:text-brand-100">{s.heading}</div>
            <p className="mt-1 whitespace-pre-line text-sm">{s.text}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
