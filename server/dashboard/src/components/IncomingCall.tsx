import { useQuery } from "@tanstack/react-query";
import { PhoneIncoming, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useNavigate } from "react-router";
import { BASE } from "@/lib/motion";
import { api, type ContactPage } from "../api";
import { CONTACT_STATUS_LABEL } from "../format";
import { Button } from "@/components/ui/button";

/** What the rep's phone reports (see server/src/realtime.ts, POST /v1/ringing). */
export interface RingEvent {
  state: "ringing" | "answered" | "ended";
  phone: string | null;
}

/** LiveUpdates re-dispatches the server's "ringing" stream events as this window event. */
export const RING_EVENT = "uic-ringing";

/** How long the card stays after the call ends (time to open the contact). */
const AFTER_END_MS = 15_000;

/**
 * Caller card on the desktop: when the rep's phone rings, show who is calling from the CRM, next to Phone Link's
 * own Answer pop-up. Stays while the call is on, and a short while after it ends.
 */
export function IncomingCall() {
  const [ring, setRing] = useState<{ phone: string; state: RingEvent["state"] } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigate = useNavigate();

  useEffect(() => {
    const onRing = (e: Event) => {
      const r = (e as CustomEvent<RingEvent>).detail;
      clearTimeout(hideTimer.current);
      if (r.state === "ringing" && r.phone) setRing({ phone: r.phone, state: "ringing" });
      else if (r.state === "answered") setRing((cur) => (cur ? { ...cur, state: "answered" } : cur));
      else if (r.state === "ended") {
        setRing((cur) => (cur ? { ...cur, state: "ended" } : cur));
        hideTimer.current = setTimeout(() => setRing(null), AFTER_END_MS);
      }
    };
    window.addEventListener(RING_EVENT, onRing);
    return () => {
      window.removeEventListener(RING_EVENT, onRing);
      clearTimeout(hideTimer.current);
    };
  }, []);

  const lookup = useQuery({
    queryKey: ["incoming-caller", ring?.phone],
    queryFn: () => api<ContactPage>(`/api/contacts?q=${encodeURIComponent(ring!.phone)}&limit=1`),
    enabled: !!ring?.phone,
    staleTime: 60_000,
  });
  const contact = lookup.data?.items.find((c) => c.phoneE164 === ring?.phone) ?? lookup.data?.items[0] ?? null;

  const title = ring?.state === "ringing" ? "Incoming call" : ring?.state === "answered" ? "On a call" : "Call ended";

  return (
    <AnimatePresence>
      {ring && (
        <m.div
          key="incoming-call"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={BASE}
          role="status"
          aria-live="polite"
          className="fixed right-4 top-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-background p-4 shadow-lg"
        >
          <div className="flex items-start gap-3">
            <PhoneIncoming className={`mt-0.5 size-5 shrink-0 ${ring.state === "ringing" ? "animate-pulse text-green-700" : "text-muted-foreground"}`} />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
              <div className="truncate text-base font-semibold">{contact?.name || ring.phone}</div>
              {contact ? (
                <div className="truncate text-sm text-muted-foreground">
                  {[contact.company, CONTACT_STATUS_LABEL[contact.status], contact.owner?.name].filter(Boolean).join(" · ")}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">{lookup.isLoading ? "Looking up…" : "Not in your contacts"}</div>
              )}
              {contact?.name && <div className="text-sm text-muted-foreground">{ring.phone}</div>}
              {ring.state === "ringing" && <div className="mt-1 text-xs text-muted-foreground">Answer in Phone Link or on your phone.</div>}
            </div>
            <button type="button" aria-label="Close" onClick={() => setRing(null)} className="rounded p-1 text-muted-foreground hover:bg-muted">
              <X className="size-4" />
            </button>
          </div>
          {contact && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3 w-full"
              onClick={() => {
                navigate(`/activity/contacts/${contact.id}`);
                if (ring.state === "ended") setRing(null);
              }}
            >
              Open contact
            </Button>
          )}
        </m.div>
      )}
    </AnimatePresence>
  );
}
