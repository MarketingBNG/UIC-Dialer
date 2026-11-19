import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, qs, type FieldMap, type LeadEventDto, type LeadSourceDto } from "../../api";
import { useMe } from "../../App";
import { UserMultiSelect, useAssignableUsers } from "../../components/UserPicker";
import { formatShortWhen, personName } from "../../format";
import { Badge, ConfirmDialog, Empty, ErrorBox, Modal, Spinner } from "../../ui";

const FIELDS: { key: keyof FieldMap; label: string; hint: string }[] = [
  { key: "phone", label: "Phone", hint: "phone, mobile, phone_number…" },
  { key: "name", label: "Name", hint: "name, full_name, SENDER_NAME…" },
  { key: "company", label: "Company", hint: "company, SENDER_COMPANY…" },
  { key: "city", label: "City", hint: "city, SENDER_CITY" },
  { key: "note", label: "Note", hint: "message, note, QUERY_MESSAGE…" },
];
const STATUS_TONE: Record<string, "green" | "blue" | "red" | "amber" | "gray"> = {
  ASSIGNED: "green",
  EXISTING_OWNER: "blue",
  DNC: "red",
  NO_REP: "amber",
  INVALID: "red",
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
    onSuccess: refresh,
  });

  return (
    <>
      <section className="card p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">Lead sources</h2>
            <p className="hint">
              Each source gets a webhook token. Website forms, Facebook or IndiaMART (through Zapier, Make or their webhook) post JSON leads to it; each lead
              goes to the next rep in the pool, round-robin, and shows on their Today list.
            </p>
          </div>
          <button type="button" className="btn-primary" onClick={() => setEditing("new")}>
            Add source
          </button>
        </div>
        {list.isPending ? (
          <Spinner label="Loading lead sources" />
        ) : list.isError ? (
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
        ) : list.data.items.length === 0 ? (
          <div className="mt-3">
            <Empty>No lead sources yet.</Empty>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
            {list.data.items.map((s) => (
              <li key={s.id} className={`flex flex-wrap items-center gap-3 py-3 text-sm ${s.active ? "" : "opacity-60"}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    {!s.active && <Badge>Inactive</Badge>}
                    <span className="font-mono text-xs text-slate-500">token …{s.tokenHint}</span>
                  </div>
                  <div className="text-slate-500">
                    {s.repPool.length ? `Pool: ${s.repPool.map(personName).join(", ")}` : "Pool: all active reps"} · {s.stats.last7d} leads in 7 days
                    {s.stats.lastAt ? ` · last ${formatShortWhen(s.stats.lastAt)}` : ""}
                  </div>
                </div>
                <button type="button" className="btn-ghost" onClick={() => setEditing(s)}>
                  Edit
                </button>
                <button type="button" className="btn-ghost" onClick={() => setRotating(s)}>
                  New token
                </button>
                <button type="button" className="btn-ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(s)}>
                  {s.active ? "Turn off" : "Turn on"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {toggle.error && <p className="text-sm text-red-600 dark:text-red-400">{toggle.error.message}</p>}
      </section>
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
      <ConfirmDialog
        open={!!rotating}
        title="Make a new token?"
        body={`The current token of "${rotating?.name ?? ""}" stops working at once. Update the form or forwarder with the new one.`}
        confirmLabel="Make new token"
        busy={rotate.isPending}
        error={rotate.error}
        onClose={() => setRotating(null)}
        onConfirm={() => rotating && rotate.mutate(rotating.id)}
      />
      {token && <TokenDialog source={token} onClose={() => setToken(null)} />}
    </>
  );
}

function CopyBox({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="label">{label}</div>
      <div className="flex gap-2">
        <code className="block min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-lg bg-slate-100 p-2 text-xs dark:bg-slate-800">{value}</code>
        <button
          type="button"
          className="btn-outline"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function TokenDialog({ source, onClose }: { source: WithToken; onClose: () => void }) {
  const curl = `curl -X POST '${source.webhookUrl}' \\\n  -H 'Authorization: Bearer ${source.token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"name":"Priya Shah","phone":"+919876543210","city":"Pune","message":"Need a quote"}'`;
  return (
    <Modal
      open
      title={`Webhook for ${source.name}`}
      onClose={onClose}
      footer={
        <button type="button" className="btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="space-y-3">
        <p className="rounded-lg bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-100">Copy the token now. It is shown only once.</p>
        <CopyBox label="Webhook URL" value={source.webhookUrl} />
        <CopyBox label="Token" value={source.token} />
        <CopyBox label="Example" value={curl} />
        <p className="hint">Send the token as a Bearer header or an X-UIC-Lead-Token header. Tokens in the URL are refused, because URLs end up in logs.</p>
      </div>
    </Modal>
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
      return initial
        ? api<LeadSourceDto>(`/api/lead-sources/${initial.id}`, { method: "PATCH", body })
        : api<WithToken>("/api/lead-sources", { method: "POST", body });
    },
    onSuccess: (r) => {
      onSaved(r);
      onClose();
    },
  });
  return (
    <Modal
      open
      title={initial ? "Edit lead source" : "Add lead source"}
      onClose={() => !save.isPending && onClose()}
      footer={
        <>
          <button type="button" className="btn-ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label" htmlFor="ls-name">
            Name
          </label>
          <input id="ls-name" className="input" maxLength={60} placeholder="Website, Facebook, IndiaMART…" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <UserMultiSelect label="Rep pool (none selected = all active reps)" users={users.items} value={pool} onChange={setPool} />
        <fieldset>
          <legend className="label">Field map (optional)</legend>
          <p className="hint mb-2">JSON keys in the posted lead; dot paths like data.mobile work. Leave empty to use the usual names.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="text-xs font-medium text-slate-600 dark:text-slate-400" htmlFor={`ls-${f.key}`}>
                  {f.label}
                </label>
                <input id={`ls-${f.key}`} className="input" placeholder={f.hint} value={map[f.key] ?? ""} onChange={(e) => setMap((m) => ({ ...m, [f.key]: e.target.value }))} />
              </div>
            ))}
          </div>
        </fieldset>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-brand-600" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        {save.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {save.error.message}
          </p>
        )}
      </div>
    </Modal>
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
    <section className="card mt-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="font-semibold">Recent leads</h2>
        <div>
          <label className="sr-only" htmlFor="le-src">
            Source
          </label>
          <select id="le-src" className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {events.isPending ? (
        <Spinner label="Loading leads" />
      ) : events.isError && items.length === 0 ? (
        <ErrorBox error={events.error} onRetry={() => void events.refetch()} />
      ) : items.length === 0 ? (
        <div className="mt-3">
          <Empty>No leads yet.</Empty>
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <tr>
                {["When", "Source", "Contact", "Assigned to", "Status"].map((h) => (
                  <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-3 py-2">{formatShortWhen(e.createdAt)}</td>
                  <td className="px-3 py-2">{e.source?.name ?? "Manual"}</td>
                  <td className="px-3 py-2">{e.contact ? `${e.contact.name ?? ""} ${e.contact.phoneE164}`.trim() : "—"}</td>
                  <td className="px-3 py-2">{e.assignedTo ? personName(e.assignedTo) : "—"}</td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[e.status] ?? "gray"}>{e.status.replace("_", " ").toLowerCase()}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.hasNextPage && (
            <button type="button" className="btn-outline mt-3 w-full" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
              {events.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
