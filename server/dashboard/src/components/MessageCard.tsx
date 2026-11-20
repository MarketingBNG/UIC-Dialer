import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, renderTemplate, repName, type Contact, type MessageChannel, type TemplateDto } from "../api";
import { useMe } from "../App";
import { whatsAppUrl } from "../format";
import { isDesktopApp } from "../dialer";
import { MessageSquare, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { FormError, Hint } from "../ui";

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
    <Card role="region" aria-labelledby="msg-h">
      <CardHeader>
        <CardTitle id="msg-h" className="flex items-center gap-2">
          <MessageSquare aria-hidden className="size-4 text-muted-foreground" /> Send WhatsApp / SMS
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs
          value={channel}
          onValueChange={(v) => {
            setChannel(v as MessageChannel);
            setTemplateId("");
          }}
        >
          <TabsList aria-label="Channel">
            <TabsTrigger value="WHATSAPP">WhatsApp</TabsTrigger>
            <TabsTrigger value="SMS">SMS</TabsTrigger>
          </TabsList>
        </Tabs>
        <div>
          <Label htmlFor="msg-tpl">Template</Label>
          <NativeSelect id="msg-tpl" value={templateId} onChange={(e) => pick(e.target.value)}>
            <option value="">Write my own</option>
            {usable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div>
          <Label htmlFor="msg-text">Message</Label>
          <Textarea id="msg-text" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          <Hint>You can edit it before sending. It opens in {channel === "WHATSAPP" ? "WhatsApp" : "your SMS app"}; press send there.</Hint>
        </div>
        <Button variant="call" className="w-full" disabled={!text.trim() || (channel === "WHATSAPP" && !wa) || log.isPending} onClick={send}>
          <Send /> {channel === "WHATSAPP" ? "Open in WhatsApp" : "Open in SMS app"}
        </Button>
        {log.isSuccess && <p className="text-sm text-emerald-700">Logged on the timeline.</p>}
        <FormError error={log.error ? `Opened, but not logged: ${log.error.message}` : null} />
      </CardContent>
    </Card>
  );
}
