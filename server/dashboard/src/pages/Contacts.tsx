import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { api, isManager, qs, type ContactFilter, type ContactFilterKey, type ContactListItem, type ContactPage, type ContactStatus, type User } from "../api";
import { useMe } from "../App";
import { CONTACT_STATUS_LABEL, formatShortWhen, isOverdue, personName } from "../format";
import { CallButton } from "../dialer";
import { ImportDialog, NewLeadDialog } from "../components/ContactDialogs";
import { Badge, ContactStatusBadge, Empty, ErrorBox, PageHeader, Spinner } from "../ui";
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
  const cls = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${
      active ? "bg-brand-600 text-white" : "border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
    }`;
  return (
    <nav aria-label="Activity tracker" className="mb-4 flex flex-wrap gap-2">
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
    iso ? <span className={isOverdue(iso, now) ? "font-medium text-red-600 dark:text-red-400" : ""}>{formatShortWhen(iso)}{isOverdue(iso, now) ? " · overdue" : ""}</span> : "—";

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle={filters.due === "overdue" ? "Follow-ups that are past due" : filters.due === "today" ? "Follow-ups due today (IST)" : "Every number your team has called, messaged or noted"}
        actions={
          <>
            <button type="button" className="btn-outline" onClick={() => setNewLead(true)}>
              New lead
            </button>
            {manager && (
              <button type="button" className="btn-outline" onClick={() => setImporting(true)}>
                Import CSV
              </button>
            )}
            {manager && (
              <button
                type="button"
                className="btn-outline"
                disabled={!!filters.due}
                title={filters.due ? "Clear the follow-up filter first: lists can't be built from due dates" : "Make a call list of everyone matching these filters"}
                onClick={() => toList({ filter: listFilter() })}
              >
                List from filter
              </button>
            )}
          </>
        }
      />
      <TrackerTabs />
      <div role="group" aria-label="Quick filters" className="mb-3 flex flex-wrap gap-2">
        {[...CHIPS, ...(manager ? ([["dnc", "Do-not-call"]] as [ContactFilterKey, string][]) : [])].map(([v, l]) => (
          <button
            key={v || "all"}
            type="button"
            aria-pressed={filters.filter === v}
            className={`min-h-9 rounded-full px-3 text-sm font-medium ${
              filters.filter === v
                ? "bg-navy text-white"
                : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            }`}
            onClick={() => set("filter", v)}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="card mb-4 p-3 sm:p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <label className="label" htmlFor="c-q">
              Search
            </label>
            <input id="c-q" type="search" className="input" placeholder="Search name, number, company, notes" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {manager && (
            <div>
              <label className="label" htmlFor="c-owner">
                Owner
              </label>
              <select id="c-owner" className="input" value={get("ownerId")} onChange={(e) => set("ownerId", e.target.value)}>
                <option value="">Everyone</option>
                {users.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {personName(u)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="c-status">
              Status
            </label>
            <select id="c-status" className="input" value={get("status")} onChange={(e) => set("status", e.target.value)}>
              <option value="">Any status</option>
              {(Object.keys(CONTACT_STATUS_LABEL) as ContactStatus[]).map((s) => (
                <option key={s} value={s}>
                  {CONTACT_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="c-due">
              Follow-up
            </label>
            <select id="c-due" className="input" value={get("due")} onChange={(e) => set("due", e.target.value)}>
              <option value="">Any time</option>
              <option value="today">Due today</option>
              <option value="overdue">Overdue</option>
            </select>
          </div>
        </div>
        {(activeCount > 0 || filters.q) && (
          <button type="button" className="btn-ghost mt-2" onClick={clear}>
            Clear all
          </button>
        )}
      </div>

      {contacts.isPending ? (
        <Spinner label="Loading contacts" />
      ) : contacts.isError ? (
        <ErrorBox error={contacts.error} onRetry={() => void contacts.refetch()} />
      ) : items.length === 0 ? (
        <Empty>
          {filters.due === "overdue"
            ? "No overdue follow-ups."
            : activeCount || filters.q
              ? "No contacts match these filters."
              : "No contacts yet. A number appears here the first time a rep calls, messages or notes it in the app."}
        </Empty>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((c) => (
              <li key={c.id}>
                <Link to={`/activity/contacts/${c.id}`} className="card block p-3 active:bg-slate-50 dark:active:bg-slate-800">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{c.name || c.phoneE164}</div>
                      <div className="truncate text-sm text-slate-500">{[c.name ? c.phoneE164 : null, c.company, c.city].filter(Boolean).join(" · ")}</div>
                    </div>
                    <RowLabel c={c} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
                    {c.nextFollowUpAt && <span>Follow up {followUp(c.nextFollowUpAt)}</span>}
                    {c.lastActivityAt && <span>Last {formatShortWhen(c.lastActivityAt)}</span>}
                    {c.owner && <span className="truncate">{personName(c.owner)}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          <div className="card hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <tr>
                  {manager && (
                    <th scope="col" className="w-8 px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label="Select all shown"
                        className="size-4 accent-brand-600"
                        checked={items.length > 0 && items.every((c) => selected.has(c.id))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(items.map((c) => c.id)) : new Set())}
                      />
                    </th>
                  )}
                  {["Phone", "Name", "Company", "City", "Owner", "Status", "Last activity", "Next follow-up", ""].map((h, i) => (
                    <th key={i} scope="col" className="px-4 py-3 font-medium">
                      {h || <span className="sr-only">Call</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {items.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    {manager && (
                      <td className="px-3 py-3">
                        <input type="checkbox" aria-label={`Select ${c.name || c.phoneE164}`} className="size-4 accent-brand-600" checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                      </td>
                    )}
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link to={`/activity/contacts/${c.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                        {c.phoneE164}
                      </Link>
                    </td>
                    <td className="max-w-48 truncate px-4 py-3">{c.name || "—"}</td>
                    <td className="max-w-48 truncate px-4 py-3">{c.company || "—"}</td>
                    <td className="max-w-32 truncate px-4 py-3">{c.city || "—"}</td>
                    <td className="max-w-40 truncate px-4 py-3">{c.owner ? personName(c.owner) : "—"}</td>
                    <td className="px-4 py-3">
                      <RowLabel c={c} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">{c.lastActivityAt ? formatShortWhen(c.lastActivityAt) : "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3">{followUp(c.nextFollowUpAt)}</td>
                    <td className="px-4 py-2 text-right">
                      <CallButton phone={c.phoneE164} label={c.name || c.phoneE164} className="btn-ghost" dncReason={c.dnc?.reason} dnc={!!c.dnc} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex justify-center">
            {contacts.hasNextPage ? (
              <button type="button" className="btn-outline" disabled={contacts.isFetchingNextPage} onClick={loadMore}>
                {contacts.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            ) : (
              <p className="text-xs text-slate-500">
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
          <button type="button" className="btn bg-white text-navy hover:bg-slate-100" onClick={() => toList({ contactIds: [...selected] })}>
            Create call list from selected
          </button>
          <button type="button" className="btn text-white hover:bg-white/10" onClick={() => setSelected(new Set())}>
            Clear
          </button>
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
      <span title={c.dnc.reason ?? "Do not call"}>
        <Badge tone="red">Do not call</Badge>
      </span>
    );
  return <ContactStatusBadge status={c.status} />;
}
