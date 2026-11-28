import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, qs, type TeamStats, type TeamStatsRow } from "../api";
import { useMe } from "../App";
import { formatDuration, istDay, istDayBoundary, personName } from "../format";
import { Empty, ErrorBox, Hint, PageHeader, Spinner } from "../ui";
import { Users } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Range = "today" | "7d" | "30d" | "custom";
const RANGES: [Range, string][] = [
  ["today", "Today"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["custom", "Dates"],
];
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayTimeFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const pct = (r: number | null) => (r == null ? "—" : `${Math.round(r * 100)}%`);

function Bar({ value, label }: { value: number | null; label: string }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const w = Math.max(0, Math.min(100, value));
  return (
    <div className="flex min-w-28 items-center gap-2" title={label}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-full rounded-full ${value >= 100 ? "bg-call" : "bg-primary"}`} style={{ width: `${w}%` }} />
      </div>
      <span className="w-10 text-right text-xs tabular-nums">{value}%</span>
    </div>
  );
}

/** Team performance (replaces "Reps & stats"): same activity-based numbers as the reps report. */
export function TeamPage() {
  const me = useMe();
  const [range, setRange] = useState<Range>("today");
  const today = istDay();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  // Explicit IST from/to (custom dates) win over range on the server.
  const params = range === "custom" ? { from: istDayBoundary(from, false), to: istDayBoundary(to || from, true) } : { range };
  const stats = useQuery({
    queryKey: ["team-stats", params],
    queryFn: () => api<TeamStats>(`/api/team/stats${qs(params)}`),
    // Live: server notices (ringing / new calls) refetch at once; this poll catches the rest.
    refetchInterval: range === "today" ? 20_000 : false,
  });
  const fmtTime = (iso: string | null) => (iso ? (range === "today" ? timeFmt : dayTimeFmt).format(new Date(iso)) : "—");
  const d = stats.data;
  const byId = new Map(d?.items.map((r) => [r.user.id, r]) ?? []);

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={me.role === "MANAGER" && me.team ? `Calls and follow-ups for team ${me.team}` : "Calls and follow-ups by rep"}
        actions={
          <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
            <TabsList aria-label="Date range">
              {RANGES.map(([v, l]) => (
                <TabsTrigger key={v} value={v}>
                  {l}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        }
      />
      {range === "custom" && (
        <Card className="mb-4 flex flex-wrap items-end gap-3 p-3 sm:p-4">
          <div>
            <Label htmlFor="t-from">
              From (IST)
            </Label>
            <Input id="t-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value || today)} />
          </div>
          <div>
            <Label htmlFor="t-to">
              To (IST)
            </Label>
            <Input id="t-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value || from)} />
          </div>
          <Hint className="w-full">Overdue counts each rep's follow-ups as of now and ignores the dates.</Hint>
        </Card>
      )}
      {stats.isPending ? (
        <Spinner label="Loading team stats" />
      ) : stats.isError ? (
        <ErrorBox error={stats.error} onRetry={() => void stats.refetch()} />
      ) : !d ? null : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            {[
              ["Calls", String(d.totals.calls)],
              ["Outgoing", String(d.totals.outgoing)],
              ["Incoming", String(d.totals.incoming)],
              ["Missed", String(d.totals.missed)],
              ["Connected", `${d.totals.connected} (${pct(d.totals.connectRate)})`],
              ["Talk time", formatDuration(d.totals.talkTimeS)],
              ["Follow-ups done", String(d.totals.followUpsDone)],
              ["Overdue now", String(d.totals.followUpsOverdue)],
            ].map(([l, v]) => (
              <Card key={l} className="p-4">
                <div className={`text-2xl font-semibold tabular-nums ${(l === "Overdue now" && d.totals.followUpsOverdue) || (l === "Missed" && d.totals.missed) ? "text-overdue" : ""}`}>{v}</div>
                <div className="text-sm text-muted-foreground">{l}</div>
              </Card>
            ))}
          </div>

          {d.items.length > 0 && <LiveNow items={d.items} />}

          {d.items.length === 0 ? (
            <Empty icon={<Users />}>No reps to show yet. Add reps on the Users page and give them a team.</Empty>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[1fr_18rem]">
              <Card className="overflow-hidden p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {["Rep", "Calls", "Out", "In", "Missed", "Connected", "Rate", "Talk time", "First call", "Last call", "Messages", "Follow-ups done", "Overdue", "Calls vs target"].map((h, i) => (
                        <TableHead key={h} scope="col" className={i && i < 13 ? "text-right" : ""}>
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.items.map((r) => (
                      <Row key={r.user.id} r={r} fmtTime={fmtTime} days={d.days} />
                    ))}
                  </TableBody>
                </Table>
              </Card>
              <Card role="region" aria-labelledby="lb-h" className="p-4">
                <h2 id="lb-h" className="mb-2 font-semibold">
                  Leaderboard
                </h2>
                <Hint className="mb-2">By connected calls, then talk time.</Hint>
                <ol className="space-y-1">
                  {d.leaderboard.slice(0, 10).map((l) => {
                    const r = byId.get(l.userId);
                    return (
                      <li key={l.userId} className="flex items-center gap-2 text-sm">
                        <span className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${l.rank <= 3 ? "bg-primary text-primary-foreground" : "bg-muted"}`}>{l.rank}</span>
                        <span className="min-w-0 flex-1 truncate">{r ? personName(r.user) : "—"}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {l.connected} · {formatDuration(l.talkTimeS)}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Row({ r, fmtTime, days }: { r: TeamStatsRow; fmtTime: (iso: string | null) => string; days: number }) {
  const target = r.target.callsPerDay != null ? r.target.callsPerDay * days : null;
  return (
    <TableRow>
      <TableHead scope="row" className="max-w-44 truncate text-sm font-medium normal-case tracking-normal text-foreground">
        {personName(r.user)}
      </TableHead>
      <TableCell className="text-right tabular-nums">{r.calls}</TableCell>
      <TableCell className="text-right tabular-nums">{r.outgoing}</TableCell>
      <TableCell className="text-right tabular-nums">{r.incoming}</TableCell>
      <TableCell className={`text-right tabular-nums ${r.missed ? "font-medium text-overdue" : ""}`}>{r.missed}</TableCell>
      <TableCell className="text-right tabular-nums">{r.connected}</TableCell>
      <TableCell className="text-right tabular-nums">{pct(r.connectRate)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatDuration(r.talkTimeS)}</TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtTime(r.firstCallAt)}</TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtTime(r.lastCallAt)}</TableCell>
      <TableCell className="text-right tabular-nums">{r.messages}</TableCell>
      <TableCell className="text-right tabular-nums">{r.followUpsDone}</TableCell>
      <TableCell className="text-right tabular-nums">
        <Link
          to={`/activity${qs({ ownerId: r.user.id, due: "overdue" })}`}
          className={r.followUpsOverdue ? "inline-flex min-h-10 items-center font-medium text-destructive hover:underline" : "inline-flex min-h-10 items-center text-primary hover:underline"}
        >
          {r.followUpsOverdue}
        </Link>
      </TableCell>
      <TableCell>
        {target != null ? (
          <div>
            <div className="mb-1 text-xs tabular-nums text-muted-foreground">
              {r.calls} / {target}
            </div>
            <Bar value={r.vsTarget.callsPct} label={`${personName(r.user)}: calls vs target`} />
          </div>
        ) : (
          <span className="text-muted-foreground">No target</span>
        )}
      </TableCell>
    </TableRow>
  );
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Live status per rep: ringing / on a call (from the phone), phone app connected, last call. */
function LiveNow({ items }: { items: TeamStatsRow[] }) {
  const [now, setNow] = useState(() => Date.now());
  const busy = items.some((r) => r.live.state);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const order = (r: TeamStatsRow) => (r.live.state === "onCall" ? 0 : r.live.state === "ringing" ? 1 : r.live.phoneOnline ? 2 : 3);
  const sorted = [...items].sort((a, b) => order(a) - order(b));
  return (
    <Card role="region" aria-labelledby="live-h" className="mb-4 p-4">
      <h2 id="live-h" className="mb-1 font-semibold">
        Live now
      </h2>
      <Hint className="mb-3">On a call shows for incoming calls the phone reports. Updates by itself.</Hint>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {sorted.map((r) => {
          const l = r.live;
          const since = l.since ? new Date(l.since).getTime() : now;
          const [dot, text] =
            l.state === "onCall"
              ? ["bg-call", `On a call ${mmss(now - since)}`]
              : l.state === "ringing"
                ? ["bg-primary animate-pulse", "Ringing"]
                : l.phoneOnline
                  ? ["bg-call/50", "Phone online"]
                  : ["bg-muted-foreground/40", l.phoneLastSeenAt ? `Phone seen ${dayTimeFmt.format(new Date(l.phoneLastSeenAt))}` : "Phone not set up"];
          return (
            <li key={r.user.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <span className={`size-2.5 shrink-0 rounded-full ${dot}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{personName(r.user)}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {text}
                  {r.lastCallAt ? ` · last call ${timeFmt.format(new Date(r.lastCallAt))}` : ""}
                </div>
              </div>
              <span className="text-xs tabular-nums text-muted-foreground" title="Out / In / Missed">
                {r.outgoing}/{r.incoming}/<span className={r.missed ? "text-overdue" : ""}>{r.missed}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
