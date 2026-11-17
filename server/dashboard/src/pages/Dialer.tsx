import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { api, qs, type ContactPage, type ContactListItem } from "../api";
import { CallButton, cleanNumber, isDesktopApp, useDialer } from "../dialer";
import { formatWhen, isOverdue } from "../format";
import { ContactStatusBadge, Empty, ErrorBox, PageHeader, Spinner } from "../ui";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "0", "⌫"];

export function DialerPage() {
  const { call } = useDialer();
  const [number, setNumber] = useState("");
  const q = useDeferredValue(number.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cleanNumber(number)) call(number);
  };
  const press = (k: string) => setNumber((n) => (k === "⌫" ? n.slice(0, -1) : n + k));

  return (
    <>
      <PageHeader title="Dialer" subtitle="Calls go out on your phone's SIM through Phone Link; you talk on this computer." />
      {!isDesktopApp() && (
        <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Calling from the browser needs Windows Phone Link set as the app for phone links. See the UIC Dialer setup guide.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <form onSubmit={submit} className="card space-y-3 p-4" aria-label="Dial a number">
          <label className="label" htmlFor="dial-num">
            Number or search
          </label>
          <input
            id="dial-num"
            className="input text-center text-xl tracking-wide"
            inputMode="tel"
            autoComplete="off"
            autoFocus
            maxLength={40}
            placeholder="+91 98765 43210"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <button key={k} type="button" className="btn-outline py-3 text-lg" aria-label={k === "⌫" ? "Delete" : k} onClick={() => press(k)}>
                {k}
              </button>
            ))}
          </div>
          <button type="submit" className="btn-primary w-full py-3" disabled={!cleanNumber(number)}>
            Call
          </button>
        </form>
        <div className="space-y-4">
          {q ? <ContactList title="Matching contacts" params={{ q, limit: 20 }} empty="No saved contact matches. Press Call to dial it." /> : null}
          <ContactList title="Follow-ups due today" params={{ due: "today", limit: 20 }} empty="Nothing due today." />
          <ContactList title="Overdue" params={{ due: "overdue", limit: 20 }} empty="No overdue follow-ups." />
        </div>
      </div>
    </>
  );
}

function ContactList({ title, params, empty }: { title: string; params: Record<string, string | number>; empty: string }) {
  const list = useQuery({
    queryKey: ["contacts", "dialer", params],
    queryFn: () => api<ContactPage>(`/api/contacts${qs(params)}`),
  });
  return (
    <section className="card p-4" aria-label={title}>
      <h2 className="mb-2 font-semibold">{title}</h2>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.items.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {list.data.items.map((c) => (
            <Row key={c.id} c={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({ c }: { c: ContactListItem }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <Link to={`/activity/contacts/${c.id}`} className="min-w-0 flex-1 hover:underline">
        <div className="truncate font-medium">{c.name || c.phoneE164}</div>
        <div className="truncate text-sm text-slate-500">
          {[c.name ? c.phoneE164 : null, c.company].filter(Boolean).join(" · ")}
          {c.nextFollowUpAt && (
            <span className={isOverdue(c.nextFollowUpAt) ? "text-red-600 dark:text-red-400" : ""}> · follow up {formatWhen(c.nextFollowUpAt)}</span>
          )}
        </div>
      </Link>
      <ContactStatusBadge status={c.status} />
      <CallButton phone={c.phoneE164} label={c.name || c.phoneE164} />
    </li>
  );
}
