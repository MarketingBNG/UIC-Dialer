import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useDeferredValue, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { ApiError, api, qs, type ContactPage, type FollowUpItem, type FollowUpsToday, type MeToday, type MyList, type NextResponse } from "../api";
import { useMe } from "../App";
import { CallButton, cleanNumber, isDesktopApp, useDialer } from "../dialer";
import { formatDuration, formatShortWhen, whatsAppUrl } from "../format";
import {
  BellOff,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  ExternalLink,
  ListChecks,
  MessageCircle,
  MoreHorizontal,
  PartyPopper,
  Phone,
  SkipForward,
  User,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ContactStatusBadge, Empty, ErrorBox, FormError, Hint, PageHeader, Spinner } from "../ui";
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
type Entry = { kind: "fu"; key: string; group: Group } | { kind: "list"; key: string; list: MyList };

const rank = (i: FollowUpItem) => (i.overdue ? 0 : i.kind === "NEW_LEAD" ? 2 : 1);

/** Every open item for one phone number, shown as one queue entry. `item` is the most important one (earliest due, overdue if any is). */
type Group = { key: string; item: FollowUpItem; items: FollowUpItem[]; taskIds: string[]; count: string | null; more: number };

/** Label importance: overdue > missed call > due today > new lead. */
const labelRank = (i: FollowUpItem) => (i.overdue ? 0 : i.kind === "MISSED_CALL" ? 1 : i.kind === "NEW_LEAD" ? 3 : 2);
const NOUNS: Record<number, [string, string]> = { 0: ["overdue", "overdue"], 1: ["missed call", "missed calls"], 2: ["due today", "due today"], 3: ["new lead", "new leads"] };

/** One entry per phone number: items for the same number merge (most important label, earliest due time, a count when >1). */
export function groupByPhone(items: FollowUpItem[]): Group[] {
  const byPhone = new Map<string, FollowUpItem[]>();
  for (const i of items) byPhone.set(i.phoneE164, [...(byPhone.get(i.phoneE164) ?? []), i]);
  return [...byPhone.values()].map((g) => {
    const taskIds = g.map((i) => i.taskId).filter((t): t is string => !!t);
    if (g.length === 1) return { key: g[0]!.key, item: g[0]!, items: g, taskIds, count: null, more: 0 };
    const best = [...g].sort((a, b) => labelRank(a) - labelRank(b) || Date.parse(a.dueAt) - Date.parse(b.dueAt))[0]!;
    const r = labelRank(best);
    const same = g.filter((i) => labelRank(i) === r).length;
    const others = g.length - same;
    const earliest = g.reduce((a, b) => (Date.parse(b.dueAt) < Date.parse(a.dueAt) ? b : a)).dueAt;
    const item: FollowUpItem = {
      ...best,
      dueAt: earliest,
      overdue: g.some((i) => i.overdue),
      name: best.name ?? g.find((i) => i.name)?.name ?? null,
      company: best.company ?? g.find((i) => i.company)?.company ?? null,
      contactId: best.contactId ?? g.find((i) => i.contactId)?.contactId ?? null,
      lastNote: best.lastNote ?? g.find((i) => i.lastNote)?.lastNote ?? null,
    };
    return { key: `phone:${best.phoneE164}`, item, items: g, taskIds, count: same > 1 ? `${same} ${NOUNS[r]![1]}` : null, more: others };
  });
}
const remaining = (l: MyList) => l.progress.pending + l.progress.inProgress;

/** The single label a queue entry shows ("3 missed calls" when merged), plus "+N more" for other merged items. */
function GroupLabel({ group }: { group: Group }) {
  const { item, count, more } = group;
  const variant = item.overdue || item.kind === "MISSED_CALL" ? "red" : item.kind === "NEW_LEAD" ? "green" : "blue";
  return (
    <>
      {count ? <Badge variant={variant}>{count}</Badge> : <ItemLabel item={item} />}
      {more > 0 && <span className="text-xs text-muted-foreground">+{more} more</span>}
    </>
  );
}

