import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, isManager, type Activity, type Contact, type ContactDetail, type ContactPatch, type ContactStatus, type DncDto, type DncPage, type TimelineItem, type User } from "../api";
import { useMe } from "../App";
import { CONTACT_STATUS_LABEL, OUTCOME_LABEL, formatDuration, formatWhen, fromLocalInput, isOverdue, personName, toLocalInput } from "../format";
import { CallButton } from "../dialer";
import { MessageCard } from "../components/MessageCard";
import { OutcomeChip } from "../components/Outcomes";
import { ArrowLeft, Ban, CalendarClock, MessageCircle, Pencil, Save, StickyNote, Undo2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ContactStatusBadge, DirectionTag, ErrorBox, FormError, PageHeader, Spinner, StatusBadge, ViaTag } from "../ui";

export function ContactDetailPage() {
  const { id = "" } = useParams();
  const detail = useQuery({ queryKey: ["contact", id], queryFn: () => api<ContactDetail>(`/api/contacts/${id}`) });
  const [editing, setEditing] = useState(false);

  if (detail.isPending) return <Spinner label="Loading contact" />;
  if (detail.isError) return <ErrorBox error={detail.error} onRetry={() => void detail.refetch()} />;
  const { contact, timeline } = detail.data;
  // WhatsApp goes through the message box so the send is still logged on the timeline.
  const showMessage = () => {
    const el = document.getElementById("message-card");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.querySelector<HTMLElement>("textarea, select, button")?.focus({ preventScroll: true });
  };

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground">
        <Link to="/contacts">
          <ArrowLeft /> Contacts
        </Link>
      </Button>
      <PageHeader
        title={contact.name || contact.phoneE164}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {contact.name && <span>{contact.phoneE164}</span>}
            {contact.company && <span>· {contact.company}</span>}
            {contact.city && <span>· {contact.city}</span>}
            <ContactStatusBadge status={contact.status} />
            {contact.dnc && <Badge variant="red">Do not call</Badge>}
            {contact.owner && <span>· Owner: {personName(contact.owner)}</span>}
          </span>
        }
        actions={
          <>
            <CallButton variant="call" phone={contact.phoneE164} label={contact.name || contact.phoneE164} dncReason={contact.dnc?.reason} dnc={!!contact.dnc} />
            <Button variant="outline" onClick={showMessage}>
              <MessageCircle /> WhatsApp
            </Button>
            <FollowUpPick contact={contact} />
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
            <DncAction contact={contact} />
          </>
        }
      />
      {contact.dnc && (
        <Alert variant="destructive" className="mb-4">
          <Ban />
          <AlertTitle>Do not call</AlertTitle>
          <AlertDescription>
            This number is on the do-not-call list{contact.dnc.reason ? `: ${contact.dnc.reason}` : ""} (since {formatWhen(contact.dnc.createdAt)}).
          </AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <LastCall items={timeline} />
          <Timeline items={timeline} contactId={contact.id} />
        </div>
        <div id="message-card" className="space-y-2">
          <MessageCard contact={contact} />
          {contact.source && (
            <p className="text-xs text-muted-foreground">
              Added from {contact.source === "csv" ? "a CSV import" : contact.source === "manual" ? "a manual lead" : contact.source}
            </p>
          )}
        </div>
      </div>
      <Sheet open={editing} onOpenChange={setEditing}>
        <SheetContent side="right" className="w-96 overflow-y-auto bg-background p-4 pt-5">
          <SheetTitle className="text-lg font-semibold">Edit contact</SheetTitle>
          <SheetDescription className="mb-3 text-sm text-muted-foreground">{contact.phoneE164}</SheetDescription>
          <EditCard key={JSON.stringify(contact)} detail={detail.data} onSaved={() => setEditing(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Local time `days` from now at 10:00, the usual morning call slot. */
function daysAt10(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

/** The one place to set the next follow-up: quick picks, or a date and time. */
function FollowUpPick({ contact }: { contact: Contact }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState("");
  const save = useMutation({
    mutationFn: (nextFollowUpAt: string | null) => api(`/api/contacts/${contact.id}`, { method: "PATCH", body: { nextFollowUpAt } satisfies ContactPatch }),
    onSuccess: () => {
      setPicking(false);
      void qc.invalidateQueries({ queryKey: ["contact", contact.id] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
  const fu = contact.nextFollowUpAt;
  const overdue = isOverdue(fu);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" disabled={save.isPending} className={overdue ? "border-destructive text-destructive" : undefined}>
            <CalendarClock /> {save.isPending ? "Saving…" : fu ? `Follow up ${formatWhen(fu)}${overdue ? " · overdue" : ""}` : "Set follow-up"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => save.mutate(daysAt10(1))}>Tomorrow</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => save.mutate(daysAt10(2))}>In 2 days</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => save.mutate(daysAt10(7))}>Next week</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setWhen(toLocalInput(fu));
              setPicking(true);
            }}
          >
            Pick a date…
          </DropdownMenuItem>
          {fu && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => save.mutate(null)}>Clear follow-up</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {save.error && !picking && <span className="self-center text-sm text-destructive">{save.error.message}</span>}
      <Dialog open={picking} onOpenChange={(o) => !save.isPending && setPicking(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Follow up on</DialogTitle>
            <DialogDescription>Pick when to call {contact.name || contact.phoneE164} next.</DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="fu-when">Date and time</Label>
            <Input id="fu-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          <FormError error={save.error} />
          <DialogFooter>
            <Button variant="outline" disabled={save.isPending} onClick={() => setPicking(false)}>
              Cancel
            </Button>
            <Button disabled={save.isPending || !when} onClick={() => save.mutate(fromLocalInput(when))}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type LastCallInfo = { id: string | null; when: string; user: { name: string | null; email: string }; summary: string | null; activity?: Extract<TimelineItem, { kind: "activity" }> };

/** The latest call on top, so the rep sees what was said last before calling again. */
function LastCall({ items }: { items: TimelineItem[] }) {
  const calls: LastCallInfo[] = [];
  for (const t of items) {
    if (t.kind === "call") calls.push({ id: t.id, when: t.startedAt, user: t.user, summary: t.summary });
    else if (t.type === "CALL") calls.push({ id: t.call?.id ?? t.callId ?? null, when: t.occurredAt, user: t.user, summary: t.call?.summary ?? null, activity: t });
  }
  const latest = calls.sort((a, b) => b.when.localeCompare(a.when))[0];
  if (!latest) return null;
  const a = latest.activity;
  return (
    <Card className="p-4">
      <section aria-labelledby="lc-h">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="lc-h" className="font-semibold">
            Last call
          </h2>
          {a?.outcome && a.outcomeLabel && <OutcomeChip label={a.outcomeLabel} color={a.outcomeColor} />}
          {a?.outcome && !a.outcomeLabel && <Badge variant="gray">{OUTCOME_LABEL[a.outcome]}</Badge>}
          {latest.id && (
            <Link to={`/calls/${latest.id}`} className="ml-auto text-sm text-primary hover:underline">
              Open call
            </Link>
          )}
        </div>
        <Meta when={latest.when} user={latest.user} />
        {a?.note && <p className="mt-2 whitespace-pre-line text-sm">{a.note}</p>}
        {latest.summary ? <Summary text={latest.summary} /> : !a?.note && <p className="mt-2 text-sm text-muted-foreground">No summary for this call.</p>}
      </section>
    </Card>
  );
}

function EditCard({ detail, onSaved }: { detail: ContactDetail; onSaved: () => void }) {
  const me = useMe();
  const manager = isManager(me.role);
  const qc = useQueryClient();
  const c = detail.contact;
  const [name, setName] = useState(c.name ?? "");
  const [company, setCompany] = useState(c.company ?? "");
  const [city, setCity] = useState(c.city ?? "");
  const [status, setStatus] = useState<ContactStatus>(c.status);
  const [ownerId, setOwnerId] = useState(c.owner?.id ?? "");
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users"), enabled: manager });
  // Managers may only assign to themselves or their own team (the server enforces the same rule).
  const owners = users.data?.filter((u) => me.role === "ADMIN" || u.id === me.id || (!!me.team && u.team === me.team));

  const save = useMutation({
    mutationFn: (body: ContactPatch) => api(`/api/contacts/${c.id}`, { method: "PATCH", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contact", c.id] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
      onSaved();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: ContactPatch = {};
    if (name.trim() !== (c.name ?? "")) body.name = name.trim() || null;
    if (company.trim() !== (c.company ?? "")) body.company = company.trim() || null;
    if (city.trim() !== (c.city ?? "")) body.city = city.trim() || null;
    if (status !== c.status) body.status = status;
    if (manager && ownerId && ownerId !== (c.owner?.id ?? "")) body.ownerId = ownerId;
    if (Object.keys(body).length) save.mutate(body);
    else onSaved();
  };

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Contact details">
      <div>
        <Label htmlFor="ct-name">
          Name
        </Label>
        <Input id="ct-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="ct-company">
          Company
        </Label>
        <Input id="ct-company" maxLength={200} value={company} onChange={(e) => setCompany(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="ct-city">
          City
        </Label>
        <Input id="ct-city" maxLength={200} value={city} onChange={(e) => setCity(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="ct-status">
          Status
        </Label>
        <NativeSelect id="ct-status" value={status} onChange={(e) => setStatus(e.target.value as ContactStatus)}>
          {(Object.keys(CONTACT_STATUS_LABEL) as ContactStatus[]).map((s) => (
            <option key={s} value={s}>
              {CONTACT_STATUS_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      </div>
      {manager ? (
        <div>
          <Label htmlFor="ct-owner">
            Owner
          </Label>
          <NativeSelect id="ct-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {!ownerId && <option value="">No owner</option>}
            {c.owner && !owners?.some((u) => u.id === c.owner?.id) && <option value={c.owner.id}>{personName(c.owner)}</option>}
            {owners?.map((u) => (
              <option key={u.id} value={u.id}>
                {personName(u)}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Owner: {c.owner ? personName(c.owner) : "—"}</p>
      )}
      <FormError error={save.error} />
      <Button type="submit" className="w-full" disabled={save.isPending}>
        <Save /> {save.isPending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

/** Inline note box at the top of the timeline. Follow-ups are set from the header, not here. */
function NoteBox({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const add = useMutation({
    mutationFn: () => api<Activity>(`/api/contacts/${contactId}/notes`, { method: "POST", body: { note: note.trim() } }),
    onSuccess: () => {
      setNote("");
      void qc.invalidateQueries({ queryKey: ["contact", contactId] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
  return (
    <form
      className="mb-4 space-y-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (note.trim()) add.mutate();
      }}
    >
      <Label className="sr-only" htmlFor="nt-text">
        Add a note
      </Label>
      <Textarea id="nt-text" className="min-h-16 py-2" maxLength={2000} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} />
      <FormError error={add.error} />
      {note.trim() && (
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={add.isPending}>
            <StickyNote /> {add.isPending ? "Adding…" : "Add note"}
          </Button>
        </div>
      )}
    </form>
  );
}

const TYPE_LABEL = { CALL: "Call logged", WHATSAPP: "WhatsApp chat opened", NOTE: "Note" } as const;

/** Activity title; WHATSAPP activities carry the channel (SMS is logged as WHATSAPP with channel "SMS"). */
function typeLabel(item: Activity) {
  if (item.type === "WHATSAPP") {
    if (item.channel === "SMS") return item.templateId || item.note ? "SMS sent" : "SMS opened";
    if (item.channel === "WHATSAPP" && item.templateId) return "WhatsApp message sent";
  }
  return TYPE_LABEL[item.type];
}

/** "Mark do-not-call" for anyone; "Remove from DNC" for managers (the delete is a managers' endpoint). */
function DncAction({ contact }: { contact: Contact }) {
  const me = useMe();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["contact", contact.id] });
    void qc.invalidateQueries({ queryKey: ["contacts"] });
    void qc.invalidateQueries({ queryKey: ["dnc"] });
  };
  const mark = useMutation({
    mutationFn: () => api<DncDto>("/api/dnc", { method: "POST", body: { phone: contact.phoneE164, reason: reason.trim() || undefined } }),
    onSuccess: () => {
      setOpen(false);
      setReason("");
      refresh();
    },
  });
  const unmark = useMutation({
    mutationFn: async () => {
      const digits = contact.phoneE164.replace(/\D/g, "").slice(-10);
      const page = await api<DncPage>(`/api/dnc?q=${encodeURIComponent(digits)}&limit=50`);
      const row = page.items.find((d) => (d.phoneE164 ?? d.raw).replace(/\D/g, "").endsWith(digits));
      if (!row) throw new Error("Not found on the do-not-call list");
      await api<void>(`/api/dnc/${row.id}`, { method: "DELETE" });
    },
    onSuccess: refresh,
  });
  if (contact.dnc) {
    if (!isManager(me.role)) return null;
    return (
      <>
        <Button variant="outline" disabled={unmark.isPending} onClick={() => unmark.mutate()}>
          <Undo2 /> {unmark.isPending ? "Removing…" : "Remove from do-not-call"}
        </Button>
        {unmark.error && <span className="self-center text-sm text-destructive">{unmark.error.message}</span>}
      </>
    );
  }
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Ban /> Mark do-not-call
      </Button>
      <Dialog open={open} onOpenChange={(o) => !mark.isPending && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark do-not-call?</DialogTitle>
            <DialogDescription>{contact.phoneE164} is taken off call lists and gets a warning before anyone dials it.</DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="dnc-why">Reason (optional)</Label>
            <Input id="dnc-why" maxLength={200} placeholder="Asked not to be called" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <FormError error={mark.error} />
          <DialogFooter>
            <Button variant="outline" disabled={mark.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={mark.isPending} onClick={() => mark.mutate()}>
              {mark.isPending ? "Saving…" : "Mark do-not-call"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Timeline({ items, contactId }: { items: TimelineItem[]; contactId: string }) {
  return (
    <Card className="p-4">
    <section aria-labelledby="tl-h">
      <h2 id="tl-h" className="mb-3 font-semibold">
        Timeline
      </h2>
      <NoteBox contactId={contactId} />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet. Calls, messages and notes for this number will show up here.</p>
      ) : (
        <ol className="space-y-3">
          {items.map((t) => (
            <li key={`${t.kind}-${t.id}`} className="border-l-2 pl-3">
              {t.kind === "call" ? <CallEntry item={t} /> : <ActivityEntry item={t} />}
            </li>
          ))}
        </ol>
      )}
    </section>
    </Card>
  );
}

function Meta({ when, user }: { when: string; user: { name: string | null; email: string } }) {
  return (
    <div className="text-xs text-muted-foreground">
      {formatWhen(when)} · {personName(user)}
    </div>
  );
}

function Summary({ text }: { text: string | null }) {
  return text ? <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{text}</p> : null;
}

function CallEntry({ item }: { item: Extract<TimelineItem, { kind: "call" }> }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/calls/${item.id}`} className="font-medium text-primary hover:underline">
          Recorded call
        </Link>
        <DirectionTag direction={item.direction} />
        <ViaTag via={item.via} />
        <span className="text-sm tabular-nums">{formatDuration(item.durationS)}</span>
        <StatusBadge status={item.status} />
        {!item.hasAudio && <Badge variant="gray">No audio</Badge>}
      </div>
      <Meta when={item.startedAt} user={item.user} />
      <Summary text={item.summary} />
    </div>
  );
}

function ActivityEntry({ item }: { item: Extract<TimelineItem, { kind: "activity" }> }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{typeLabel(item)}</span>
        {item.type === "WHATSAPP" && item.channel && <Badge variant={item.channel === "SMS" ? "blue" : "green"}>{item.channel === "SMS" ? "SMS" : "WhatsApp"}</Badge>}
        {item.outcome && item.outcomeLabel && <OutcomeChip label={item.outcomeLabel} color={item.outcomeColor} />}
        {item.outcome && !item.outcomeLabel && <Badge variant={item.outcome === "INTERESTED" ? "green" : item.outcome === "NOT_INTERESTED" ? "red" : item.outcome === "NO_ANSWER" ? "amber" : "blue"}>{OUTCOME_LABEL[item.outcome]}</Badge>}
        {item.type === "CALL" && item.durationS != null && <span className="text-sm tabular-nums">{formatDuration(item.durationS)}</span>}
        {item.type === "CALL" && <ViaTag via={item.via} />}
        {item.call && (
          <>
            <Link to={`/calls/${item.call.id}`} className="text-sm text-primary hover:underline">
              Open recording
            </Link>
            <StatusBadge status={item.call.status} />
            {!item.call.hasAudio && <Badge variant="gray">No audio</Badge>}
          </>
        )}
        {!item.call && item.callId && (
          <Link to={`/calls/${item.callId}`} className="text-sm text-primary hover:underline">
            Open recording
          </Link>
        )}
      </div>
      <Meta when={item.occurredAt} user={item.user} />
      {item.note && <p className="mt-1 whitespace-pre-line text-sm">{item.note}</p>}
      {item.followUpAt && <p className="mt-1 text-sm text-muted-foreground">Follow up: {formatWhen(item.followUpAt)}</p>}
      {item.call && <Summary text={item.call.summary} />}
    </div>
  );
}
