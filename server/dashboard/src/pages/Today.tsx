import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError, api, qs, type ContactPage, type FollowUpItem, type FollowUpsToday, type MeToday, type MyList, type NextResponse } from "../api";
import { useMe } from "../App";
import { CallButton, cleanNumber, isDesktopApp, useDialer } from "../dialer";
import { formatDuration, formatShortWhen, whatsAppUrl } from "../format";
import { Badge, ContactStatusBadge, ErrorBox, PageHeader, Spinner } from "../ui";
import { progressText } from "./Lists";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "short" });
const SNOOZE_MS = 60 * 60_000;
const SHORT_LIST = 5;

function greeting(name: string | null) {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name.split(" ")[0]}` : part;
}

function initials(name: string | null, phone: string) {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return phone.slice(-2);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** One queue entry: a follow-up / missed call / new lead, or an active call list (its next item is claimed only when it reaches the top). */
type Entry = { kind: "fu"; key: string; item: FollowUpItem } | { kind: "list"; key: string; list: MyList };

const rank = (i: FollowUpItem) => (i.overdue ? 0 : i.kind === "NEW_LEAD" ? 2 : 1);
const remaining = (l: MyList) => l.progress.pending + l.progress.inProgress;

/** The single label a row shows. */
function ItemLabel({ item }: { item: FollowUpItem }) {
  if (item.kind === "MISSED_CALL") return <Badge tone="red">Missed call</Badge>;
  if (item.kind === "NEW_LEAD") return <Badge tone="green">New lead</Badge>;
  if (item.overdue) return <Badge tone="red">Overdue</Badge>;
  if (item.status) return <ContactStatusBadge status={item.status} />;
  return <Badge tone="blue">Follow-up</Badge>;
}

function dueText(item: FollowUpItem) {
  if (item.kind === "MISSED_CALL") return `Missed ${formatShortWhen(item.dueAt)}`;
  if (item.kind === "NEW_LEAD") return `Came in ${formatShortWhen(item.dueAt)}`;
  if (item.overdue) return `Due ${formatShortWhen(item.dueAt)}`;
  return `Due ${timeFmt.format(new Date(item.dueAt))}`;
}

/**
 * Today is the call queue: the next person to call with one big Call button, the rest below.
 * After the outcome is saved (or the call is dismissed) the next entry moves up by itself.
 */
export function TodayPage() {
  const me = useMe();
  const dialer = useDialer();
  const fu = useQuery({
    queryKey: ["followups-today"],
    // v=2: also new-lead items (old phone apps don't get them).
    queryFn: () => api<FollowUpsToday>("/api/followups/today?v=2"),
    refetchInterval: 60_000,
  });
  const lists = useQuery({ queryKey: ["my-lists"], queryFn: () => api<{ items: MyList[] }>("/api/my/call-lists") });

  // Entries handled in this visit (called, skipped) step aside so the next one comes up even before the server updates.
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const handle = (key: string) => setHandled((s) => new Set(s).add(key));
  const calling = useRef<{ key: string; seen: boolean } | null>(null);
  useEffect(() => {
    const c = calling.current;
    if (!c) return;
    if (dialer.pending) c.seen = true;
    else if (c.seen) {
      calling.current = null;
      handle(c.key);
    }
  }, [dialer.pending]);
  const startCall = (key: string) => {
    calling.current = { key, seen: false };
  };

  const fuEntries: Entry[] = [...(fu.data?.items ?? [])]
    .sort((a, b) => rank(a) - rank(b))
    .map((item) => ({ kind: "fu", key: item.key, item }));
  const listEntries: Entry[] = (lists.data?.items ?? [])
    .filter((l) => l.state === "ACTIVE" && remaining(l) > 0)
    .map((list) => ({ kind: "list", key: `list:${list.id}`, list }));
  const queue = [...fuEntries, ...listEntries].filter((e) => !handled.has(e.key));
  const [next, ...rest] = queue;

  return (
    <>
      <PageHeader title={greeting(me.name)} subtitle={`Today · ${dateFmt.format(new Date())}`} />
      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-5">
          {fu.isPending || lists.isPending ? (
            <Spinner label="Getting your next call" />
          ) : fu.isError ? (
            <ErrorBox error={fu.error} onRetry={() => void fu.refetch()} />
          ) : !next ? (
            <section className="card p-8 text-center">
              <h2 className="text-lg font-semibold">All caught up</h2>
              <p className="mt-1 text-sm text-slate-500">
                Follow-ups you set after a call, missed calls, new leads and your call lists show up here.
              </p>
            </section>
          ) : next.kind === "fu" ? (
            <FollowUpNext key={next.key} item={next.item} onCall={() => startCall(next.key)} onSkip={() => handle(next.key)} />
          ) : (
            <ListNext key={next.key} list={next.list} onFinished={() => handle(next.key)} />
          )}
          {rest.length > 0 && <UpNext entries={rest} onCall={startCall} onSkip={handle} />}
        </div>
        <div className="space-y-5">
          <DialBox />
          <TargetsCard />
        </div>
      </div>
    </>
  );
}

function Avatar({ name, phone }: { name: string | null; phone: string }) {
  return (
    <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-full bg-brand-50 text-lg font-semibold text-brand-700">
      {initials(name, phone)}
    </span>
  );
}

function NextCard({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-labelledby="next-h" className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="next-h" className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Next up
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function BigCall({ onClick, text = "Call" }: { onClick: () => void; text?: string }) {
  return (
    <button type="button" className="btn-call w-full py-4 text-lg" onClick={onClick}>
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
      </svg>
      {text}
    </button>
  );
}

function useTaskPatch(taskId: string | null, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "done" | "snooze"; until?: string }) => api(`/api/followups/${taskId}`, { method: "PATCH", body }),
    onSuccess: () => {
      onDone?.();
      void qc.invalidateQueries({ queryKey: ["followups-today"] });
    },
  });
}

function FollowUpNext({ item, onCall, onSkip }: { item: FollowUpItem; onCall: () => void; onSkip: () => void }) {
  const dialer = useDialer();
  const patch = useTaskPatch(item.taskId, onSkip);
  const label = item.name || item.phoneE164;
  const wa = whatsAppUrl(item.phoneE164);
  const onThisCall = dialer.pending?.phone === cleanNumber(item.phoneE164);

  return (
    <NextCard aside={<span className={`text-sm font-medium ${item.overdue ? "text-overdue" : "text-brand-700"}`}>{dueText(item)}</span>}>
      <div className="mt-3 flex items-center gap-4">
        <Avatar name={item.name} phone={item.phoneE164} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {item.contactId ? (
              <Link to={`/activity/contacts/${item.contactId}`} className="truncate text-xl font-semibold hover:underline">
                {label}
              </Link>
            ) : (
              <span className="truncate text-xl font-semibold">{label}</span>
            )}
            <ItemLabel item={item} />
          </div>
          <div className="truncate text-sm text-slate-500">{[item.name ? item.phoneE164 : null, item.company].filter(Boolean).join(" · ")}</div>
        </div>
      </div>
      {item.lastNote && (
        <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last note</div>
          <p className="mt-1 whitespace-pre-line">{item.lastNote}</p>
        </div>
      )}
      <div className="mt-5">
        {onThisCall ? (
          <button type="button" className="btn-primary w-full py-4 text-lg" onClick={dialer.openOutcome}>
            Log outcome
          </button>
        ) : (
          <BigCall
            onClick={() => {
              onCall();
              void dialer.call(item.phoneE164, label);
            }}
          />
        )}
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-1">
        {wa && (
          <a className="btn-ghost" href={wa} target="_blank" rel="noreferrer">
            WhatsApp
          </a>
        )}
        {item.taskId && (
          <>
            <button type="button" className="btn-ghost" disabled={patch.isPending} onClick={() => patch.mutate({ action: "done" })}>
              Mark done
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ action: "snooze", until: new Date(Date.now() + SNOOZE_MS).toISOString() })}
            >
              Snooze 1 h
            </button>
          </>
        )}
        <button type="button" className="btn-ghost" onClick={onSkip}>
          Skip for now
        </button>
      </div>
      {patch.isError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {patch.error.message}
        </p>
      )}
      <p className="hint mt-3 text-center">After you save the outcome, the next call comes up here.</p>
    </NextCard>
  );
}

/** The active call list's next item (claimed from the server only once the list reaches the top of the queue). */
function ListNext({ list, onFinished }: { list: MyList; onFinished: () => void }) {
  const qc = useQueryClient();
  const dialer = useDialer();
  const next = useQuery({
    queryKey: ["list-next", list.id],
    queryFn: () => api<NextResponse>(`/api/my/call-lists/${list.id}/next`, { method: "POST", body: {} }),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const skip = useMutation({
    mutationFn: (itemId: string) => api<NextResponse>(`/api/my/call-list-items/${itemId}/skip`, { method: "POST", body: {} }),
    onSuccess: (r) => {
      qc.setQueryData(["list-next", list.id], r);
      void qc.invalidateQueries({ queryKey: ["my-lists"] });
    },
  });
  const empty = next.data && !next.data.item;
  useEffect(() => {
    if (empty) onFinished();
  }, [empty, onFinished]);

  const progress = next.data?.progress ?? list.progress;
  const aside = (
    <span className="text-sm text-slate-600">
      <Link to={`/lists/${list.id}/work`} className="font-medium text-brand-700 hover:underline">
        {list.name}
      </Link>{" "}
      · <span className="tabular-nums">{progressText(progress)}</span>
    </span>
  );

  if (next.isPending)
    return (
      <NextCard aside={aside}>
        <Spinner label="Getting the next number" />
      </NextCard>
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
      <NextCard aside={aside}>
        {msg ? <p className="mt-3 text-sm text-slate-600">{msg}</p> : <ErrorBox error={e} onRetry={() => void next.refetch()} />}
        <button type="button" className="btn-ghost mt-2" onClick={onFinished}>
          Skip this list
        </button>
      </NextCard>
    );
  }
  const it = next.data.item;
  if (!it) return null;
  const c = it.contact;
  const label = c.name || c.phoneE164;
  const onThisCall = dialer.pending?.callListItemId === it.id;
  const script = list.script;

  return (
    <NextCard aside={aside}>
      <div className="mt-3 flex items-center gap-4">
        <Avatar name={c.name} phone={c.phoneE164} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/activity/contacts/${c.id}`} className="truncate text-xl font-semibold hover:underline">
              {label}
            </Link>
            {c.dnc ? <Badge tone="red">Do not call</Badge> : <ContactStatusBadge status={c.status} />}
          </div>
          <div className="truncate text-sm text-slate-500">
            {[c.name ? c.phoneE164 : null, c.company, c.city].filter(Boolean).join(" · ")}
            {it.attempts > 0 ? ` · attempt ${it.attempts + 1}` : ""}
          </div>
        </div>
      </div>
      {it.lastOutcome && (
        <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last outcome</span> {it.lastOutcome.label}
        </div>
      )}
      <div className="mt-5">
        {onThisCall ? (
          <button type="button" className="btn-primary w-full py-4 text-lg" onClick={dialer.openOutcome}>
            Log outcome
          </button>
        ) : (
          <BigCall onClick={() => void dialer.call(c.phoneE164, label, { callListItemId: it.id, listId: list.id, dncReason: c.dnc?.reason ?? null, dnc: !!c.dnc })} />
        )}
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-1">
        {whatsAppUrl(c.phoneE164) && (
          <a className="btn-ghost" href={whatsAppUrl(c.phoneE164)!} target="_blank" rel="noreferrer">
            WhatsApp
          </a>
        )}
        <button type="button" className="btn-ghost" disabled={skip.isPending} onClick={() => skip.mutate(it.id)}>
          {skip.isPending ? "Skipping…" : "Skip"}
        </button>
      </div>
      {skip.error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {skip.error.message}
        </p>
      )}
      {script && script.sections.length > 0 && (
        <details className="mt-4 rounded-xl border border-slate-200 p-3" open>
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">Script · {script.name}</summary>
          <div className="mt-2 space-y-3">
            {script.sections.map((s, i) => (
              <div key={i}>
                <div className="text-xs font-bold uppercase tracking-wide text-brand-700">{s.heading}</div>
                <p className="mt-1 whitespace-pre-line text-sm">{s.text}</p>
              </div>
            ))}
          </div>
        </details>
      )}
      <p className="hint mt-3 text-center">After you save the outcome, the next number comes up here.</p>
    </NextCard>
  );
}