/** The single label an item shows (overdue > missed call > due today > new lead). */
function ItemLabel({ item }: { item: FollowUpItem }) {
  if (item.overdue && item.kind !== "MISSED_CALL") return <Badge variant="red">Overdue</Badge>;
  if (item.kind === "MISSED_CALL") return <Badge variant="red">Missed call</Badge>;
  if (item.kind === "NEW_LEAD") return <Badge variant="green">New lead</Badge>;
  if (item.status) return <ContactStatusBadge status={item.status} />;
  return <Badge variant="blue">Follow-up</Badge>;
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

  const fuEntries: Entry[] = groupByPhone(fu.data?.items ?? [])
    .sort((a, b) => rank(a.item) - rank(b.item))
    .map((group) => ({ kind: "fu", key: group.key, group }));
  const listEntries: Entry[] = (lists.data?.items ?? [])
    .filter((l) => l.state === "ACTIVE" && remaining(l) > 0)
    .map((list) => ({ kind: "list", key: `list:${list.id}`, list }));
  const queue = [...fuEntries, ...listEntries].filter((e) => !handled.has(e.key));
  // ?call=<phone> (a clicked desktop reminder) puts that person first as Next up.
  const [params] = useSearchParams();
  const callFirst = params.get("call");
  if (callFirst) {
    const i = queue.findIndex((e) => e.kind === "fu" && e.group.item.phoneE164 === callFirst);
    if (i > 0) queue.unshift(...queue.splice(i, 1));
  }
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
            <Empty
              icon={<PartyPopper />}
              action={
                <Button variant="outline" asChild>
                  <Link to="/activity">
                    <User /> Browse contacts
                  </Link>
                </Button>
              }
            >
              <h2 className="text-lg font-semibold text-foreground">All caught up</h2>
              <p className="mt-1">
                Follow-ups you set after a call, missed calls, new leads and your call lists show up here. Dial any number on the right, or pick someone from Contacts.
              </p>
            </Empty>
          ) : next.kind === "fu" ? (
            <FollowUpNext key={next.key} group={next.group} onCall={() => startCall(next.key)} onSkip={() => handle(next.key)} />
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
    <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-full bg-secondary text-lg font-semibold text-secondary-foreground">
      {initials(name, phone)}
    </span>
  );
}

function NextCard({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <Card role="region" aria-labelledby="next-h" className="border-primary/30 p-5 shadow-md ring-1 ring-primary/10 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="next-h" className="text-xs font-semibold uppercase tracking-wide text-primary">
          Next up
        </h2>
        {aside}
      </div>
      {children}
    </Card>
  );
}

function BigCall({ onClick, text = "Call" }: { onClick: () => void; text?: string }) {
  return (
    <Button variant="call" size="lg" className="min-h-14 w-full text-lg" onClick={onClick}>
      <Phone className="size-5" aria-hidden />
      {text}
    </Button>
  );
}

/** Done / Snooze for every task merged into one entry (the existing per-task PATCH, once per task). */
function useTaskPatch(taskIds: string[], onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "done" | "snooze"; until?: string }) =>
      Promise.all(taskIds.map((id) => api(`/api/followups/${id}`, { method: "PATCH", body }))),
    onSuccess: () => onDone?.(),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["followups-today"] }),
  });
}

