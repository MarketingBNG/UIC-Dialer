import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, api, isManager, type ListSummary, type NewLeadResult } from "../api";
import { useMe } from "../App";
import { personName } from "../format";
import { Modal } from "../ui";
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
    <Modal
      open
      title="Import contacts from CSV"
      onClose={() => !csv.run.isPending && onClose()}
      footer={
        done ? (
          <>
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
            {!listId && done.contactIds.length > 0 && (
              <button type="button" className="btn-primary" onClick={() => onList(done.contactIds)}>
                Create list from these
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" className="btn-ghost" disabled={csv.run.isPending} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={!n || csv.preview.isPending || csv.run.isPending} onClick={go}>
              {csv.run.isPending ? "Importing…" : `Import ${n} contacts`}
            </button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-emerald-700 dark:text-emerald-400">
          Done: {done.created} created, {done.updated} updated, {done.skipped} skipped
          {done.ownedElsewhere ? `, ${done.ownedElsewhere} left alone (another team's contacts)` : ""}
          {done.dncSkippedFromList ? `, ${done.dncSkippedFromList} do-not-call numbers left off the list` : ""}.
        </p>
      ) : (
        <div className="space-y-3">
          <CsvImportView state={csv} />
          {csv.preview.data && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="imp-owner">
                  Owner of new contacts
                </label>
                <select id="imp-owner" className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  <option value="">No owner</option>
                  {users.items.map((u) => (
                    <option key={u.id} value={u.id}>
                      {personName(u)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="imp-list">
                  Add to list (optional)
                </label>
                <select id="imp-list" className="input" value={listId} onChange={(e) => setListId(e.target.value)}>
                  <option value="">Don't add</option>
                  {lists.data?.items.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {csv.run.error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {csv.run.error.message}
            </p>
          )}
        </div>
      )}
    </Modal>
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
  return (
    <Modal
      open
      title="New lead"
      onClose={() => !save.isPending && onClose()}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!f.phone.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Add lead"}
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="nlead-phone">
            Phone
          </label>
          <input id="nlead-phone" className="input" inputMode="tel" maxLength={40} required value={f.phone} onChange={(e) => set("phone", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="nlead-name">
            Name
          </label>
          <input id="nlead-name" className="input" maxLength={200} value={f.name} onChange={(e) => set("name", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="nlead-company">
            Company
          </label>
          <input id="nlead-company" className="input" maxLength={200} value={f.company} onChange={(e) => set("company", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="nlead-city">
            City
          </label>
          <input id="nlead-city" className="input" maxLength={200} value={f.city} onChange={(e) => set("city", e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="nlead-note">
            Note
          </label>
          <textarea id="nlead-note" className="input py-2" rows={2} maxLength={2000} value={f.note} onChange={(e) => set("note", e.target.value)} />
        </div>
        {manager && (
          <div className="sm:col-span-2">
            <label className="label" htmlFor="nlead-assign">
              Assign
            </label>
            <select id="nlead-assign" className="input" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
              <option value="auto">Auto (next rep in turn)</option>
              <option value={me.id}>Me</option>
              {users.items
                .filter((u) => u.id !== me.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {personName(u)}
                  </option>
                ))}
            </select>
          </div>
        )}
      </div>
      {save.error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {exists ? "This number is already a contact of another rep." : save.error.message}
        </p>
      )}
    </Modal>
  );
}
