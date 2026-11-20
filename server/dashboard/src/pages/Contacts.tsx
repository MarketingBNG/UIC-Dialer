import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { api, isManager, qs, type ContactFilter, type ContactFilterKey, type ContactListItem, type ContactPage, type ContactStatus, type User } from "../api";
import { useMe } from "../App";
import { CONTACT_STATUS_LABEL, formatShortWhen, isOverdue, personName } from "../format";
import { CallButton } from "../dialer";
import { ImportDialog, NewLeadDialog } from "../components/ContactDialogs";
import { FileUp, ListPlus, Search, UserPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { tabLinkClass, tabsListClass } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContactStatusBadge, Empty, ErrorBox, PageHeader, Spinner } from "../ui";
import type { NewListState } from "./Lists";

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Sub-navigation shared by the Activity Tracker pages. */
export function TrackerTabs() {
  const me = useMe();
  const [params] = useSearchParams();
  const due = params.get("due");
  const path = useLocation().pathname;
  const cls = (active: boolean) => tabLinkClass({ isActive: active });
  return (
    <nav aria-label="Activity tracker" className={`${tabsListClass} mb-4`}>
      <Link to="/activity" className={cls(path === "/activity" && !due)}>
        All contacts
      </Link>
      <Link to="/activity?due=today" className={cls(path === "/activity" && due === "today")}>
        Due today
      </Link>
      <Link to="/activity?due=overdue" className={cls(path === "/activity" && due === "overdue")}>
        Overdue follow-ups
      </Link>
      {isManager(me.role) && (
        <Link to="/team" className={cls(path === "/team")}>
          Per rep
        </Link>
      )}
    </nav>
  );
}

const FILTER_KEYS = ["q", "ownerId", "status", "due", "filter"] as const;
const CHIPS: [ContactFilterKey | "", string][] = [
  ["", "All"],
  ["interested", "Interested"],
  ["callback", "Call back"],
  ["never", "Never called"],
  ["mine", "Mine"],
];