function FollowUpNext({ group, onCall, onSkip }: { group: Group; onCall: () => void; onSkip: () => void }) {
  const dialer = useDialer();
  const { item } = group;
  const patch = useTaskPatch(group.taskIds, onSkip);
  const label = item.name || item.phoneE164;
  const wa = whatsAppUrl(item.phoneE164);
  const onThisCall = dialer.pending?.phone === cleanNumber(item.phoneE164);

  return (
    <NextCard aside={<span className={`text-sm font-medium ${item.overdue ? "text-overdue" : "text-primary"}`}>{dueText(item)}</span>}>
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
            <GroupLabel group={group} />
          </div>
          <div className="truncate text-sm text-muted-foreground">{[item.name ? item.phoneE164 : null, item.company].filter(Boolean).join(" · ")}</div>
        </div>
      </div>
      {item.lastNote && (
        <div className="mt-4 rounded-lg bg-muted p-3 text-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last note</div>
          <p className="mt-1 whitespace-pre-line">{item.lastNote}</p>
        </div>
      )}
      <div className="mt-5">
        {onThisCall ? (
          <Button size="lg" className="min-h-14 w-full text-lg" onClick={dialer.openOutcome}>
            <ClipboardCheck className="size-5" /> Log outcome
          </Button>
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
          <Button variant="ghost" asChild>
            <a href={wa} target="_blank" rel="noreferrer">
              <MessageCircle /> WhatsApp
            </a>
          </Button>
        )}
        {group.taskIds.length > 0 && (
          <>
            <Button variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ action: "done" })}>
              <Check /> {group.taskIds.length > 1 ? `Mark all ${group.taskIds.length} done` : "Mark done"}
            </Button>
            <Button variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ action: "snooze", until: new Date(Date.now() + SNOOZE_MS).toISOString() })}>
              <BellOff /> Snooze 1 h
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={onSkip}>
          <SkipForward /> Skip for now
        </Button>
      </div>
      <FormError error={patch.isError ? patch.error : null} />
      <Hint className="mt-3 text-center">After you save the outcome, the next call comes up here.</Hint>
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
    <span className="text-sm text-muted-foreground">
      <Link to={`/lists/${list.id}/work`} className="font-medium text-primary hover:underline">
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
        {msg ? <p className="mt-3 text-sm text-muted-foreground">{msg}</p> : <ErrorBox error={e} onRetry={() => void next.refetch()} />}
        <Button variant="ghost" className="mt-2" onClick={onFinished}>
          <SkipForward /> Skip this list
        </Button>
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
            {c.dnc ? <Badge variant="red">Do not call</Badge> : <ContactStatusBadge status={c.status} />}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {[c.name ? c.phoneE164 : null, c.company, c.city].filter(Boolean).join(" · ")}
            {it.attempts > 0 ? ` · attempt ${it.attempts + 1}` : ""}
          </div>
        </div>
      </div>
      {it.lastOutcome && (
        <div className="mt-4 rounded-lg bg-muted p-3 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Last outcome</span> {it.lastOutcome.label}
        </div>
      )}
      <div className="mt-5">
        {onThisCall ? (
          <Button size="lg" className="min-h-14 w-full text-lg" onClick={dialer.openOutcome}>
            <ClipboardCheck className="size-5" /> Log outcome
          </Button>
        ) : (
          <BigCall onClick={() => void dialer.call(c.phoneE164, label, { callListItemId: it.id, listId: list.id, dncReason: c.dnc?.reason ?? null, dnc: !!c.dnc })} />
        )}
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-1">
        {whatsAppUrl(c.phoneE164) && (
          <Button variant="ghost" asChild>
            <a href={whatsAppUrl(c.phoneE164)!} target="_blank" rel="noreferrer">
              <MessageCircle /> WhatsApp
            </a>
          </Button>
        )}
        <Button variant="ghost" disabled={skip.isPending} onClick={() => skip.mutate(it.id)}>
          <SkipForward /> {skip.isPending ? "Skipping…" : "Skip"}
        </Button>
      </div>
      <FormError error={skip.error} />
      {script && script.sections.length > 0 && (
        <details className="mt-4 rounded-lg border p-3" open>
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">Script · {script.name}</summary>
          <div className="mt-2 space-y-3">
            {script.sections.map((s, i) => (
              <div key={i}>
                <div className="text-xs font-bold uppercase tracking-wide text-primary">{s.heading}</div>
                <p className="mt-1 whitespace-pre-line text-sm">{s.text}</p>
              </div>
            ))}
          </div>
        </details>
      )}
      <Hint className="mt-3 text-center">After you save the outcome, the next number comes up here.</Hint>
    </NextCard>
  );
}

function UpNext({ entries, onCall, onSkip }: { entries: Entry[]; onCall: (key: string) => void; onSkip: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, SHORT_LIST);
  return (
    <section aria-labelledby="upnext-h">
      <h2 id="upnext-h" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Up next · {entries.length}
      </h2>
      <Card className="divide-y overflow-hidden p-0">
        <ul className="divide-y">
          {shown.map((e) => (e.kind === "fu" ? <FollowUpRow key={e.key} group={e.group} onCall={() => onCall(e.key)} onSkip={() => onSkip(e.key)} /> : <ListRow key={e.key} list={e.list} />))}
        </ul>
      </Card>
      {entries.length > SHORT_LIST && (
        <Button variant="ghost" className="mt-2" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? <ChevronUp /> : <ChevronDown />}
          {all ? "Show fewer" : `Show all ${entries.length}`}
        </Button>
      )}
    </section>
  );
}

function FollowUpRow({ group, onCall, onSkip }: { group: Group; onCall: () => void; onSkip: () => void }) {
  const dialer = useDialer();
  const { item } = group;
  const patch = useTaskPatch(group.taskIds);
  const label = item.name || item.phoneE164;
  const wa = whatsAppUrl(item.phoneE164);
  const actions: MenuAction[] = [];
  if (wa) actions.push({ label: "WhatsApp", icon: MessageCircle, href: wa });
  if (group.taskIds.length > 0) {
    actions.push({ label: group.taskIds.length > 1 ? `Mark all ${group.taskIds.length} done` : "Mark done", icon: Check, onSelect: () => patch.mutate({ action: "done" }) });
    actions.push({ label: "Snooze 1 hour", icon: BellOff, onSelect: () => patch.mutate({ action: "snooze", until: new Date(Date.now() + SNOOZE_MS).toISOString() }) });
  }
  actions.push({ label: "Skip for now", icon: SkipForward, onSelect: onSkip });
  if (item.contactId) actions.push({ label: "Open contact", icon: User, to: `/activity/contacts/${item.contactId}` });

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{label}</span>
          <GroupLabel group={group} />
        </div>
        <div className="truncate text-sm text-muted-foreground">{[item.company, dueText(item)].filter(Boolean).join(" · ")}</div>
        <FormError error={patch.isError ? patch.error : null} />
      </div>
      <Button
        variant="outline"
        className="min-h-11"
        aria-label={`Call ${label}`}
        onClick={() => {
          onCall();
          void dialer.call(item.phoneE164, label);
        }}
      >
        <Phone className="text-success" /> Call
      </Button>
      <MoreMenu label={`More for ${label}`} actions={actions} disabled={patch.isPending} />
    </li>
  );
}

