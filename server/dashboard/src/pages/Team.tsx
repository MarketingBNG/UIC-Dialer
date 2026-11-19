import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, qs, type TeamStats, type TeamStatsRow } from "../api";
import { useMe } from "../App";
import { formatDuration, istDay, istDayBoundary, personName } from "../format";
import { Empty, ErrorBox, PageHeader, Spinner } from "../ui";

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
  if (value == null) return <span className="text-slate-400">—</span>;
  const w = Math.max(0, Math.min(100, value));
  return (
    <div className="flex min-w-28 items-center gap-2" title={label}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={`h-full rounded-full ${value >= 100 ? "bg-call" : "bg-brand-600"}`} style={{ width: `${w}%` }} />
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
    refetchInterval: range === "today" ? 60_000 : false,
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
          <div role="group" aria-label="Range" className="inline-flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
            {RANGES.map(([v, l]) => (
              <button
                key={v}
                type="button"
                aria-pressed={range === v}
                className={`min-h-9 rounded-md px-3 text-sm font-medium ${range === v ? "bg-brand-600 text-white" : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"}`}
                onClick={() => setRange(v)}
              >
                {l}
              </button>
            ))}
          </div>
        }
      />
      {range === "custom" && (
        <div className="card mb-4 flex flex-wrap items-end gap-3 p-3 sm:p-4">
          <div>
            <label className="label" htmlFor="t-from">
              From (IST)
            </label>
            <input id="t-from" type="date" className="input" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value || today)} />
          </div>
          <div>
            <label className="label" htmlFor="t-to">
              To (IST)
            </label>
            <input id="t-to" type="date" className="input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value || from)} />
          </div>
          <p className="hint w-full">Overdue counts each rep's follow-ups as of now and ignores the dates.</p>
        </div>
      )}
      {stats.isPending ? (
        <Spinner label="Loading team stats" />
      ) : stats.isError ? (
        <ErrorBox error={stats.error} onRetry={() => void stats.refetch()} />
      ) : !d ? null : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ["Calls", String(d.totals.calls)],
              ["Connected", String(d.totals.connected)],
              ["Connect rate", pct(d.totals.connectRate)],
              ["Talk time", formatDuration(d.totals.talkTimeS)],
              ["Follow-ups done", String(d.totals.followUpsDone)],
              ["Overdue now", String(d.totals.followUpsOverdue)],
            ].map(([l, v]) => (
              <div key={l} className="card p-4">
                <div className={`text-2xl font-semibold tabular-nums ${l === "Overdue now" && d.totals.followUpsOverdue ? "text-overdue" : ""}`}>{v}</div>
                <div className="text-sm text-slate-600 dark:text-slate-400">{l}</div>
              </div>
            ))}
          </div>

          {d.items.length === 0 ? (
            <Empty>No reps to show.</Empty>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[1fr_18rem]">
              <div className="card overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <tr>
                      {["Rep", "Calls", "Connected", "Rate", "Talk time", "First call", "Last call", "Messages", "Follow-ups done", "Overdue", "Calls vs target"].map((h, i) => (
                        <th key={h} scope="col" className={`whitespace-nowrap px-3 py-3 font-medium ${i && i < 10 ? "text-right" : ""}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {d.items.map((r) => (
                      <Row key={r.user.id} r={r} fmtTime={fmtTime} days={d.days} />
                    ))}
                  </tbody>
                </table>
              </div>
              <section aria-labelledby="lb-h" className="card p-4">
                <h2 id="lb-h" className="mb-2 font-semibold">
                  Leaderboard
                </h2>
                <p className="hint mb-2">By connected calls, then talk time.</p>
                <ol className="space-y-1">
                  {d.leaderboard.slice(0, 10).map((l) => {
                    const r = byId.get(l.userId);
                    return (
                      <li key={l.userId} className="flex items-center gap-2 text-sm">
                        <span className={`grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${l.rank <= 3 ? "bg-brand-600 text-white" : "bg-slate-100 dark:bg-slate-800"}`}>{l.rank}</span>
                        <span className="min-w-0 flex-1 truncate">{r ? personName(r.user) : "—"}</span>
                        <span className="tabular-nums text-slate-500">
                          {l.connected} · {formatDuration(l.talkTimeS)}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
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
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
      <th scope="row" className="max-w-44 truncate px-3 py-3 font-medium">
        {personName(r.user)}
      </th>
      <td className="px-3 py-3 text-right tabular-nums">{r.calls}</td>
      <td className="px-3 py-3 text-right tabular-nums">{r.connected}</td>
      <td className="px-3 py-3 text-right tabular-nums">{pct(r.connectRate)}</td>
      <td className="px-3 py-3 text-right tabular-nums">{formatDuration(r.talkTimeS)}</td>
      <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{fmtTime(r.firstCallAt)}</td>
      <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{fmtTime(r.lastCallAt)}</td>
      <td className="px-3 py-3 text-right tabular-nums">{r.messages}</td>
      <td className="px-3 py-3 text-right tabular-nums">{r.followUpsDone}</td>
      <td className="px-3 py-3 text-right tabular-nums">
        <Link
          to={`/activity${qs({ ownerId: r.user.id, due: "overdue" })}`}
          className={r.followUpsOverdue ? "font-medium text-red-600 hover:underline dark:text-red-400" : "text-brand-700 hover:underline dark:text-brand-100"}
        >
          {r.followUpsOverdue}
        </Link>
      </td>
      <td className="px-3 py-3">
        {target != null ? (
          <div>
            <div className="mb-1 text-xs tabular-nums text-slate-500">
              {r.calls} / {target}
            </div>
            <Bar value={r.vsTarget.callsPct} label={`${personName(r.user)}: calls vs target`} />
          </div>
        ) : (
          <span className="text-slate-400">No target</span>
        )}
      </td>
    </tr>
  );
}
