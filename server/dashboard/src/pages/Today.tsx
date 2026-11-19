import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type FollowUpItem, type FollowUpsToday, type MeToday, type MyList } from "../api";
import { useMe } from "../App";
import { CallButton } from "../dialer";
import { formatDuration, formatShortWhen, whatsAppUrl } from "../format";
import { Badge, ContactStatusBadge, ErrorBox, PageHeader, Spinner } from "../ui";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "short" });
const SNOOZE_MS = 60 * 60_000;

function greeting(name: string | null) {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name.split(" ")[0]}` : part;
}

function initials(item: FollowUpItem) {
  const words = (item.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return item.phoneE164.slice(-2);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** The signed-in rep's own follow-ups: overdue first, then due today (IST), including missed calls. */
export function TodayPage() {
  const me = useMe();
  const q = useQuery({
    queryKey: ["followups-today"],
    // v=2: also new-lead items (old phone apps don't get them).
    queryFn: () => api<FollowUpsToday>("/api/followups/today?v=2"),
    refetchInterval: 60_000,
  });

  const overdue = q.data?.items.filter((i) => i.overdue) ?? [];
  const today = q.data?.items.filter((i) => !i.overdue) ?? [];

  return (
    <>
      <PageHeader title={greeting(me.name)} subtitle={`Today · ${dateFmt.format(new Date())}`} />
      <div className="mb-5 grid gap-3 lg:grid-cols-2">
        <TargetsCard />
        <MyListsCard />
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="card p-4">
              <div className="text-2xl font-semibold tabular-nums text-overdue">{q.data.counts.overdue}</div>
              <div className="text-sm text-slate-600 dark:text-slate-400">Overdue</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-semibold tabular-nums text-brand-700 dark:text-brand-100">{q.data.counts.today}</div>
              <div className="text-sm text-slate-600 dark:text-slate-400">Due today</div>
            </div>
          </div>
          {q.data.items.length === 0 ? (
            <p className="card p-8 text-center text-sm text-slate-500 dark:text-slate-400">
              Nothing due today. Follow-ups you set after a call, and missed calls from your phone, show up here.
            </p>
          ) : (
            <>
              <Section title="Overdue" items={overdue} />
              <Section title="Today" items={today} />
            </>
          )}
        </>
      )}
    </>
  );
}

function TargetBar({ label, value, target, pct }: { label: string; value: string; target: number | null; pct: number | null }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-slate-600 dark:text-slate-400">{label}</span>
        <span className="font-semibold tabular-nums">
          {value}
          {target != null && <span className="font-normal text-slate-500"> / {target}</span>}
        </span>
      </div>
      {pct != null && (
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full ${pct >= 100 ? "bg-call" : "bg-brand-600"}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
    </div>
  );
}

/** My numbers today against my daily targets (bars only when a target is set). */
function TargetsCard() {
  const q = useQuery({ queryKey: ["me-today"], queryFn: () => api<MeToday>("/api/me/today"), refetchInterval: 60_000 });
  if (!q.data) return null;
  const d = q.data;
  return (
    <section aria-labelledby="targets-h" className="card space-y-3 p-4">
      <h2 id="targets-h" className="font-semibold">
        My targets
      </h2>
      <TargetBar label="Calls" value={String(d.calls)} target={d.target.callsPerDay} pct={d.progress.callsPct} />
      <TargetBar label="Talk time (min)" value={String(Math.floor(d.talkTimeS / 60))} target={d.target.talkMinPerDay} pct={d.progress.talkPct} />
      <p className="text-xs text-slate-500">
        {d.connected} connected · {formatDuration(d.talkTimeS)} talk · {d.messages} messages
      </p>
    </section>
  );
}

function MyListsCard() {
  const q = useQuery({ queryKey: ["my-lists"], queryFn: () => api<{ items: MyList[] }>("/api/my/call-lists") });
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="mylists-h" className="card p-4">
      <h2 id="mylists-h" className="mb-2 font-semibold">
        My call lists ({items.length})
      </h2>
      <ul className="space-y-2">
        {items.slice(0, 4).map((l) => (
          <li key={l.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{l.name}</span>
            <span className="tabular-nums text-slate-500">
              {l.progress.done} of {l.progress.total}
            </span>
            {l.state === "ACTIVE" ? (
              <Link to={`/lists/${l.id}/work`} className="btn-call min-h-9 px-3">
                {l.progress.inProgress ? "Continue" : "Start"}
              </Link>
            ) : (
              <Badge tone="amber">Paused</Badge>
            )}
          </li>
        ))}
      </ul>
      {items.length > 4 && (
        <Link to="/lists" className="mt-2 inline-block text-sm text-brand-700 hover:underline dark:text-brand-100">
          All lists
        </Link>
      )}
    </section>
  );
}

function Section({ title, items }: { title: string; items: FollowUpItem[] }) {
  if (items.length === 0) return null;
  const id = `today-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="mb-6">
      <h2 id={id} className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        {title} · {items.length}
      </h2>
      <ul className="space-y-2">
        {items.map((i) => (
          <Row key={i.key} item={i} />
        ))}
      </ul>
    </section>
  );
}

