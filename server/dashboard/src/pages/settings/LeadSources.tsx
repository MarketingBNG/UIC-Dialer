import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, MoreHorizontal, Pencil, Plus, Power, Webhook } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { api, qs, type FieldMap, type LeadEventDto, type LeadSourceDto } from "../../api";
import { useMe } from "../../App";
import { UserMultiSelect, useAssignableUsers } from "../../components/UserPicker";
import { formatShortWhen, personName } from "../../format";
import { Empty, ErrorBox, FormError, Hint, Pill, Spinner, type Tone } from "../../ui";

const FIELDS: { key: keyof FieldMap; label: string; hint: string }[] = [
  { key: "phone", label: "Phone", hint: "phone, mobile, phone_number…" },
  { key: "name", label: "Name", hint: "name, full_name, SENDER_NAME…" },
  { key: "company", label: "Company", hint: "company, SENDER_COMPANY…" },
  { key: "city", label: "City", hint: "city, SENDER_CITY" },
  { key: "note", label: "Note", hint: "message, note, QUERY_MESSAGE…" },
];
// Red only for "someone must act": a lead nobody got. Do-not-call skips are expected.
const STATUS_TONE: Record<string, Tone> = {
  ASSIGNED: "green",
  EXISTING_OWNER: "blue",
  DNC: "gray",
  NO_REP: "red",
  INVALID: "amber",
};
const STATUS_TEXT: Record<string, string> = {
  ASSIGNED: "Given to a rep",
  EXISTING_OWNER: "Went to existing owner",
  DNC: "Skipped: Do not call",
  NO_REP: "No rep to give it to",
  INVALID: "Bad number",
};

type WithToken = LeadSourceDto & { token: string };

