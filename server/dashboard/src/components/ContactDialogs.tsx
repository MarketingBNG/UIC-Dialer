import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type * as React from "react";
import { useNavigate } from "react-router";
import { ApiError, api, isManager, type ListSummary, type NewLeadResult } from "../api";
import { useMe } from "../App";
import { personName } from "../format";
import { Check, FileUp, ListPlus, UserPlus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "../ui";
import { CsvImportView, importCount, useCsvImport } from "./CsvImport";
import { useAssignableUsers } from "./UserPicker";

/** CSV import (managers): preview with auto-matched columns, optional owner and list, then import. */
export function ImportDialog({ onClose, onList }: { onClose: () => void; onList: (ids: string[]) => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const users = useAssignableUsers(me);
  const lists = useQuery({ queryKey: ["call-lists", ""], queryFn: () => api<{ items: ListSummary[] }>("/api/call-lists") });
  const csv = useCsvImport();
  const [ownerId, setOwnerId] = useState("");
  const [listId, setListId] = useState("");
  const n = importCount(csv.preview.data);
  const done = csv.run.data;
  const go = () =>
    csv.run.mutate(
      { ownerId: ownerId || null, ...(listId ? { listId } : {}) },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: ["contacts"] });
          void qc.invalidateQueries({ queryKey: ["call-lists"] });
        },
      },
    );
  return (
    <Dialog open onOpenChange={(o) => !o && !csv.run.isPending && onClose()}>
      <DialogContent className="w-[min(40rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp aria-hidden className="size-5 text-primary" /> Import contacts from CSV
          </DialogTitle>
          <DialogDescription>Choose a CSV file. Columns are matched automatically; check the preview before importing.</DialogDescription>
        </DialogHeader>
        {done ? (
          <Alert variant="success">
            <Check />
            <AlertDescription>
              Done: {done.created} created, {done.updated} updated, {done.skipped} skipped
              {done.ownedElsewhere ? `, ${done.ownedElsewhere} left alone (another team's contacts)` : ""}
              {done.dncSkippedFromList ? `, ${done.dncSkippedFromList} do-not-call numbers left off the list` : ""}.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-3">
            <CsvImportView state={csv} />
            {csv.preview.data && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="imp-owner">Owner of new contacts</Label>
                  <NativeSelect id="imp-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                    <option value="">No owner</option>
                    {users.items.map((u) => (
                      <option key={u.id} value={u.id}>
                        {personName(u)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div>
                  <Label htmlFor="imp-list">Add to list (optional)</Label>
                  <NativeSelect id="imp-list" value={listId} onChange={(e) => setListId(e.target.value)}>
                    <option value="">Don&apos;t add</option>
                    {lists.data?.items.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            )}
            <FormError error={csv.run.error} />
          </div>
        )}
        <DialogFooter>
          {done ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              {!listId && done.contactIds.length > 0 && (
                <Button onClick={() => onList(done.contactIds)}>
                  <ListPlus /> Create list from these
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="outline" disabled={csv.run.isPending} onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!n || csv.preview.isPending || csv.run.isPending} onClick={go}>
                <FileUp /> {csv.run.isPending ? "Importing…" : `Import ${n} contacts`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Manual new lead (POST /api/contacts). Managers choose Auto (round-robin), themselves or a rep; reps get it themselves. */
export function NewLeadDialog({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const manager = isManager(me.role);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const users = useAssignableUsers(me);
  const [f, setF] = useState({ phone: "", name: "", company: "", city: "", note: "" });
  const [assignTo, setAssignTo] = useState<string>(manager ? "auto" : me.id);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = { phone: f.phone.trim() };
      for (const k of ["name", "company", "city", "note"] as const) if (f[k].trim()) body[k] = f[k].trim();
      if (manager) body["assignTo"] = assignTo;
      return api<NewLeadResult>("/api/contacts", { method: "POST", body });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["contacts"] });
      void qc.invalidateQueries({ queryKey: ["followups-today"] });
      navigate(`/activity/contacts/${r.contact.id}`);
    },
  });
  const exists = save.error instanceof ApiError && save.error.code === "EXISTS";
  const field = (k: keyof typeof f, label: string, extra: React.ComponentProps<typeof Input> = {}) => (
    <div>
      <Label htmlFor={`nlead-${k}`}>{label}</Label>
      <Input id={`nlead-${k}`} maxLength={200} value={f[k]} onChange={(e) => set(k, e.target.value)} {...extra} />
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus aria-hidden className="size-5 text-primary" /> New lead
          </DialogTitle>
          <DialogDescription>Only the phone number is required.</DialogDescription>
        </DialogHeader>
        <form
          id="nlead-form"
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.phone.trim() && !save.isPending) save.mutate();
          }}
        >
          {field("phone", "Phone", { inputMode: "tel", maxLength: 40, required: true, autoFocus: true })}
          {field("name", "Name")}
          {field("company", "Company")}
          {field("city", "City")}
          <div className="sm:col-span-2">
            <Label htmlFor="nlead-note">Note</Label>
            <Textarea id="nlead-note" rows={2} maxLength={2000} value={f.note} onChange={(e) => set("note", e.target.value)} />
          </div>
          {manager && (
            <div className="sm:col-span-2">
              <Label htmlFor="nlead-assign">Assign to</Label>
              <NativeSelect id="nlead-assign" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                <option value="auto">Auto (next rep in turn)</option>
                <option value={me.id}>Me</option>
                {users.items
                  .filter((u) => u.id !== me.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {personName(u)}
                    </option>
                  ))}
              </NativeSelect>
            </div>
          )}
        </form>
        <FormError error={save.error ? (exists ? "This number is already a contact of another rep." : save.error) : null} />
        <DialogFooter>
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="nlead-form" disabled={!f.phone.trim() || save.isPending}>
            <UserPlus /> {save.isPending ? "Saving…" : "Add lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