function Row({ item }: { item: FollowUpItem }) {
  const qc = useQueryClient();
  const missed = item.kind === "MISSED_CALL";
  const lead = item.kind === "NEW_LEAD";
  const label = item.name || item.phoneE164;
  const wa = whatsAppUrl(item.phoneE164);
  const patch = useMutation({
    mutationFn: (body: { action: "done" | "snooze"; until?: string }) => api(`/api/followups/${item.taskId}`, { method: "PATCH", body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["followups-today"] }),
  });
  const due = missed ? `Missed ${formatShortWhen(item.dueAt)}` : lead ? `Came in ${formatShortWhen(item.dueAt)}` : item.overdue ? `Overdue · ${formatShortWhen(item.dueAt)}` : timeFmt.format(new Date(item.dueAt));
  const sub = [item.company, item.lastNote].filter(Boolean).join(" · ");

  return (
    <li className="card flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap">
      <span
        aria-hidden
        className={`grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold ${
          missed ? "bg-red-100 text-overdue dark:bg-red-950 dark:text-red-300" : lead ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-100"
        }`}
      >
        {initials(item)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {item.contactId ? (
            <Link to={`/activity/contacts/${item.contactId}`} className="truncate font-medium hover:underline">
              {label}
            </Link>
          ) : (
            <span className="truncate font-medium">{label}</span>
          )}
          {missed && <Badge tone="red">Missed call</Badge>}
          {lead && <Badge tone="green">New lead{item.source ? ` · ${item.source}` : ""}</Badge>}
          {item.status && <ContactStatusBadge status={item.status} />}
        </div>
        <div className="truncate text-sm text-slate-500 dark:text-slate-400">
          {item.name ? `${item.phoneE164}${sub ? " · " : ""}` : ""}
          {sub}
        </div>
      </div>
      <div className={`whitespace-nowrap text-sm font-medium ${item.overdue ? "text-overdue" : "text-brand-700 dark:text-brand-100"}`}>{due}</div>
      <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-nowrap">
        <CallButton phone={item.phoneE164} label={label} className="btn-call" />
        {wa && (
          <a className="btn-outline" href={wa} target="_blank" rel="noreferrer">
            WhatsApp
          </a>
        )}
        {item.taskId && (
          <>
            <button type="button" className="btn-ghost" disabled={patch.isPending} onClick={() => patch.mutate({ action: "done" })}>
              Done
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={patch.isPending}
              title="Snooze 1 hour"
              onClick={() => patch.mutate({ action: "snooze", until: new Date(Date.now() + SNOOZE_MS).toISOString() })}
            >
              Snooze 1 h
            </button>
          </>
        )}
      </div>
      {patch.isError && (
        <p role="alert" className="w-full text-sm text-red-600 dark:text-red-400">
          {patch.error.message}
        </p>
      )}
    </li>
  );
}