export function LeadSourcesTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["lead-sources"], queryFn: () => api<{ items: LeadSourceDto[] }>("/api/lead-sources") });
  const [editing, setEditing] = useState<LeadSourceDto | "new" | null>(null);
  const [token, setToken] = useState<WithToken | null>(null);
  const [rotating, setRotating] = useState<LeadSourceDto | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["lead-sources"] });
  const rotate = useMutation({
    mutationFn: (id: string) => api<WithToken>(`/api/lead-sources/${id}/rotate`, { method: "POST", body: {} }),
    onSuccess: (r) => {
      setRotating(null);
      setToken(r);
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (s: LeadSourceDto) => api(`/api/lead-sources/${s.id}`, { method: "PATCH", body: { active: !s.active } }),
    onSuccess: (_, s) => {
      toast.success(`${s.name} turned ${s.active ? "off" : "on"}.`);
      refresh();
    },
  });

  return (
    <>
      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle>Lead sources</CardTitle>
            <CardDescription>
              New leads from your website form, Facebook or IndiaMART go to reps in turn and show on their Today list. Give the address and token to
              whoever set up the form.
            </CardDescription>
          </div>
          <Button onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            Add source
          </Button>
        </CardHeader>
        <CardContent>
          {list.isPending ? (
            <Spinner label="Loading lead sources" />
          ) : list.isError ? (
            <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
          ) : list.data.items.length === 0 ? (
            <Empty
              icon={<Webhook />}
              action={
                <Button onClick={() => setEditing("new")}>
                  <Plus aria-hidden />
                  Add source
                </Button>
              }
            >
              No lead sources yet. Add one to get a webhook address for your website form or ad platform.
            </Empty>
          ) : (
            <ul className="divide-y">
              {list.data.items.map((s) => (
                <li key={s.id} className={cn("flex flex-wrap items-center gap-3 py-3 text-sm", !s.active && "opacity-60")}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.name}</span>
                      {!s.active && <Badge variant="gray">Inactive</Badge>}
                      <span className="font-mono text-xs text-muted-foreground">token …{s.tokenHint}</span>
                    </div>
                    <div className="text-muted-foreground">
                      {s.repPool.length ? `Goes to ${s.repPool.map(personName).join(", ")}` : "Goes to all reps"} · {s.stats.last7d} leads in 7 days
                      {s.stats.lastAt ? ` · last ${formatShortWhen(s.stats.lastAt)}` : ""}
                    </div>
                  </div>
                  <CopyButton label={`Address for ${s.name}`} value={s.webhookUrl} text="Copy address" />
                  <Button variant="outline" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                    <Pencil aria-hidden />
                    Edit
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`More actions for ${s.name}`}>
                        <MoreHorizontal aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => setRotating(s)}>
                        <KeyRound />
                        New token
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={toggle.isPending} onSelect={() => toggle.mutate(s)}>
                        <Power />
                        {s.active ? "Turn off" : "Turn on"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          )}
          <FormError error={toggle.error} />
        </CardContent>
      </Card>
      <LeadEvents sources={list.data?.items ?? []} />
      {editing && (
        <SourceDialog
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(r) => {
            refresh();
            if ("token" in r) setToken(r);
          }}
        />
      )}
      <AlertDialog open={!!rotating} onOpenChange={(o) => !o && !rotate.isPending && setRotating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make a new token?</AlertDialogTitle>
            <AlertDialogDescription>The current token of "{rotating?.name ?? ""}" stops working at once. Update the form or forwarder with the new one.</AlertDialogDescription>
          </AlertDialogHeader>
          <FormError error={rotate.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotate.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={rotate.isPending} onClick={() => rotating && rotate.mutate(rotating.id)}>
              {rotate.isPending ? "Working…" : "Make new token"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {token && <TokenDialog source={token} onClose={() => setToken(null)} />}
    </>
  );
}

function CopyButton({ label, value, text = "Copy" }: { label: string; value: string; text?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      aria-label={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          toast.success(`${label} copied.`);
        });
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copied" : text}
    </Button>
  );
}

function CopyBox({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-foreground">{label}</p>
      <div className="flex gap-2">
        <code className="block min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-lg bg-muted p-2 text-xs">{value}</code>
        <CopyButton label={label} value={value} />
      </div>
    </div>
  );
}

function TokenDialog({ source, onClose }: { source: WithToken; onClose: () => void }) {
  const curl = `curl -X POST '${source.webhookUrl}' \\\n  -H 'Authorization: Bearer ${source.token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name":"Priya Shah","phone":"+919876543210","city":"Pune","message":"Need a quote"}'`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="w-[min(40rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Connect {source.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Alert variant="warning">
            <KeyRound />
            <AlertDescription>Copy the token now. It is shown only once.</AlertDescription>
          </Alert>
          <CopyBox label="Address" value={source.webhookUrl} />
          <CopyBox label="Token" value={source.token} />
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">Advanced (for developers)</summary>
            <div className="mt-3 space-y-3">
              <CopyBox label="Example" value={curl} />
              <Hint>Send the token as a Bearer header or an X-UIC-Lead-Token header. Tokens in the URL are refused, because URLs end up in logs.</Hint>
            </div>
          </details>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SourceDialog({ initial, onClose, onSaved }: { initial: LeadSourceDto | null; onClose: () => void; onSaved: (r: LeadSourceDto | WithToken) => void }) {
  const me = useMe();
  const users = useAssignableUsers(me);
  const [name, setName] = useState(initial?.name ?? "");
  const [pool, setPool] = useState<string[]>(initial?.repPool.map((u) => u.id) ?? []);
  const [map, setMap] = useState<FieldMap>(initial?.fieldMap ?? {});
  const [active, setActive] = useState(initial?.active ?? true);
  const save = useMutation({
    mutationFn: () => {
      const fieldMap = Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, (v as string).trim()]));
      const body = { name: name.trim(), repPool: pool, fieldMap: Object.keys(fieldMap).length ? fieldMap : null, active };
      return initial ? api<LeadSourceDto>(`/api/lead-sources/${initial.id}`, { method: "PATCH", body }) : api<WithToken>("/api/lead-sources", { method: "POST", body });
    },
    onSuccess: (r) => {
      toast.success(initial ? "Lead source saved." : "Lead source added.");
      onSaved(r);
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent aria-describedby={undefined} className="w-[min(40rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit lead source" : "Add lead source"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="ls-name">Name</Label>
            <Input id="ls-name" maxLength={60} placeholder="Website, Facebook, IndiaMART…" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <UserMultiSelect label="Give these leads to (none picked = all reps, in turn)" users={users.items} value={pool} onChange={setPool} />
          <details className="rounded-lg border p-3" open={FIELDS.some((f) => !!map[f.key])}>
            <summary className="cursor-pointer text-sm font-medium">Advanced (for developers)</summary>
          <fieldset className="mt-3">
            <legend className="mb-1.5 text-sm font-medium text-foreground">Field names (optional)</legend>
            <Hint className="mb-2 mt-0">JSON keys in the posted lead; dot paths like data.mobile work. Leave empty to use the usual names.</Hint>
            <div className="grid gap-2 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <Label htmlFor={`ls-${f.key}`} className="text-xs text-muted-foreground">
                    {f.label}
                  </Label>
                  <Input id={`ls-${f.key}`} placeholder={f.hint} value={map[f.key] ?? ""} onChange={(e) => setMap((m) => ({ ...m, [f.key]: e.target.value }))} />
                </div>
              ))}
            </div>
          </fieldset>
          </details>
          <div className="flex min-h-11 items-center gap-2">
            <Checkbox id="ls-active" checked={active} onCheckedChange={(v) => setActive(v === true)} />
            <Label htmlFor="ls-active" className="mb-0 cursor-pointer">
              Active
            </Label>
          </div>
          <FormError error={save.error} />
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeadEvents({ sources }: { sources: LeadSourceDto[] }) {
  const [sourceId, setSourceId] = useState("");
  const events = useInfiniteQuery({
    queryKey: ["lead-events", sourceId],
    queryFn: ({ pageParam }) => api<{ items: LeadEventDto[]; nextCursor: string | null }>(`/api/lead-events${qs({ sourceId, cursor: pageParam, limit: 50 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = events.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card className="mt-4">
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-2">
        <CardTitle>Recent leads</CardTitle>
        <div className="w-full sm:w-56">
          <Label className="sr-only" htmlFor="le-src">
            Source
          </Label>
          <NativeSelect id="le-src" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </CardHeader>
      <CardContent>
        {events.isPending ? (
          <Spinner label="Loading leads" />
        ) : events.isError && items.length === 0 ? (
          <ErrorBox error={events.error} onRetry={() => void events.refetch()} />
        ) : items.length === 0 ? (
          <Empty>No leads yet. They appear here as soon as a source posts one.</Empty>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  {["When", "Source", "Contact", "Assigned to", "Status"].map((h) => (
                    <TableHead key={h} scope="col">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap">{formatShortWhen(e.createdAt)}</TableCell>
                    <TableCell>{e.source?.name ?? "Manual"}</TableCell>
                    <TableCell>{e.contact ? `${e.contact.name ?? ""} ${e.contact.phoneE164}`.trim() : "—"}</TableCell>
                    <TableCell>{e.assignedTo ? personName(e.assignedTo) : "—"}</TableCell>
                    <TableCell>
                      <Pill tone={STATUS_TONE[e.status] ?? "gray"}>{STATUS_TEXT[e.status] ?? e.status.replace("_", " ").toLowerCase()}</Pill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {events.hasNextPage && (
              <Button variant="outline" className="mt-3 w-full" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
                {events.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