function UpNext({ entries, onCall, onSkip }: { entries: Entry[]; onCall: (key: string) => void; onSkip: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, SHORT_LIST);
  return (
    <section aria-labelledby="upnext-h">
      <h2 id="upnext-h" className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Up next · {entries.length}
      </h2>
      <ul className="card divide-y divide-slate-100">
        {shown.map((e) => (e.kind === "fu" ? <FollowUpRow key={e.key} item={e.item} onCall={() => onCall(e.key)} onSkip={() => onSkip(e.key)} /> : <ListRow key={e.key} list={e.list} />))}
      </ul>
      {entries.length > SHORT_LIST && (
        <button type="button" className="btn-ghost mt-2" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${entries.length}`}
        </button>
      )}
    </section>
  );
}

function FollowUpRow({ item, onCall, onSkip }: { item: FollowUpItem; onCall: () => void; onSkip: () => void }) {
  const dialer = useDialer();
  const patch = useTaskPatch(item.taskId);
  const label = item.name || item.phoneE164;
  const wa = whatsAppUrl(item.phoneE164);
  const actions: MenuAction[] = [];
  if (wa) actions.push({ label: "WhatsApp", href: wa });
  if (item.taskId) {
    actions.push({ label: "Mark done", onSelect: () => patch.mutate({ action: "done" }) });
    actions.push({ label: "Snooze 1 hour", onSelect: () => patch.mutate({ action: "snooze", until: new Date(Date.now() + SNOOZE_MS).toISOString() }) });
  }
  actions.push({ label: "Skip for now", onSelect: onSkip });
  if (item.contactId) actions.push({ label: "Open contact", to: `/activity/contacts/${item.contactId}` });

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{label}</span>
          <ItemLabel item={item} />
        </div>
        <div className="truncate text-sm text-slate-500">{[item.company, dueText(item)].filter(Boolean).join(" · ")}</div>
        {patch.isError && (
          <p role="alert" className="text-sm text-red-600">
            {patch.error.message}
          </p>
        )}
      </div>
      <button
        type="button"
        className="btn-call"
        aria-label={`Call ${label}`}
        onClick={() => {
          onCall();
          void dialer.call(item.phoneE164, label);
        }}
      >
        Call
      </button>
      <MoreMenu label={`More for ${label}`} actions={actions} disabled={patch.isPending} />
    </li>
  );
}

function ListRow({ list }: { list: MyList }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{list.name}</span>
          <Badge tone="blue">Call list</Badge>
        </div>
        <div className="text-sm tabular-nums text-slate-500">{progressText(list.progress)} done</div>
      </div>
      <MoreMenu label={`More for ${list.name}`} actions={[{ label: "Open this list now", to: `/lists/${list.id}/work` }]} />
    </li>
  );
}

type MenuAction = { label: string; onSelect?: () => void; href?: string; to?: string };

/** A small "⋯" menu: Escape or a click outside closes it, focus moves into it on open. */
function MoreMenu({ label, actions, disabled }: { label: string; actions: MenuAction[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const down = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const cls = "flex min-h-11 w-full items-center px-4 text-left text-sm hover:bg-slate-100 focus:bg-slate-100 focus:outline-none";
  return (
    <div ref={root} className="relative">
      <button ref={btn} type="button" className="btn-ghost min-w-11 px-2" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden className="text-lg leading-none">
          ⋯
        </span>
      </button>
      {open && (
        <div role="menu" aria-label={label} className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {actions.map((a) =>
            a.href ? (
              <a key={a.label} role="menuitem" className={cls} href={a.href} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                {a.label}
              </a>
            ) : a.to ? (
              <Link key={a.label} role="menuitem" className={cls} to={a.to}>
                {a.label}
              </Link>
            ) : (
              <button
                key={a.label}
                role="menuitem"
                type="button"
                className={cls}
                onClick={() => {
                  setOpen(false);
                  a.onSelect?.();
                }}
              >
                {a.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Dial any number (replaces the old Dialer page); matching contacts appear as you type. */
function DialBox() {
  const { call } = useDialer();
  const [number, setNumber] = useState("");
  const q = useDeferredValue(number.trim());
  const search = useQuery({
    queryKey: ["contacts", "dialbox", q],
    queryFn: () => api<ContactPage>(`/api/contacts${qs({ q, limit: 5 })}`),
    enabled: q.length >= 3,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cleanNumber(number)) void call(number);
  };
  const matches = q.length >= 3 ? (search.data?.items ?? []) : [];
  return (
    <section aria-labelledby="dial-h" className="card p-4">
      <h2 id="dial-h" className="mb-2 font-semibold">
        Dial a number
      </h2>
      <form onSubmit={submit} className="flex gap-2">
        <label htmlFor="dial-num" className="sr-only">
          Number or name
        </label>
        <input
          id="dial-num"
          className="input min-w-0 flex-1"
          inputMode="tel"
          autoComplete="off"
          maxLength={40}
          placeholder="Number or name"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
        <button type="submit" className="btn-call" disabled={!cleanNumber(number)}>
          Call
        </button>
      </form>
      {matches.length > 0 && (
        <ul className="mt-2 divide-y divide-slate-100" aria-label="Matching contacts">
          {matches.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-1">
              <Link to={`/activity/contacts/${c.id}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                <span className="font-medium">{c.name || c.phoneE164}</span>
                {c.name && <span className="text-slate-500"> · {c.phoneE164}</span>}
              </Link>
              <CallButton phone={c.phoneE164} label={c.name || c.phoneE164} className="btn-ghost" dncReason={c.dnc?.reason} dnc={!!c.dnc} />
            </li>
          ))}
        </ul>
      )}
      {!isDesktopApp() && <p className="hint mt-2">In a browser, calls need Windows Phone Link set as the app for phone links.</p>}
    </section>
  );
}

function TargetBar({ label, value, target, pct }: { label: string; value: string; target: number | null; pct: number | null }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-semibold tabular-nums">
          {value}
          {target != null && <span className="font-normal text-slate-500"> / {target}</span>}
        </span>
      </div>
      {pct != null && (
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
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
        My day
      </h2>
      <TargetBar label="Calls" value={String(d.calls)} target={d.target.callsPerDay} pct={d.progress.callsPct} />
      <TargetBar label="Talk time (min)" value={String(Math.floor(d.talkTimeS / 60))} target={d.target.talkMinPerDay} pct={d.progress.talkPct} />
      <p className="text-xs text-slate-500">
        {d.connected} connected · {formatDuration(d.talkTimeS)} talk · {d.messages} messages
      </p>
    </section>
  );
}
