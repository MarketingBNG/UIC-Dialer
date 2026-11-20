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
import { ArrowLeft, ListChecks, MoreHorizontal, Pause, Pencil, Phone, PhoneCall, Play, Plus, RotateCcw, SkipForward, Trash2, Archive, UserRound } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, ErrorBox, FormError, Hint, PageHeader, Spinner } from "../ui";

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
      <div className="mb-1 text-xs tabular-nums text-muted-foreground">{progressText(p)}</div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={w} aria-valuemin={0} aria-valuemax={100} aria-label={`${progressText(p)} done`}>
        <div className="h-full rounded-full bg-primary" style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

export function ResultChips({ results }: { results: ListResult[] }) {
  if (!results.length) return <span className="text-xs text-muted-foreground">No outcomes yet</span>;
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
            <Button onClick={() => setCreating({})}>
              <Plus /> New call list
            </Button>
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
  if (q.data.items.length === 0) return alwaysShow ? <Empty icon={<ListChecks />}>No call lists assigned to you right now. When your manager gives you one, it shows up here.</Empty> : null;
  return (
    <section aria-labelledby="my-lists-h" className="mb-6">
      <h2 id="my-lists-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        My lists · {q.data.items.length}
      </h2>
      <div role="list" className="grid gap-3 md:grid-cols-2">
        {q.data.items.map((l) => (
          <Card key={l.id} className="flex flex-col gap-3 p-4" role="listitem">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-semibold">{l.name}</div>
                <div className="text-xs text-muted-foreground">
                  {l.createdBy ? `Assigned by ${personName(l.createdBy)}` : "Call list"}
                  {l.script ? ` · script: ${l.script.name}` : ""}
                </div>
              </div>
              {l.state !== "ACTIVE" && <Badge variant={STATE_TONE[l.state]}>{STATE_LABEL[l.state]}</Badge>}
            </div>
            <ProgressBar p={l.progress} />
            <ResultChips results={l.results} />
            <div className="flex gap-2">
              <Button asChild variant="call" className={l.state !== "ACTIVE" ? "pointer-events-none opacity-50" : ""}>
                <Link to={`/lists/${l.id}/work`} aria-disabled={l.state !== "ACTIVE"}>
                  <PhoneCall /> {l.progress.inProgress ? "Continue" : "Start calling"}
                </Link>
              </Button>
              <Button asChild variant="ghost">
                <Link to={`/lists/${l.id}`}>See numbers</Link>
              </Button>
            </div>
          </Card>
        ))}
      </div>
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
        <h2 id="all-lists-h" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          All lists
        </h2>
        <div>
          <Label className="sr-only" htmlFor="lists-state">
            Show
          </Label>
          <NativeSelect id="lists-state" value={state} onChange={(e) => setState(e.target.value as CallListState | "")}>
            <option value="">Active and paused</option>
            <option value="ACTIVE">Active</option>
            <option value="PAUSED">Paused</option>
            <option value="ARCHIVED">Archived</option>
          </NativeSelect>
        </div>
      </div>
      {q.isPending ? (
        <Spinner label="Loading call lists" />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <Empty icon={<ListChecks />}>No call lists yet. Press New call list, or pick contacts on the Contacts page and choose Create call list.</Empty>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                {["Name", "Assigned to", "Script", "Progress", "Results"].map((h) => (
                  <TableHead key={h} scope="col">
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.items.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <Link to={`/lists/${l.id}`} className="font-medium text-primary hover:underline">
                      {l.name}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {l.state !== "ACTIVE" && <Badge variant={STATE_TONE[l.state]}>{STATE_LABEL[l.state]}</Badge>}
                      {formatShortWhen(l.createdAt)}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-48">{l.assignees.map(personName).join(", ") || "—"}</TableCell>
                  <TableCell className="max-w-40 truncate">{l.script?.name ?? "—"}</TableCell>
                  <TableCell>
                    <ProgressBar p={l.progress} />
                  </TableCell>
                  <TableCell>
                    <ResultChips results={l.results} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
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
    <div
      className={`flex min-h-11 items-center gap-3 rounded-lg border p-2 text-sm has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-secondary ${disabled ? "opacity-50" : ""}`}
    >
      <RadioGroupItem id={`ls-${v}`} value={v} disabled={disabled} />
      <Label htmlFor={`ls-${v}`} className={`mb-0 flex-1 font-normal ${disabled ? "" : "cursor-pointer"}`}>
        {label}
      </Label>
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && !create.isPending && onClose()}>
      <DialogContent className="w-[min(36rem,calc(100vw-2rem))]">
      <DialogHeader>
        <DialogTitle>New call list</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div>
          <Label htmlFor="nl-name">
            Name
          </Label>
          <Input id="nl-name" maxLength={120} placeholder="Pune dealers, November" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium text-slate-700">Numbers</legend>
          <RadioGroup value={source} onValueChange={(v) => setSource(v as Source)} aria-label="Where the numbers come from">
          {/* Only offered when the Contacts page passed its filter: an empty filter would list everyone in scope. */}
          {initial.filter && radio("filter", `Contacts filter: ${filterText(filter)}`)}
          {radio("ids", initial.contactIds?.length ? `${initial.contactIds.length} selected contacts` : "Selected contacts (pick them on the Contacts page)", !initial.contactIds?.length)}
          {radio("csv", "Upload a CSV")}
          </RadioGroup>
        </fieldset>
        {source === "csv" && <CsvImportView state={csv} />}
        {source === "csv" && csv.preview.data && listableCount(csv.preview.data) === 0 && (
          <p className="text-sm text-amber-700">No number in this file can go on a list (do-not-call, another team&apos;s, or bad).</p>
        )}
        <Hint>Do-not-call numbers are left out automatically.</Hint>
        <UserMultiSelect label="Assign to" users={users.items} value={assignees} onChange={setAssignees} />
        <div>
          <Label htmlFor="nl-script">
            Script (optional)
          </Label>
          <NativeSelect id="nl-script" value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
            <option value="">No script</option>
            {scripts.data?.items
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </NativeSelect>
        </div>
        <FormError error={create.error ?? csv.run.error} />
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={create.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!ok || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create list"}
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
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
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground">
        <Link to="/lists">
          <ArrowLeft /> Call lists
        </Link>
      </Button>
      <PageHeader
        title={list.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={STATE_TONE[list.state]}>{STATE_LABEL[list.state]}</Badge>
            <span>Assigned to {list.assignees.map(personName).join(", ") || "nobody"}</span>
            {list.script && <span>· script: {list.script.name}</span>}
          </span>
        }
        actions={
          <>
            {assigned && list.state === "ACTIVE" && (
              <Button asChild variant="call">
                <Link to={`/lists/${id}/work`}>
                  <PhoneCall /> Start calling
                </Link>
              </Button>
            )}
            {manager && (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
                {list.state === "ACTIVE" && (
                  <Button variant="outline" disabled={patch.isPending} onClick={() => patch.mutate({ state: "PAUSED" })}>
                    <Pause /> Pause
                  </Button>
                )}
                {list.state !== "ACTIVE" && (
                  <Button variant="outline" disabled={patch.isPending} onClick={() => patch.mutate({ state: "ACTIVE" })}>
                    <Play /> {list.state === "ARCHIVED" ? "Restore" : "Resume"}
                  </Button>
                )}
                {list.state !== "ARCHIVED" && (
                  <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirm({ kind: "archive" })}>
                    <Archive /> Archive
                  </Button>
                )}
              </>
            )}
          </>
        }
      />
      {patch.error && <ErrorBox error={patch.error} />}
      <Card className="mb-4 flex flex-row flex-wrap items-center gap-4 p-4">
        <div className="w-full max-w-sm">
          <ProgressBar p={list.progress} />
        </div>
        <div className="text-sm text-muted-foreground">
          {list.progress.pending} waiting · {list.progress.inProgress} being called · {list.progress.skipped} skipped · {list.progress.removed} removed
        </div>
        <ResultChips results={list.results} />
      </Card>
      <div className="mb-3 max-w-xs">
        <Label className="sr-only" htmlFor="ld-state">
          Show
        </Label>
        <NativeSelect id="ld-state" value={state} onChange={(e) => setState(e.target.value as CallListItemState | "")}>
          <option value="">All numbers</option>
          {(Object.keys(ITEM_LABEL) as CallListItemState[]).map((s) => (
            <option key={s} value={s}>
              {ITEM_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {items.length === 0 ? (
        <Empty>No numbers in this view. Pick another filter above to see the rest of the list.</Empty>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                {["#", "Contact", "State", "Last outcome", "Who", "When", ""].map((h, i) => (
                  <TableHead key={i} scope="col">
                    {h || <span className="sr-only">Actions</span>}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => {
                const who = it.doneBy ?? it.claimedBy;
                const label = it.contact.name || it.contact.phoneE164;
                return (
                  <TableRow key={it.id}>
                    <TableCell className="tabular-nums text-muted-foreground">{it.position + 1}</TableCell>
                    <TableCell>
                      <Link to={`/activity/contacts/${it.contact.id}`} className="font-medium hover:underline">
                        {label}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {[it.contact.name ? it.contact.phoneE164 : null, it.contact.company, it.contact.city].filter(Boolean).join(" · ")}
                        {it.contact.dnc && (
                          <span className="ml-1">
                            <Badge variant="red">DNC</Badge>
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={ITEM_TONE[it.state]}>{ITEM_LABEL[it.state]}</Badge>
                      {it.retryAt && it.state === "PENDING" && <div className="text-xs text-muted-foreground">retry {formatShortWhen(it.retryAt)}</div>}
                      {it.attempts > 1 && <div className="text-xs text-muted-foreground">{it.attempts} attempts</div>}
                    </TableCell>
                    <TableCell>{it.lastOutcome ? <OutcomeChip label={it.lastOutcome.label} color={it.lastOutcome.color} /> : "—"}</TableCell>
                    <TableCell className="max-w-36 truncate">{who ? personName(who) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{it.lastActivityAt ? formatShortWhen(it.lastActivityAt) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap py-1 text-right">
                      {manager && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Actions for ${label}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            {it.state !== "PENDING" && (
                              <DropdownMenuItem disabled={itemAction.isPending} onSelect={() => itemAction.mutate({ itemId: it.id, action: "reset" })}>
                                <RotateCcw /> Put back in the queue
                              </DropdownMenuItem>
                            )}
                            {it.state !== "REMOVED" && (
                              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm({ kind: "remove", itemId: it.id, label })}>
                                <Trash2 /> Remove from list
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      {detail.hasNextPage && (
        <Button variant="outline" className="mt-4 w-full" disabled={detail.isFetchingNextPage} onClick={() => void detail.fetchNextPage()}>
          {detail.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
      {itemAction.error && !confirm && <ErrorBox error={itemAction.error} />}
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && !(patch.isPending || itemAction.isPending) && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "archive" ? "Archive this list?" : "Remove this number?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "archive" ? "Reps stop seeing it. You can restore it from the archived lists." : `${confirm?.kind === "remove" ? confirm.label : ""} is taken off this list.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormError error={confirm?.kind === "archive" ? patch.error : itemAction.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={patch.isPending || itemAction.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={patch.isPending || itemAction.isPending}
              onClick={(e) => {
                // Keep the dialog open until the request finishes (it closes on success).
                e.preventDefault();
                if (confirm?.kind === "archive") patch.mutate({ state: "ARCHIVED" });
                else if (confirm?.kind === "remove") itemAction.mutate({ itemId: confirm.itemId, action: "remove" });
              }}
            >
              {patch.isPending || itemAction.isPending ? "Working…" : confirm?.kind === "archive" ? "Archive" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
      <DialogHeader>
        <DialogTitle>Edit call list</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label htmlFor="el-name">
            Name
          </Label>
          <Input id="el-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <UserMultiSelect label="Assign to" users={pickable} value={assignees} onChange={setAssignees} />
        <div>
          <Label htmlFor="el-script">
            Script
          </Label>
          <NativeSelect id="el-script" value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
            <option value="">No script</option>
            {scripts.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <FormError error={save.error} />
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!name.trim() || !assignees.length || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>
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
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground">
        <Link to="/lists">
          <ArrowLeft /> Call lists
        </Link>
      </Button>
      <PageHeader
        title={list?.name ?? "Call list"}
        subtitle={list?.createdBy ? `Call list · assigned by ${personName(list.createdBy)}` : "Call list"}
        actions={
          <Button variant="outline" disabled={pause.isPending} onClick={() => pause.mutate()}>
            <Pause /> {pause.isPending ? "Pausing…" : "Pause"}
          </Button>
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
          <Card className="flex flex-row flex-wrap items-center gap-4 p-4">
            <div className="w-full max-w-xs">
              <ProgressBar p={r.progress} />
            </div>
            <div className="text-sm text-muted-foreground">
              {[interested != null ? `${interested} interested` : null, callBack != null ? `${callBack} call back` : null].filter(Boolean).join(" · ")}
            </div>
          </Card>

          {!it ? (
            <Card className="p-6 text-center">
            <section>
              <h2 className="text-lg font-semibold">All done</h2>
              <p className="mt-1 text-sm text-muted-foreground">Nothing left to call on this list right now. Retries come back here when they're due.</p>
              <div className="mt-3 flex justify-center">
                <ResultChips results={results} />
              </div>
              <Button asChild variant="outline" className="mt-4">
                <Link to="/lists">Back to lists</Link>
              </Button>
            </section>
            </Card>
          ) : (
            <Card className="border-primary/30 p-5 shadow-md">
            <section aria-labelledby="next-h">
              <h2 id="next-h" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Next up
              </h2>
              <div className="mt-3 flex items-center gap-4">
                <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-full bg-secondary text-lg font-semibold text-primary">
                  {initials(c!.name, c!.phoneE164)}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-xl font-semibold">{label}</div>
                  <div className="truncate text-sm text-muted-foreground">{[c!.name ? c!.phoneE164 : null, c!.company, c!.city].filter(Boolean).join(" · ")}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {it.attempts > 0 && <Badge variant="gray">Attempt {it.attempts + 1}</Badge>}
                    {it.lastOutcome && <OutcomeChip label={it.lastOutcome.label} color={it.lastOutcome.color} />}
                    {c!.dnc && <Badge variant="red">Do not call</Badge>}
                  </div>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {onThisCall ? (
                  <Button size="lg" className="flex-1" onClick={dialer.openOutcome}>
                    <ListChecks /> Log outcome
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    variant="call"
                    className="flex-1"
                    onClick={() => void dialer.call(c!.phoneE164, label, { callListItemId: it.id, listId: id, dncReason: c!.dnc?.reason ?? null, dnc: !!c!.dnc })}
                  >
                    <Phone /> Call now
                  </Button>
                )}
                <Button size="lg" variant="outline" disabled={skip.isPending} onClick={() => skip.mutate(it.id)}>
                  <SkipForward /> {skip.isPending ? "Skipping…" : "Skip"}
                </Button>
                <Button asChild size="lg" variant="ghost">
                  <Link to={`/activity/contacts/${c!.id}`}>
                    <UserRound /> Details
                  </Link>
                </Button>
              </div>
              {skip.error && <FormError error={skip.error} />}
              <Hint className="mt-4">Auto-advance: after you save the outcome, the next number is ready.</Hint>
            </section>
            </Card>
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
    <Card className="h-fit p-4">
    <aside aria-labelledby="script-h">
      <h2 id="script-h" className="mb-3 font-semibold">
        Script · {script.name}
      </h2>
      <div className="space-y-3">
        {script.sections.map((s, i) => (
          <div key={i}>
            <div className="text-xs font-bold uppercase tracking-wide text-primary">{s.heading}</div>
            <p className="mt-1 whitespace-pre-line text-sm">{s.text}</p>
          </div>
        ))}
      </div>
    </aside>
    </Card>
  );
}
