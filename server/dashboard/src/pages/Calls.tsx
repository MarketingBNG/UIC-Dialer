import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, isManager, qs, type CallItem, type CallPage, type CallStatus, type Direction, type User } from "../api";
import { useMe } from "../App";
import { DIRECTION_LABEL, STATUS_LABEL, formatDuration, formatShortWhen, fromLabel, personName } from "../format";
import { Download, PhoneCall, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DirectionTag, Empty, ErrorBox, PageHeader, ScorePill, Spinner, StatusBadge, TalkTag, ViaTag } from "../ui";

const FILTER_KEYS = ["q", "phone", "userId", "ownerId", "direction", "status", "tag", "from", "to"] as const;

/** yyyy-mm-dd from a date input, read in the viewer's time zone. */
function dayBoundary(day: string, end: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CallsPage() {
  const me = useMe();
  const manager = isManager(me.role);
  // Filters live in the URL so Back from a call returns to the same list.
  const [params, setParams] = useSearchParams();
  const get = (k: (typeof FILTER_KEYS)[number]) => params.get(k) ?? "";
  const [q, setQ] = useState(get("q"));
  const [phone, setPhone] = useState(get("phone"));
  const dq = useDebounced(q.trim(), 400);
  const dphone = useDebounced(phone.trim(), 400);
  const [showFilters, setShowFilters] = useState(() => FILTER_KEYS.some((k) => k !== "q" && params.get(k)));

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
  useEffect(() => set("phone", dphone), [dphone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Like the Android app: a number-like search (3+ chars) searches by phone, not transcript.
  const search = get("q").trim();
  const isPhone = search.length >= 3 && /^[+\d][\d\s()\-]*$/.test(search);
  const filters = {
    q: isPhone ? "" : search,
    phone: isPhone ? search.replace(/[^\d+]/g, "") : get("phone"),
    userId: manager ? get("userId") : "",
    ownerId: manager ? get("ownerId") : "",
    direction: get("direction"),
    status: get("status"),
    tag: get("tag"),
    from: dayBoundary(get("from"), false),
    to: dayBoundary(get("to"), true),
    // Include call-log-only calls (no recording).
    v: "2",
  };
  const activeCount = [filters.phone, filters.userId, filters.ownerId, filters.direction, filters.status, filters.tag, get("from"), get("to")].filter(Boolean).length;

  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users"), enabled: manager });

  const calls = useInfiniteQuery({
    queryKey: ["calls", filters],
    queryFn: ({ pageParam }) => api<CallPage>(`/api/calls${qs({ ...filters, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = calls.data?.pages.flatMap((p) => p.items) ?? [];
  // The score column appears once any listed call has an AI score.
  const hasScores = items.some((c) => c.score != null);
  const loadMoreError = calls.isFetchNextPageError ? calls.error : null;
  const loadMore = () => void calls.fetchNextPage();

  const clear = () => {
    setQ("");
    setPhone("");
    setParams(new URLSearchParams(), { replace: true });
  };

  return (
    <>
      <PageHeader title="Calls" subtitle={me.role === "ADMIN" ? "All calls" : me.role === "MANAGER" && me.team ? `Calls from team ${me.team}` : "Your calls"} />

      <Card className="mb-4 p-3 sm:p-4">
        <div className="flex flex-wrap gap-2">
          <Label className="sr-only" htmlFor="q">
            Search transcripts or phone
          </Label>
          <div className="relative min-w-48 flex-1">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input id="q" type="search" className="min-h-11 pl-9" placeholder="Search transcripts or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Button variant="outline" className="min-h-11 shrink-0" aria-expanded={showFilters} aria-controls="filters" onClick={() => setShowFilters((s) => !s)}>
            <SlidersHorizontal /> Filters{activeCount ? ` (${activeCount})` : ""}
          </Button>
          {manager && (
            // Same filters as the list; the server caps the file at 10,000 calls and audit-logs the export.
            <Button asChild variant="outline" className="min-h-11 shrink-0">
              <a href={`/api/calls/export${qs(filters)}`} download>
                <Download /> Export CSV
              </a>
            </Button>
          )}
        </div>
        {showFilters && (
          <div id="filters" className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label htmlFor="f-phone">Phone number</Label>
              <Input id="f-phone" inputMode="tel" placeholder="Any part of the number" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            {manager && (
              <div>
                <Label htmlFor="f-owner">Lead owner</Label>
                <NativeSelect id="f-owner" value={get("ownerId")} onChange={(e) => set("ownerId", e.target.value)}>
                  <option value="">Any owner</option>
                  {users.data?.map((u) => (
                    <option key={u.id} value={u.id}>
                      {personName(u)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            {manager && (
              <div>
                <Label htmlFor="f-user">Person</Label>
                <NativeSelect id="f-user" value={get("userId")} onChange={(e) => set("userId", e.target.value)}>
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
              <Label htmlFor="f-dir">Direction</Label>
              <NativeSelect id="f-dir" value={get("direction")} onChange={(e) => set("direction", e.target.value)}>
                <option value="">All directions</option>
                {(Object.keys(DIRECTION_LABEL) as Direction[]).map((d) => (
                  <option key={d} value={d}>
                    {DIRECTION_LABEL[d]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="f-status">Status</Label>
              <NativeSelect id="f-status" value={get("status")} onChange={(e) => set("status", e.target.value)}>
                <option value="">Any status</option>
                {(Object.keys(STATUS_LABEL) as CallStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="f-tag">Talk</Label>
              <NativeSelect id="f-tag" value={get("tag")} onChange={(e) => set("tag", e.target.value)}>
                <option value="">All calls</option>
                <option value="ANY">Voicemail or no talk</option>
                <option value="VOICEMAIL">Voicemail</option>
                <option value="NO_SPEECH">No talk</option>
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor="f-from">From</Label>
              <Input id="f-from" type="date" value={get("from")} max={get("to") || undefined} onChange={(e) => set("from", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="f-to">To</Label>
              <Input id="f-to" type="date" value={get("to")} min={get("from") || undefined} onChange={(e) => set("to", e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button variant="ghost" className="min-h-11" onClick={clear}>
                <X /> Clear all
              </Button>
            </div>
          </div>
        )}
      </Card>

      {calls.isPending ? (
        <Spinner label="Loading calls" />
      ) : calls.isError ? (
        <ErrorBox error={calls.error} onRetry={() => void calls.refetch()} />
      ) : items.length === 0 ? (
        activeCount || filters.q ? (
          <Empty
            icon={<Search />}
            action={
              <Button variant="outline" className="min-h-11" onClick={clear}>
                <X /> Clear filters
              </Button>
            }
          >
            No calls match these filters. Try a wider date range or clear the filters.
          </Empty>
        ) : (
          <Empty icon={<PhoneCall />}>No calls yet. Make a call from Today; it shows up here once the phone app uploads the recording.</Empty>
        )
      ) : (
        <>
          {/* Phones: one card per call */}
          <ul className="space-y-2 md:hidden">
            {items.map((c) => (
              <li key={c.id}>
                <Link to={`/calls/${c.id}`} className="block rounded-xl border bg-card p-3 shadow-sm active:bg-muted">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{leadName(c) || c.phoneE164 || c.phoneRaw || "Unknown number"}</div>
                      {leadName(c) && <div className="truncate text-sm text-muted-foreground">{c.phoneE164 || c.phoneRaw}</div>}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusBadge status={c.status} logType={c.logType} direction={c.direction} durationS={c.durationS} />
                      <TalkTag tag={c.transcript?.tag} />
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    <DirectionTag direction={c.direction} />
                    <ViaTag via={c.via} />
                    <span>{formatShortWhen(c.startedAt)}</span>
                    <span>{formatDuration(c.durationS)}</span>
                    {manager && <span className="truncate">{personName(c.user)}</span>}
                    {c.lead?.owner && <span className="truncate">Owner: {personName(c.lead.owner)}</span>}
                    {fromLabel(c) && <span className="truncate">{fromLabel(c)}</span>}
                    {c.score != null && <ScorePill score={c.score} />}
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* Larger screens: table */}
          <Card className="hidden overflow-hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Contact</TableHead>
                  <TableHead scope="col">Direction</TableHead>
                  <TableHead scope="col">When</TableHead>
                  <TableHead scope="col" className="text-right">
                    Duration
                  </TableHead>
                  {manager && <TableHead scope="col">Person</TableHead>}
                  <TableHead scope="col">Lead owner</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  {hasScores && (
                    <TableHead scope="col" className="text-right">
                      Score
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link to={`/calls/${c.id}`} className="font-medium text-primary hover:underline">
                        {leadName(c) || c.phoneE164 || c.phoneRaw || "Unknown number"}
                      </Link>
                      {leadName(c) && <div className="text-xs text-muted-foreground">{[c.lead?.company, c.phoneE164 || c.phoneRaw].filter(Boolean).join(" · ")}</div>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <DirectionTag direction={c.direction} />
                        <ViaTag via={c.via} />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatShortWhen(c.startedAt)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatDuration(c.durationS)}</TableCell>
                    {manager && (
                      <TableCell className="max-w-48">
                        <div className="truncate">{personName(c.user)}</div>
                        {fromLabel(c) && <div className="truncate text-xs text-muted-foreground">{fromLabel(c)}</div>}
                      </TableCell>
                    )}
                    <TableCell className="max-w-40">
                      <div className="truncate">{c.lead?.owner ? personName(c.lead.owner) : "—"}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <StatusBadge status={c.status} logType={c.logType} direction={c.direction} durationS={c.durationS} />
                        <TalkTag tag={c.transcript?.tag} />
                      </div>
                    </TableCell>
                    {hasScores && <TableCell className="text-right tabular-nums">{c.score != null ? <ScorePill score={c.score} /> : "—"}</TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <div className="mt-4 flex justify-center">
            {calls.hasNextPage ? (
              <Button variant="outline" className="min-h-11" disabled={calls.isFetchingNextPage} onClick={loadMore}>
                {calls.isFetchingNextPage ? "Loading…" : "Load more calls"}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {items.length} call{items.length === 1 ? "" : "s"}
              </p>
            )}
          </div>
          {loadMoreError && <ErrorBox error={loadMoreError} onRetry={loadMore} />}
        </>
      )}
    </>
  );
}

/** The lead's name from Contacts, else the name saved on the phone. */
function leadName(c: CallItem): string | null {
  return c.lead?.name || c.contactName || null;
}
