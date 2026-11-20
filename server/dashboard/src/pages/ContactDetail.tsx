import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, isManager, type Activity, type Contact, type ContactDetail, type ContactPatch, type ContactStatus, type DncDto, type DncPage, type TimelineItem, type User } from "../api";
import { useMe } from "../App";
import { CONTACT_STATUS_LABEL, OUTCOME_LABEL, formatDuration, formatWhen, fromLocalInput, isOverdue, personName, toLocalInput } from "../format";
import { CallButton } from "../dialer";
import { MessageCard } from "../components/MessageCard";
import { OutcomeChip } from "../components/Outcomes";
import { ArrowLeft, Ban, Save, StickyNote, Undo2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ContactStatusBadge, DirectionTag, ErrorBox, FormError, PageHeader, Spinner, StatusBadge, ViaTag } from "../ui";

export function ContactDetailPage() {
  const { id = "" } = useParams();
  const detail = useQuery({ queryKey: ["contact", id], queryFn: () => api<ContactDetail>(`/api/contacts/${id}`) });

  if (detail.isPending) return <Spinner label="Loading contact" />;
  if (detail.isError) return <ErrorBox error={detail.error} onRetry={() => void detail.refetch()} />;
  const { contact, timeline } = detail.data;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2 text-muted-foreground">
        <Link to="/activity">
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
            {contact.source && <Badge variant="gray">{contact.source === "csv" ? "CSV import" : contact.source === "manual" ? "Manual lead" : contact.source}</Badge>}
          </span>
        }
        actions={
          <>
            <CallButton variant="call" phone={contact.phoneE164} label={contact.name || contact.phoneE164} dncReason={contact.dnc?.reason} dnc={!!contact.dnc} />
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
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <EditCard key={JSON.stringify(contact)} detail={detail.data} />
          <MessageCard contact={contact} />
          <NoteCard contactId={contact.id} />
        </div>
        <Timeline items={timeline} />
      </div>
    </>
  );
}

function EditCard({ detail }: { detail: ContactDetail }) {
  const me = useMe();
  const manager = isManager(me.role);
  const qc = useQueryClient();
  const c = detail.contact;
  const [name, setName] = useState(c.name ?? "");
  const [company, setCompany] = useState(c.company ?? "");
  const [city, setCity] = useState(c.city ?? "");
  const [status, setStatus] = useState<ContactStatus>(c.status);
  const [followUp, setFollowUp] = useState(toLocalInput(c.nextFollowUpAt));
  const [ownerId, setOwnerId] = useState(c.owner?.id ?? "");
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<User[]>("/api/users"), enabled: manager });
  // Managers may only assign to themselves or their own team (the server enforces the same rule).
  const owners = users.data?.filter((u) => me.role === "ADMIN" || u.id === me.id || (!!me.team && u.team === me.team));

  const save = useMutation({
    mutationFn: (body: ContactPatch) => api(`/api/contacts/${c.id}`, { method: "PATCH", body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contact", c.id] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: ContactPatch = {};
    if (name.trim() !== (c.name ?? "")) body.name = name.trim() || null;
    if (company.trim() !== (c.company ?? "")) body.company = company.trim() || null;
    if (city.trim() !== (c.city ?? "")) body.city = city.trim() || null;
    if (status !== c.status) body.status = status;
    const fu = fromLocalInput(followUp);
    if (followUp !== toLocalInput(c.nextFollowUpAt)) body.nextFollowUpAt = fu;
    if (manager && ownerId && ownerId !== (c.owner?.id ?? "")) body.ownerId = ownerId;
    if (Object.keys(body).length) save.mutate(body);
  };

  return (
    <Card className="p-4">
    <form onSubmit={submit} className="space-y-3" aria-labelledby="edit-h">
      <h2 id="edit-h" className="font-semibold">
        Details
      </h2>
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
      <div>
        <Label htmlFor="ct-fu">
          Next follow-up
        </Label>
        <Input id="ct-fu" type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        {isOverdue(c.nextFollowUpAt) && <p className="mt-1 text-xs text-muted-foreground font-medium text-destructive">Overdue since {formatWhen(c.nextFollowUpAt)}</p>}
        {followUp && (
          <Button variant="link" size="sm" className="h-auto min-h-9 px-0 text-xs" onClick={() => setFollowUp("")}>
            Clear follow-up
          </Button>
        )}
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
        <Save /> {save.isPending ? "Saving…" : "Save details"}
      </Button>
    </form>
    </Card>
  );
}

function NoteCard({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState("");
  const followUpAt = fromLocalInput(followUp);
  const add = useMutation({
    mutationFn: () =>
      api<Activity>(`/api/contacts/${contactId}/notes`, {
        method: "POST",
        body: { note: note.trim(), ...(followUpAt ? { followUpAt } : {}) },
      }),
    onSuccess: () => {
      setNote("");
      setFollowUp("");
      void qc.invalidateQueries({ queryKey: ["contact", contactId] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
  return (
    <Card className="p-4">
    <form
      className="space-y-3"
      aria-labelledby="note-h"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim()) add.mutate();
      }}
    >
      <h2 id="note-h" className="font-semibold">
        Add a note
      </h2>
      <div>
        <Label className="sr-only" htmlFor="nt-text">
          Note
        </Label>
        <Textarea id="nt-text" className="min-h-24 py-2" maxLength={2000} required value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="nt-fu">
          Follow up on (optional)
        </Label>
        <Input id="nt-fu" type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        <p className="mt-1 text-xs text-muted-foreground">Setting a date marks the contact as Call back.</p>
      </div>
      <FormError error={add.error} />
      <Button type="submit" variant="outline" className="w-full" disabled={add.isPending || !note.trim()}>
        <StickyNote /> {add.isPending ? "Adding…" : "Add note"}
      </Button>
    </form>
    </Card>
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

function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <Card className="p-4">
    <section aria-labelledby="tl-h">
      <h2 id="tl-h" className="mb-3 font-semibold">
        Timeline
      </h2>
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
