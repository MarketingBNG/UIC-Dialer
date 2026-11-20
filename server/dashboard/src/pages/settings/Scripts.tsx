import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, type ScriptDto, type ScriptSection } from "../../api";
import { formatShortWhen } from "../../format";
import { Empty, ErrorBox, FormError, Spinner } from "../../ui";

type ScriptRow = ScriptDto & { listCount: number };
const DEFAULT_SECTIONS: ScriptSection[] = [
  { heading: "Open", text: "" },
  { heading: "Ask", text: "" },
  { heading: "If busy", text: "" },
];

export function ScriptsTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["scripts"], queryFn: () => api<{ items: ScriptRow[] }>("/api/scripts") });
  const [editing, setEditing] = useState<ScriptRow | "new" | null>(null);
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Call scripts</CardTitle>
          <CardDescription>Shown to reps while they work a call list. AI scoring checks calls against the list's script.</CardDescription>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus aria-hidden />
          New script
        </Button>
      </CardHeader>
      <CardContent>
        {list.isPending ? (
          <Spinner label="Loading scripts" />
        ) : list.isError ? (
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <Empty
            action={
              <Button onClick={() => setEditing("new")}>
                <Plus aria-hidden />
                New script
              </Button>
            }
          >
            No scripts yet. Write one so reps know what to say on each call list.
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Sections</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <span className="flex flex-wrap items-center gap-2">
                      {s.name}
                      {!s.active && <Badge variant="gray">Inactive</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{s.sections.length}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.listCount} list{s.listCount === 1 ? "" : "s"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatShortWhen(s.updatedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                      <Pencil aria-hidden />
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {editing && (
        <ScriptDialog
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ["scripts"] })}
        />
      )}
    </Card>
  );
}

function ScriptDialog({ initial, onClose, onSaved }: { initial: ScriptDto | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [sections, setSections] = useState<ScriptSection[]>(initial?.sections.length ? initial.sections : DEFAULT_SECTIONS);
  const setSec = (i: number, k: keyof ScriptSection, v: string) => setSections((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const clean = sections.map((s) => ({ heading: s.heading.trim(), text: s.text.trim() })).filter((s) => s.heading || s.text);
  const ok = !!name.trim() && clean.length >= 1 && clean.length <= 10 && clean.every((s) => s.heading && s.heading.length <= 40 && s.text.length <= 2000);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), sections: clean, active };
      return initial ? api<ScriptDto>(`/api/scripts/${initial.id}`, { method: "PATCH", body }) : api<ScriptDto>("/api/scripts", { method: "POST", body });
    },
    onSuccess: () => {
      toast.success(initial ? "Script saved." : "Script created.");
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="w-[min(40rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit script" : "New script"}</DialogTitle>
          <DialogDescription>Short sections with a heading each, such as Open, Ask and If busy.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="sc-name">Name</Label>
            <Input id="sc-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {sections.map((s, i) => (
            <fieldset key={i} className="space-y-2 rounded-lg border p-3">
              <legend className="sr-only">Section {i + 1}</legend>
              <div className="flex gap-2">
                <Input aria-label={`Section ${i + 1} heading`} className="font-semibold" maxLength={40} placeholder="Heading" value={s.heading} onChange={(e) => setSec(i, "heading", e.target.value)} />
                <Button variant="ghost" size="icon" aria-label={`Remove section ${i + 1}`} disabled={sections.length <= 1} onClick={() => setSections((xs) => xs.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden />
                </Button>
              </div>
              <Textarea aria-label={`Section ${i + 1} text`} rows={3} maxLength={2000} value={s.text} onChange={(e) => setSec(i, "text", e.target.value)} />
            </fieldset>
          ))}
          <Button variant="outline" disabled={sections.length >= 10} onClick={() => setSections((xs) => [...xs, { heading: "", text: "" }])}>
            <Plus aria-hidden />
            Add section
          </Button>
          <div className="flex min-h-11 items-center gap-2">
            <Checkbox id="sc-active" checked={active} onCheckedChange={(v) => setActive(v === true)} />
            <Label htmlFor="sc-active" className="mb-0 cursor-pointer">
              Active
            </Label>
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