export function ContactsPage() {
  const me = useMe();
  const manager = isManager(me.role);
  const [params, setParams] = useSearchParams();
  const get = (k: (typeof FILTER_KEYS)[number]) => params.get(k) ?? "";
  const [q, setQ] = useState(get("q"));
  const dq = useDebounced(q.trim(), 400);

  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );
  useEffect(() => set("q", dq), [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  // Re-sync the box when the URL's q changes from outside (tab links, back/forward).
  const urlQ = get("q");
  useEffect(() => {
    if (urlQ !== dq) setQ(urlQ);
  }, [urlQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const chip = get("filter") as ContactFilterKey | "";
  const filters = { q: get("q"), ownerId: manager ? get("ownerId") : "", status: get("status"), due: get("due"), filter: chip === "dnc" && !manager ? "" : chip };
  const activeCount = [filters.ownerId, filters.status, filters.due, filters.filter].filter(Boolean).length;
  const navigate = useNavigate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [newLead, setNewLead] = useState(false);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  /** The current filters as a call-list source (empty values dropped; "due" isn't a list filter). */
  const listFilter = (): ContactFilter => {
    const f: ContactFilter = {};
    if (filters.q) f.q = filters.q;
    if (filters.status) f.status = filters.status as ContactStatus;
    if (filters.filter) f.filter = filters.filter;
    if (filters.ownerId) f.ownerId = filters.ownerId;
    return f;
  };
  const toList = (state: NewListState) => navigate("/lists", { state: { newList: state } });
  // A new filter shows other rows: drop the selection so a list never includes contacts no longer on screen.
  const filterKey = JSON.stringify(filters);
  useEffect(() => setSelected(new Set()), [filterKey]);

  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users"), enabled: manager });
  const contacts = useInfiniteQuery({
    queryKey: ["contacts", filters],
    queryFn: ({ pageParam }) => api<ContactPage>(`/api/contacts${qs({ ...filters, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = contacts.data?.pages.flatMap((p) => p.items) ?? [];
  const loadMoreError = contacts.isFetchNextPageError ? contacts.error : null;
  const loadMore = () => void contacts.fetchNextPage();
  const now = Date.now();

  const clear = () => {
    setQ("");
    setParams(new URLSearchParams(), { replace: true });
  };

  const followUp = (iso: string | null) =>
    iso ? <span className={isOverdue(iso, now) ? "font-medium text-destructive" : ""}>{formatShortWhen(iso)}{isOverdue(iso, now) ? " · overdue" : ""}</span> : "—";

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle={filters.due === "overdue" ? "Follow-ups that are past due" : filters.due === "today" ? "Follow-ups due today (IST)" : "Every number your team has called, messaged or noted"}
        actions={
          <>
            <Button onClick={() => setNewLead(true)}>
              <UserPlus /> New lead
            </Button>
            {manager && (
              <Button variant="outline" onClick={() => setImporting(true)}>
                <FileUp /> Import CSV
              </Button>
            )}
            {manager && (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span keeps the tooltip working while the button is disabled */}
                  <span tabIndex={filters.due ? 0 : undefined}>
                    <Button variant="outline" disabled={!!filters.due} onClick={() => toList({ filter: listFilter() })}>
                      <ListPlus /> Call list from filters
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {filters.due ? "Clear the follow-up filter first: lists can't be built from due dates" : "Make a call list of everyone matching these filters"}
                </TooltipContent>
              </Tooltip>
            )}
          </>
        }
      />
      <TrackerTabs />
      <div role="group" aria-label="Quick filters" className="mb-3 flex flex-wrap gap-2">
        {[...CHIPS, ...(manager ? ([["dnc", "Do-not-call"]] as [ContactFilterKey, string][]) : [])].map(([v, l]) => (
          <Button
            key={v || "all"}
            size="sm"
            variant={filters.filter === v ? "default" : "outline"}
            aria-pressed={filters.filter === v}
            className="rounded-full"
            onClick={() => set("filter", v)}
          >
            {l}
          </Button>
        ))}
      </div>

      <Card className="mb-4 p-3 sm:p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <Label htmlFor="c-q">Search</Label>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="c-q" type="search" className="pl-9" placeholder="Name, number, company, notes" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          {manager && (
            <div>
              <Label htmlFor="c-owner">Owner</Label>
              <NativeSelect id="c-owner" value={get("ownerId")} onChange={(e) => set("ownerId", e.target.value)}>
                <option value="">Everyone</option>
                {users.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {personName(u)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div>
            <Label htmlFor="c-status">Status</Label>
            <NativeSelect id="c-status" value={get("status")} onChange={(e) => set("status", e.target.value)}>
              <option value="">Any status</option>
              {(Object.keys(CONTACT_STATUS_LABEL) as ContactStatus[]).map((s) => (
                <option key={s} value={s}>
                  {CONTACT_STATUS_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div>
            <Label htmlFor="c-due">Follow-up</Label>
            <NativeSelect id="c-due" value={get("due")} onChange={(e) => set("due", e.target.value)}>
              <option value="">Any time</option>
              <option value="today">Due today</option>
              <option value="overdue">Overdue</option>
            </NativeSelect>
          </div>
        </div>
        {(activeCount > 0 || filters.q) && (
          <Button variant="ghost" className="mt-2" onClick={clear}>
            <X /> Clear all filters
          </Button>
        )}
      </Card>

      {contacts.isPending ? (
        <Spinner label="Loading contacts" />
      ) : contacts.isError ? (
        <ErrorBox error={contacts.error} onRetry={() => void contacts.refetch()} />
      ) : items.length === 0 ? (
        <Empty>
          {filters.due === "overdue"
            ? "No overdue follow-ups."
            : activeCount || filters.q
              ? "No contacts match these filters. Try clearing them."
              : "No contacts yet. Add a lead, import a CSV, or call a number from the phone app: it appears here automatically."}
        </Empty>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((c) => (
              <li key={c.id}>
                <Link to={`/activity/contacts/${c.id}`} className="block rounded-xl border bg-card p-3 shadow-sm active:bg-muted">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{c.name || c.phoneE164}</div>
                      <div className="truncate text-sm text-muted-foreground">{[c.name ? c.phoneE164 : null, c.company, c.city].filter(Boolean).join(" · ")}</div>
                    </div>
                    <RowLabel c={c} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    {c.nextFollowUpAt && <span>Follow up {followUp(c.nextFollowUpAt)}</span>}
                    {c.lastActivityAt && <span>Last {formatShortWhen(c.lastActivityAt)}</span>}
                    {c.owner && <span className="truncate">{personName(c.owner)}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <Card className="hidden overflow-hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  {manager && (
                    <TableHead scope="col" className="w-10">
                      <Checkbox
                        aria-label="Select all shown"
                        checked={items.length > 0 && items.every((c) => selected.has(c.id))}
                        onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((c) => c.id)) : new Set())}
                      />
                    </TableHead>
                  )}
                  {["Phone", "Name", "Company", "City", "Owner", "Status", "Last activity", "Next follow-up", ""].map((h, i) => (
                    <TableHead key={i} scope="col">
                      {h || <span className="sr-only">Call</span>}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id}>
                    {manager && (
                      <TableCell>
                        <Checkbox aria-label={`Select ${c.name || c.phoneE164}`} checked={selected.has(c.id)} onCheckedChange={(v) => toggle(c.id, v === true)} />
                      </TableCell>
                    )}
                    <TableCell className="whitespace-nowrap">
                      <Link to={`/activity/contacts/${c.id}`} className="font-medium text-primary hover:underline">
                        {c.phoneE164}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-48 truncate">{c.name || "—"}</TableCell>
                    <TableCell className="max-w-48 truncate">{c.company || "—"}</TableCell>
                    <TableCell className="max-w-32 truncate">{c.city || "—"}</TableCell>
                    <TableCell className="max-w-40 truncate">{c.owner ? personName(c.owner) : "—"}</TableCell>
                    <TableCell>
                      <RowLabel c={c} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{c.lastActivityAt ? formatShortWhen(c.lastActivityAt) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{followUp(c.nextFollowUpAt)}</TableCell>
                    <TableCell className="py-1.5 text-right">
                      <CallButton phone={c.phoneE164} label={c.name || c.phoneE164} dncReason={c.dnc?.reason} dnc={!!c.dnc} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <div className="mt-4 flex justify-center">
            {contacts.hasNextPage ? (
              <Button variant="outline" disabled={contacts.isFetchingNextPage} onClick={loadMore}>
                {contacts.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {items.length} contact{items.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
          {loadMoreError && <ErrorBox error={loadMoreError} onRetry={loadMore} />}
        </>
      )}
      {manager && selected.size > 0 && (
        <div role="region" aria-label="Selection" className="sticky bottom-3 z-20 mx-auto mt-4 flex max-w-xl flex-wrap items-center gap-2 rounded-2xl bg-navy p-3 text-sm text-white shadow-lg">
          <span className="mr-auto">{selected.size} selected</span>
          <Button className="bg-white text-navy hover:bg-slate-100" onClick={() => toList({ contactIds: [...selected] })}>
            <ListPlus /> Create call list from selected
          </Button>
          <Button variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} onList={(ids) => toList({ contactIds: ids })} />}
      {newLead && <NewLeadDialog onClose={() => setNewLead(false)} />}
    </>
  );
}

/** One label per row: do-not-call wins over the status (the source is shown only on the contact page). */
function RowLabel({ c }: { c: ContactListItem }) {
  if (c.dnc)
    return (
      <Badge variant="red" title={c.dnc.reason ?? "Do not call"}>
        Do not call
      </Badge>
    );
  return <ContactStatusBadge status={c.status} />;
}
