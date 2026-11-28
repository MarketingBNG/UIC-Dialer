import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, renderTemplate, repName, type TemplateDto } from "../../api";
import { useMe } from "../../App";
import { Empty, ErrorBox, FormError, Hint, Spinner } from "../../ui";

export function TemplatesTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["templates", "all"], queryFn: () => api<{ items: TemplateDto[] }>("/api/templates?all=1") });
  const [editing, setEditing] = useState<TemplateDto | "new" | null>(null);
  const [deleting, setDeleting] = useState<TemplateDto | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["templates"] });
  const del = useMutation({
    mutationFn: (id: string) => api<void>(`/api/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Template deleted.");
      setDeleting(null);
      refresh();
    },
  });
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Message templates</CardTitle>
          <CardDescription>
            Reps pick these to send a WhatsApp or SMS. Use <code>{"{name}"}</code> for the contact's first name and <code>{"{rep}"}</code> for the rep's.
          </CardDescription>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus aria-hidden />
          New template
        </Button>
      </CardHeader>
      <CardContent>
        {list.isPending ? (
          <Spinner label="Loading templates" />
        ) : list.isError ? (
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <Empty
            icon={<MessageSquare />}
            action={
              <Button onClick={() => setEditing("new")}>
                <Plus aria-hidden />
                New template
              </Button>
            }
          >
            No templates yet. Add one so reps can send a follow-up message in one tap.
          </Empty>
        ) : (
          <ul className="divide-y">
            {list.data.items.map((t) => (
              <li key={t.id} className={cn("flex flex-wrap items-start gap-2 py-3 text-sm", !t.active && "opacity-60")}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    {t.whatsapp && <Badge variant="green">WhatsApp</Badge>}
                    {t.sms && <Badge variant="blue">SMS</Badge>}
                    {!t.active && <Badge variant="gray">Inactive</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 whitespace-pre-line text-muted-foreground">{t.body}</p>
                </div>
                <Button variant="ghost" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                  <Pencil aria-hidden />
                  Edit
                </Button>
                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}>
                  <Trash2 aria-hidden />
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing && <TemplateDialog key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && !del.isPending && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>"{deleting?.name ?? ""}" is removed for everyone. Past messages keep their text.</AlertDialogDescription>
          </AlertDialogHeader>
          <FormError error={del.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={del.isPending} onClick={() => deleting && del.mutate(deleting.id)}>
              {del.isPending ? "Working…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function CheckField({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex min-h-11 items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      <Label htmlFor={id} className="mb-0 cursor-pointer">
        {label}
      </Label>
    </div>
  );
}

function TemplateDialog({ initial, onClose, onSaved }: { initial: TemplateDto | null; onClose: () => void; onSaved: () => void }) {
  const me = useMe();
  const [name, setName] = useState(initial?.name ?? "");
  const [body, setBody] = useState(initial?.body ?? "Hi {name}, this is {rep} from UIC. ");
  const [whatsapp, setWhatsapp] = useState(initial?.whatsapp ?? true);
  const [sms, setSms] = useState(initial?.sms ?? true);
  const [active, setActive] = useState(initial?.active ?? true);
  const ok = !!name.trim() && !!body.trim() && (whatsapp || sms);
  const save = useMutation({
    mutationFn: () => {
      const b = { name: name.trim(), body: body.trim(), whatsapp, sms, active };
      return initial ? api<TemplateDto>(`/api/templates/${initial.id}`, { method: "PATCH", body: b }) : api<TemplateDto>("/api/templates", { method: "POST", body: b });
    },
    onSuccess: () => {
      toast.success(initial ? "Template saved." : "Template created.");
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{initial ? "Edit template" : "New template"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="tp-name">Name</Label>
            <Input id="tp-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="tp-body">Message</Label>
            <Textarea id="tp-body" rows={5} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
            <Hint>{body.length}/1000</Hint>
          </div>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-foreground">Channels</legend>
            <div className="flex flex-wrap gap-x-5">
              <CheckField id="tp-wa" label="WhatsApp" checked={whatsapp} onChange={setWhatsapp} />
              <CheckField id="tp-sms" label="SMS" checked={sms} onChange={setSms} />
              <CheckField id="tp-active" label="Active" checked={active} onChange={setActive} />
            </div>
          </fieldset>
          {!whatsapp && !sms && <p className="text-sm text-warning-text">Pick at least one channel.</p>}
          <div>
            <p className="mb-1.5 text-sm font-medium text-foreground">Preview (to Priya Shah)</p>
            <p className="whitespace-pre-line rounded-lg bg-success-soft p-3 text-sm text-foreground">{renderTemplate(body, "Priya Shah", repName(me))}</p>
          </div>
          <FormError error={save.error} />
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
