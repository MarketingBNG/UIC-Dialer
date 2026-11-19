import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, renderTemplate, repName, type Contact, type MessageChannel, type TemplateDto } from "../api";
import { useMe } from "../App";
import { whatsAppUrl } from "../format";
import { isDesktopApp } from "../dialer";

/**
 * "Send WhatsApp / SMS" from a template. Nothing is sent silently: the link opens WhatsApp (wa.me) or the SMS app
 * prefilled, the rep presses send there, and the send is logged as a WHATSAPP activity with its channel.
 */
export function MessageCard({ contact }: { contact: Contact }) {
  const me = useMe();
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ["templates"], queryFn: () => api<{ items: TemplateDto[] }>("/api/templates"), staleTime: 5 * 60_000 });
  const [channel, setChannel] = useState<MessageChannel>("WHATSAPP");
  const [templateId, setTemplateId] = useState("");
  const [text, setText] = useState("");
  const usable = (templates.data?.items ?? []).filter((t) => t.active && (channel === "WHATSAPP" ? t.whatsapp : t.sms));
  const wa = whatsAppUrl(contact.phoneE164);

  const log = useMutation({
    mutationFn: (body: { channel: MessageChannel; templateId?: string; note: string }) =>
      api("/api/activities", {
        method: "POST",
        body: {
          clientId: crypto.randomUUID(),
          phone: contact.phoneE164,
          type: "WHATSAPP",
          channel: body.channel,
          templateId: body.templateId,
          note: body.note.slice(0, 2000),
          occurredAt: new Date().toISOString(),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contact", contact.id] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
      void qc.invalidateQueries({ queryKey: ["followups-today"] });
    },
  });

  const pick = (id: string) => {
    setTemplateId(id);
    const t = usable.find((x) => x.id === id);
    setText(t ? renderTemplate(t.body, contact.name, repName(me)) : "");
  };

  const send = () => {
    const msg = text.trim();
    if (!msg) return;
    // Open the app inside the click (pop-up rules), then log.
    if (channel === "WHATSAPP") {
      if (!wa) return;
      window.open(`${wa}?text=${encodeURIComponent(msg)}`, "_blank", "noopener");
    } else {
      // Best effort on desktop: a registered SMS app handles sms: links. Like tel: in the dialer, the desktop shell
      // only sees window.open'd links; a browser follows the link itself.
      const url = `sms:${contact.phoneE164}?body=${encodeURIComponent(msg)}`;
      if (isDesktopApp()) window.open(url);
      else window.location.href = url;
    }
    log.mutate({ channel, note: msg, ...(templateId ? { templateId } : {}) });
  };

  return (
    <section className="card space-y-3 p-4" aria-labelledby="msg-h">
      <h2 id="msg-h" className="font-semibold">
        Send WhatsApp / SMS
      </h2>
      <div role="group" aria-label="Channel" className="inline-flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
        {(
          [
            ["WHATSAPP", "WhatsApp"],
            ["SMS", "SMS"],
          ] as const
        ).map(([v, l]) => (
          <button
            key={v}
            type="button"
            aria-pressed={channel === v}
            className={`min-h-9 rounded-md px-3 text-sm font-medium ${channel === v ? "bg-brand-600 text-white" : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"}`}
            onClick={() => {
              setChannel(v);
              setTemplateId("");
            }}
          >
            {l}
          </button>
        ))}
      </div>
      <div>
        <label className="label" htmlFor="msg-tpl">
          Template
        </label>
        <select id="msg-tpl" className="input" value={templateId} onChange={(e) => pick(e.target.value)}>
          <option value="">Write my own</option>
          {usable.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label" htmlFor="msg-text">
          Message
        </label>
        <textarea id="msg-text" className="input py-2" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
        <p className="hint">You can edit it before sending. It opens in {channel === "WHATSAPP" ? "WhatsApp" : "your SMS app"}; press send there.</p>
      </div>
      <button type="button" className="btn-call w-full" disabled={!text.trim() || (channel === "WHATSAPP" && !wa) || log.isPending} onClick={send}>
        {channel === "WHATSAPP" ? "Open in WhatsApp" : "Open in SMS app"}
      </button>
      {log.isSuccess && <p className="text-sm text-emerald-700 dark:text-emerald-400">Logged on the timeline.</p>}
      {log.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          Opened, but not logged: {log.error.message}
        </p>
      )}
    </section>
  );
}