function ListRow({ list }: { list: MyList }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{list.name}</span>
          <Badge variant="blue">Call list</Badge>
        </div>
        <div className="text-sm tabular-nums text-muted-foreground">{progressText(list.progress)} done</div>
      </div>
      <MoreMenu label={`More for ${list.name}`} actions={[{ label: "Open this list now", icon: ListChecks, to: `/lists/${list.id}/work` }]} />
    </li>
  );
}

type MenuAction = { label: string; icon: LucideIcon; onSelect?: () => void; href?: string; to?: string };

/** The "⋯" menu on a queue row (shadcn DropdownMenu). */
function MoreMenu({ label, actions, disabled }: { label: string; actions: MenuAction[]; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-11" aria-label={label} disabled={disabled}>
          <MoreHorizontal className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label={label}>
        {actions.map((a, i) => {
          const Icon = a.icon;
          const sep = a.to && i > 0 ? <DropdownMenuSeparator /> : null;
          return a.href ? (
            <DropdownMenuItem key={a.label} asChild>
              <a href={a.href} target="_blank" rel="noreferrer">
                <Icon /> {a.label}
                <ExternalLink className="ml-auto" />
              </a>
            </DropdownMenuItem>
          ) : a.to ? (
            <Fragment key={a.label}>
              {sep}
              <DropdownMenuItem asChild>
                <Link to={a.to}>
                  <Icon /> {a.label}
                </Link>
              </DropdownMenuItem>
            </Fragment>
          ) : (
            <DropdownMenuItem key={a.label} onSelect={() => a.onSelect?.()}>
              <Icon /> {a.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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
    <Card role="region" aria-labelledby="dial-h">
      <CardHeader className="pb-0">
        <CardTitle id="dial-h" className="flex items-center gap-2 text-base">
          <Phone aria-hidden className="size-4 text-muted-foreground" /> Dial a number
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
      <form onSubmit={submit} className="flex gap-2">
        <Label htmlFor="dial-num" className="sr-only">
          Number or name
        </Label>
        <Input
          id="dial-num"
          className="min-w-0 flex-1"
          inputMode="tel"
          autoComplete="off"
          maxLength={40}
          placeholder="Number or name"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
        />
        <Button type="submit" variant="outline" disabled={!cleanNumber(number)}>
          <Phone className="text-success" /> Call
        </Button>
      </form>
      {matches.length > 0 && (
        <ul className="mt-2 divide-y" aria-label="Matching contacts">
          {matches.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-1">
              <Link to={`/activity/contacts/${c.id}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                <span className="font-medium">{c.name || c.phoneE164}</span>
                {c.name && <span className="text-muted-foreground"> · {c.phoneE164}</span>}
              </Link>
              <CallButton phone={c.phoneE164} label={c.name || c.phoneE164} variant="ghost" dncReason={c.dnc?.reason} dnc={!!c.dnc} />
            </li>
          ))}
        </ul>
      )}
      {!isDesktopApp() && <Hint className="mt-2">In a browser, calls need Windows Phone Link set as the app for phone links.</Hint>}
      </CardContent>
    </Card>
  );
}

function TargetBar({ label, value, target, pct }: { label: string; value: string; target: number | null; pct: number | null }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">
          {value}
          {target != null && <span className="font-normal text-muted-foreground"> / {target}</span>}
        </span>
      </div>
      {pct != null && (
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
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
    <Card role="region" aria-labelledby="targets-h" className="space-y-3 p-5">
      <h2 id="targets-h" className="font-semibold">
        My day
      </h2>
      <TargetBar label="Calls" value={String(d.calls)} target={d.target.callsPerDay} pct={d.progress.callsPct} />
      <TargetBar label="Talk time (min)" value={String(Math.floor(d.talkTimeS / 60))} target={d.target.talkMinPerDay} pct={d.progress.talkPct} />
      <p className="text-xs text-muted-foreground">
        {d.connected} connected · {formatDuration(d.talkTimeS)} talk · {d.messages} messages
      </p>
    </Card>
  );
}
