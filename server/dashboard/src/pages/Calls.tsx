import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api, isManager, qs, type CallItem, type CallPage, type CallStatus, type Direction, type User } from "../api";
import { useMe } from "../App";
import { STATUS_LABEL, formatDuration, fromLabel, istDay, istDayBoundary, personName } from "../format";
import { callRowStatusText, callStatusText } from "../callStatus";
import { ArrowDownLeft, ArrowUpRight, CloudUpload, Download, FileText, FileX, Loader, PhoneCall, PhoneMissed, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Empty, ErrorBox, PageHeader, Pill, ScorePill, Spinner, TalkTag, ViaTag } from "../ui";

const FILTER_KEYS = ["q", "phone", "userId", "ownerId", "direction", "status", "tag", "from", "to", "show"] as const;

const DIR_WORD: Record<string, string> = { INCOMING: "Incoming", OUTGOING: "Outgoing", MISSED: "Missed", UNKNOWN: "Unknown" };

/**
 * "Show" choices. Each maps onto the server's filters; ?show=answered|noanswer becomes the
 * server's answered=true|false, so old links keep working.
 */
const SHOW_OPTS = [
  { key: "all", label: "All calls" },
  { key: "answered", label: "Answered" },
  { key: "missed", label: "Missed" },
  { key: "noanswer", label: "No answer" },
  { key: "transcript", label: "Has transcript" },
] as const;
type ShowKey = (typeof SHOW_OPTS)[number]["key"];
/** Which "Show" choice the URL matches; anything else stays "all" and appears as its own chip. */
function showKeyOf(direction: string, status: string, show: string): ShowKey {
  if (show === "answered" && !status) return "answered";
  if (show === "noanswer" && direction === "OUTGOING" && !status) return "noanswer";
  if (direction === "MISSED" && !status && !show) return "missed";
  if (status === "TRANSCRIBED" && !show) return "transcript";
  return "all";
}

/** Picked up by the other side: it has a recording, or a call-log entry with talk time. */
function wasAnswered(c: CallItem) {
  if (c.direction === "MISSED") return false;
  if (c.status !== "NO_RECORDING") return true;
  return !!c.durationS && !["MISSED", "REJECTED", "BLOCKED", "VOICEMAIL"].includes(c.logType ?? "");
}

const DAY_MS = 86_400_000;
/** Date presets as IST yyyy-mm-dd; "7 days" and "30 days" include today. */
function presetRange(key: string, now = Date.now()): { from: string; to: string } {
  if (key === "today") return { from: istDay(now), to: istDay(now) };
  if (key === "yesterday") return { from: istDay(now - DAY_MS), to: istDay(now - DAY_MS) };
  if (key === "7") return { from: istDay(now - 6 * DAY_MS), to: "" };
  if (key === "30") return { from: istDay(now - 29 * DAY_MS), to: "" };
  return { from: "", to: "" };
}
const PRESETS = [
  { key: "any", label: "Any time" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
];

// Day headers and times are India time, like the date filters.
const dayHeadFmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const callDay = (c: CallItem) => istDay(new Date(c.startedAt).getTime());
function dayLabel(day: string, now = Date.now()) {
  if (day === istDay(now)) return "Today";
  if (day === istDay(now - DAY_MS)) return "Yesterday";
  return dayHeadFmt.format(new Date(`${day}T12:00:00+05:30`));
}
/** Calls (newest first) bunched by IST day. */
function groupByDay(items: CallItem[]) {
  const groups: { day: string; items: CallItem[] }[] = [];
  for (const c of items) {
    const day = callDay(c);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(c);
    else groups.push({ day, items: [c] });
  }
  return groups;
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
  const admin = me.role === "ADMIN";
  const navigate = useNavigate();
  // Filters live in the URL so Back from a call returns to the same list.
  const [params, setParams] = useSearchParams();
  const get = (k: (typeof FILTER_KEYS)[number]) => params.get(k) ?? "";
  const [q, setQ] = useState(get("q"));
  const dq = useDebounced(q.trim(), 400);

  const setMany = (vals: Record<string, string>) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(vals)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { replace: true },
    );
  const set = (k: string, v: string) => setMany({ [k]: v });
  useEffect(() => set("q", dq), [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  // Re-sync the box when the URL's q changes from outside (links, back/forward).
  const urlQ = get("q");
  useEffect(() => {
    if (urlQ !== dq) setQ(urlQ);
  }, [urlQ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Like the Android app: a number-like search (3+ chars) searches by phone, not transcript.
  const search = get("q").trim();
  const isPhone = search.length >= 3 && /^[+\d][\d\s()\-]*$/.test(search);
  const filters = {
    q: isPhone ? "" : search,
    // Old links may still carry ?phone=; the search box covers numbers now.
    phone: isPhone ? search.replace(/[^\d+]/g, "") : get("phone"),
    userId: manager ? get("userId") : "",
    ownerId: manager ? get("ownerId") : "",
    direction: get("direction"),
    // Links (e.g. Health's "Calls without transcript") may set any state; only admins get the menu.
    status: get("status"),
    tag: get("tag"),
    // Dates are India days, whatever the viewer's time zone.
    from: istDayBoundary(get("from"), false),
    to: istDayBoundary(get("to"), true),
    answered: get("show") === "answered" ? "true" : get("show") === "noanswer" ? "false" : "",
    // Include call-log-only calls (no recording).
    v: "2",
  };
  const show = get("show");
  const showKey = showKeyOf(filters.direction, filters.status, show);
  // Missed and No answer already fix the direction.
  const dirLocked = showKey === "missed" || showKey === "noanswer";
  const dirKey = !dirLocked && (filters.direction === "INCOMING" || filters.direction === "OUTGOING") ? filters.direction : "";
  const pickShow = (k: string) => {
    // Incoming/Outgoing survives a Show change.
    if (k === "answered") setMany({ show: "answered", direction: dirKey, status: "" });
    else if (k === "missed") setMany({ show: "", direction: "MISSED", status: "" });
    else if (k === "noanswer") setMany({ show: "noanswer", direction: "OUTGOING", status: "" });
    else if (k === "transcript") setMany({ show: "", direction: dirKey, status: "TRANSCRIBED" });
    else setMany({ show: "", direction: dirKey, status: showKey === "all" ? filters.status : "" });
  };

  const activePreset = PRESETS.find((p) => {
    const r = presetRange(p.key);
    return r.from === get("from") && r.to === get("to");
  });
  const [customDates, setCustomDates] = useState(false);
  const showDates = customDates || (!activePreset && !!(get("from") || get("to")));
  const whenKey = showDates ? "custom" : (activePreset?.key ?? "any");
  const pickWhen = (k: string) => {
    if (k === "custom") return setCustomDates(true);
    setCustomDates(false);
    setMany(presetRange(k));
  };

  const activeCount = [get("phone"), filters.userId, filters.ownerId, filters.direction, filters.status, show, filters.tag, get("from"), get("to")].filter(Boolean).length;
  // Only what sits behind "More filters".
  const moreCount = [filters.userId, filters.ownerId, filters.tag, admin && showKey === "all" ? filters.status : ""].filter(Boolean).length;
  const [showFilters, setShowFilters] = useState(() => moreCount > 0);

  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users"), enabled: manager });

  const calls = useInfiniteQuery({
    queryKey: ["calls", filters],
    queryFn: ({ pageParam }) => api<CallPage>(`/api/calls${qs({ ...filters, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = calls.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = groupByDay(items);
  // The server stops a word search at 1,000 matches; say so instead of looking complete.
  const capped = calls.data?.pages.some((p) => {
    const x = p as CallPage & { capped?: boolean; truncated?: boolean; searchCapped?: boolean };
    return !!(x.capped || x.truncated || x.searchCapped);
  });
  // The score column appears once any listed call has an AI score.
  const hasScores = items.some((c) => c.score != null);
  const loadMoreError = calls.isFetchNextPageError ? calls.error : null;
  const loadMore = () => void calls.fetchNextPage();

  const clear = () => {
    setQ("");
    setCustomDates(false);
    setParams(new URLSearchParams(), { replace: true });
  };

  const userName = (id: string) => (id === me.id ? "Me" : personName(users.data?.find((u) => u.id === id) ?? { name: null, email: "Someone" }));
  const TAG_LABEL: Record<string, string> = { ANY: "Voicemail or no talk", VOICEMAIL: "Voicemail", NO_SPEECH: "No talk" };
  const SHOW_LABEL = Object.fromEntries(SHOW_OPTS.map((o) => [o.key, o.label])) as Record<ShowKey, string>;
  const whenLabel = activePreset && !showDates ? activePreset.label : "";
  // Every active filter as a removable chip, so one glance shows what is narrowing the list.
  const activeChips = [
    search && { key: "q", label: `Search: ${search}`, clear: () => { setQ(""); set("q", ""); } },
    get("phone") && { key: "phone", label: `Number: ${get("phone")}`, clear: () => set("phone", "") },
    showKey !== "all" && { key: "show", label: `Show: ${SHOW_LABEL[showKey]}`, clear: () => setMany({ show: "", status: "", direction: dirLocked ? "" : dirKey }) },
    dirKey && { key: "dir", label: `Direction: ${DIR_WORD[dirKey]}`, clear: () => set("direction", "") },
    showKey === "all" && filters.direction && !dirKey && { key: "dir2", label: DIR_WORD[filters.direction] ?? filters.direction, clear: () => set("direction", "") },
    showKey === "all" && filters.status && { key: "status", label: STATUS_LABEL[filters.status as CallStatus] ?? filters.status, clear: () => set("status", "") },
    showKey === "all" && show && { key: "show2", label: show === "answered" ? "Answered" : "No answer", clear: () => set("show", "") },
    filters.userId && { key: "user", label: `Called by: ${userName(filters.userId)}`, clear: () => set("userId", "") },
    filters.ownerId && { key: "owner", label: `Owned by: ${userName(filters.ownerId)}`, clear: () => set("ownerId", "") },
    filters.tag && { key: "tag", label: TAG_LABEL[filters.tag] ?? filters.tag, clear: () => set("tag", "") },
    whenLabel && whenKey !== "any" && { key: "when", label: `When: ${whenLabel}`, clear: () => pickWhen("any") },
    !whenLabel && get("from") && { key: "from", label: `From ${get("from")}`, clear: () => set("from", "") },
    !whenLabel && get("to") && { key: "to", label: `To ${get("to")}`, clear: () => set("to", "") },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[];

  // The label sits inside each control so it reads "Show: Answered", "When: Today".
  const pickerWrap = (on: boolean) =>
    cn(
      "flex min-h-11 items-center rounded-md border pl-3 text-sm focus-within:ring-2 focus-within:ring-ring",
      on ? "border-primary bg-primary-soft text-primary" : "bg-card",
    );
  const pickerSelect = "min-h-11 cursor-pointer bg-transparent pl-1 pr-2 font-medium outline-none disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <>
      <PageHeader title="Calls" subtitle={me.role === "ADMIN" ? "All calls" : me.role === "MANAGER" && me.team ? `Calls from team ${me.team}` : "Your calls"} />

      <Card className="mb-4 gap-0 p-3 sm:p-4">
        <Label className="sr-only" htmlFor="q">
          Search calls
        </Label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input id="q" type="search" className="min-h-11 pl-9" placeholder="Name, company, number or words said" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className={pickerWrap(showKey !== "all")}>
            <span className="text-muted-foreground">Show:</span>
            <select className={pickerSelect} value={showKey} onChange={(e) => pickShow(e.target.value)}>
              {SHOW_OPTS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className={pickerWrap(!!dirKey)} title={dirLocked ? `${SHOW_LABEL[showKey]} already picks the direction` : undefined}>
            <span className="text-muted-foreground">Direction:</span>
            <select className={pickerSelect} value={dirKey} disabled={dirLocked} onChange={(e) => set("direction", e.target.value)}>
              <option value="">{dirLocked ? (showKey === "missed" ? "Incoming" : "Outgoing") : "All"}</option>
              <option value="INCOMING">Incoming</option>
              <option value="OUTGOING">Outgoing</option>
            </select>
          </label>
          <label className={pickerWrap(whenKey !== "any")}>
            <span className="text-muted-foreground">When:</span>
            <select className={pickerSelect} value={whenKey} onChange={(e) => pickWhen(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom range…</option>
            </select>
          </label>
          <Button variant="outline" className="min-h-11" aria-expanded={showFilters} aria-controls="filters" onClick={() => setShowFilters((s) => !s)}>
            <SlidersHorizontal /> More filters{moreCount ? ` (${moreCount})` : ""}
          </Button>
          {manager && (
            // Same filters as the list; the server caps the file at 10,000 calls and audit-logs the export.
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="ghost" size="icon" className="ml-auto size-11 shrink-0">
                  <a href={`/api/calls/export${qs(filters)}`} download aria-label="Export these calls as CSV">
                    <Download />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Export these calls (CSV)</TooltipContent>
            </Tooltip>
          )}
        </div>

        {showDates && (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:max-w-md">
            <div>
              <Label htmlFor="f-from">From (IST)</Label>
              <Input id="f-from" type="date" value={get("from")} max={get("to") || undefined} onChange={(e) => set("from", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="f-to">To (IST)</Label>
              <Input id="f-to" type="date" value={get("to")} min={get("from") || undefined} onChange={(e) => set("to", e.target.value)} />
            </div>
          </div>
        )}

        {showFilters && (
          <div id="filters" className="mt-3 grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2 lg:grid-cols-3">
            {manager && (
              <div>
                <Label htmlFor="f-owner">Customer owned by</Label>
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
                <Label htmlFor="f-user">Called by</Label>
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
            {admin && (
              <div>
                <Label htmlFor="f-status">Recording and transcript</Label>
                <NativeSelect id="f-status" value={get("status")} onChange={(e) => set("status", e.target.value)}>
                  <option value="">Any</option>
                  {(Object.keys(STATUS_LABEL) as CallStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
            <div>
              <Label htmlFor="f-tag">Talk</Label>
              <NativeSelect id="f-tag" value={get("tag")} onChange={(e) => set("tag", e.target.value)}>
                <option value="">All calls</option>
                <option value="ANY">Voicemail or no talk</option>
                <option value="VOICEMAIL">Voicemail</option>
                <option value="NO_SPEECH">No talk</option>
              </NativeSelect>
            </div>
          </div>
        )}
        {activeChips.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Active filters">
            {activeChips.map((c) => (
              <Badge key={c.key} variant="secondary" className="gap-1 py-1 pl-2.5 pr-1">
                {c.label}
                <button type="button" className="rounded-full p-0.5 hover:bg-muted-foreground/20" aria-label={`Remove ${c.label}`} onClick={c.clear}>
                  <X className="size-3.5" />
                </button>
              </Badge>
            ))}
            <Button variant="link" size="sm" onClick={clear}>
              Clear all
            </Button>
          </div>
        )}
      </Card>

      {capped && (
        <p className="mb-3 text-sm text-muted-foreground">Showing first 1,000 matches. Add more words or a date to narrow it down.</p>
      )}

      {calls.isPending ? (
        <Spinner label="Loading calls" />
      ) : calls.isError ? (
        <ErrorBox error={calls.error} onRetry={() => void calls.refetch()} />
      ) : items.length === 0 && !calls.hasNextPage ? (
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
          {/* Phones: one card per call, under a day heading */}
          <div className="space-y-4 md:hidden">
            {groups.map((g) => (
              <section key={g.day} aria-label={dayLabel(g.day)}>
                <h2 className="mb-2 text-caption font-medium text-muted-foreground">{dayLabel(g.day)}</h2>
                <ul className="space-y-2">
                  {g.items.map((c) => (
                    <li key={c.id}>
                      <Link to={`/calls/${c.id}`} className="block rounded-xl border bg-card p-3 shadow-xs active:bg-muted">
                        <div className="flex items-start justify-between gap-2">
                          <ContactCell c={c} />
                          <div className="flex shrink-0 items-center gap-1.5">
                            <ResultPill c={c} mine={c.user?.id === me.id} />
                            <TranscriptIcon status={c.status} />
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-sm text-muted-foreground">
                          <span>{timeFmt.format(new Date(c.startedAt))}</span>
                          <span className="tabular-nums">{formatDuration(c.durationS)}</span>
                          <ViaTag via={c.via} />
                          <TalkTag tag={c.transcript?.tag} />
                          {manager && <span className="truncate">{personName(c.user)}</span>}
                          {c.score != null && <ScorePill score={c.score} />}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          {/* Larger screens: table, rows grouped by day, whole row opens the call */}
          {items.length > 0 && (
            <Card className="hidden gap-0 overflow-hidden p-0 md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Contact</TableHead>
                    <TableHead scope="col">When</TableHead>
                    <TableHead scope="col" className="text-right">
                      Duration
                    </TableHead>
                    {manager && <TableHead scope="col">Called by</TableHead>}
                    <TableHead scope="col">Result</TableHead>
                    {hasScores && (
                      <TableHead scope="col" className="text-right">
                        Score
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((g) => (
                    <Fragment key={g.day}>
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell colSpan={4 + (manager ? 1 : 0) + (hasScores ? 1 : 0)} className="h-9 py-1 text-caption font-medium text-muted-foreground">
                          {dayLabel(g.day)}
                        </TableCell>
                      </TableRow>
                      {g.items.map((c) => (
                        <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/calls/${c.id}`)}>
                          <TableCell>
                            <Link to={`/calls/${c.id}`} data-row-link className="block focus-visible:outline-none" onClick={(e) => e.stopPropagation()}>
                              <ContactCell c={c} company />
                            </Link>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">{timeFmt.format(new Date(c.startedAt))}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatDuration(c.durationS)}</TableCell>
                          {manager && (
                            <TableCell className="max-w-48">
                              <div className="truncate">{personName(c.user)}</div>
                              {fromLabel(c) && <div className="truncate text-xs text-muted-foreground">{fromLabel(c)}</div>}
                            </TableCell>
                          )}
                          <TableCell>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <ResultPill c={c} mine={c.user?.id === me.id} />
                              <TalkTag tag={c.transcript?.tag} />
                              <ViaTag via={c.via} />
                              <TranscriptIcon status={c.status} />
                            </div>
                          </TableCell>
                          {hasScores && <TableCell className="text-right tabular-nums">{c.score != null ? <ScorePill score={c.score} /> : "—"}</TableCell>}
                        </TableRow>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}

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

const DIR_ICON: Record<Direction, ReactNode> = {
  INCOMING: <ArrowDownLeft className="size-4" />,
  OUTGOING: <ArrowUpRight className="size-4" />,
  MISSED: <PhoneMissed className="size-4" />,
  UNKNOWN: <PhoneCall className="size-4" />,
};

/** Direction icon, then the name with the number (and company) underneath. */
function ContactCell({ c, company }: { c: CallItem; company?: boolean }) {
  const name = leadName(c);
  const number = c.phoneE164 || c.phoneRaw || "";
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className={cn("mt-0.5 shrink-0 text-muted-foreground", c.direction === "MISSED" && "text-warning-text")} title={DIR_WORD[c.direction]}>
        {DIR_ICON[c.direction]}
        <span className="sr-only">{DIR_WORD[c.direction]}</span>
      </span>
      <div className="min-w-0">
        <div className="truncate font-medium">{name || number || "Unknown number"}</div>
        {name && <div className="truncate text-xs text-muted-foreground">{[number, company ? c.lead?.company : null].filter(Boolean).join(" · ")}</div>}
      </div>
    </div>
  );
}

/** What happened on the call: Answered, or the call-log result (Missed, No answer, …). */
function ResultPill({ c, mine }: { c: CallItem; mine: boolean }) {
  if (c.status !== "NO_RECORDING") return <Pill tone="success">Answered</Pill>;
  const t = callRowStatusText(c.status, c.logType, c.direction, c.durationS, mine);
  const label = t.label === callStatusText("NO_RECORDING").label && wasAnswered(c) ? "Answered" : t.label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pill tone={label === "Answered" ? "success" : t.tone} tabIndex={0}>
          {label}
        </Pill>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{t.explanation}</TooltipContent>
    </Tooltip>
  );
}

const TRANSCRIPT_ICON: Partial<Record<CallStatus, ReactNode>> = {
  PENDING_UPLOAD: <CloudUpload className="size-4" />,
  UPLOADED: <Loader className="size-4" />,
  TRANSCRIBING: <Loader className="size-4" />,
  TRANSCRIBED: <FileText className="size-4" />,
  FAILED: <FileX className="size-4" />,
};

/** The recording/transcript state as a small grey icon; call-log-only calls show none. */
function TranscriptIcon({ status }: { status: CallStatus }) {
  const icon = TRANSCRIPT_ICON[status];
  if (!icon) return null;
  const t = callStatusText(status);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex text-muted-foreground" tabIndex={0} aria-label={t.label}>
          {icon}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        <b>{t.label}.</b> {t.explanation}
      </TooltipContent>
    </Tooltip>
  );
}

/** The lead's name from Contacts, else the name saved on the phone. */
function leadName(c: CallItem): string | null {
  return c.lead?.name || c.contactName || null;
}
