import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type CallOutcome } from "./api";
import { OUTCOME_LABEL, fromLocalInput } from "./format";
import { Modal } from "./ui";

/**
 * Desktop click-to-call. Opening a tel: link hands the number to Windows Phone Link, which dials on the rep's
 * paired Android phone (the phone's own dialer records the call) and carries the audio over Bluetooth.
 * When the rep comes back to this window we ask for the outcome, like the Android app does.
 */
interface PendingCall {
  phone: string;
  label: string;
  at: number;
  clientId: string;
}
interface DialerApi {
  call: (phone: string, label?: string) => void;
  pending: PendingCall | null;
  openOutcome: () => void;
}

const STORE_KEY = "uic.pendingCall";
/** Pending calls older than this are dropped instead of asked about (matches the Android app). */
const MAX_AGE_MS = 12 * 3600_000;
/** Ignore focus changes right after dialling (Phone Link may not have taken focus yet). */
const MIN_CALL_MS = 4000;

export const isDesktopApp = () => typeof navigator !== "undefined" && navigator.userAgent.includes("UICDialer/");

/** Keeps digits and a leading +, like the Android DialLogic.cleanNumber. */
export function cleanNumber(raw: string) {
  const t = raw.trim();
  const digits = t.replace(/\D/g, "");
  return digits ? (t.startsWith("+") ? `+${digits}` : digits) : "";
}

function loadPending(): PendingCall | null {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as PendingCall | null;
    return p && Date.now() - p.at < MAX_AGE_MS ? p : null;
  } catch {
    return null;
  }
}
function savePending(p: PendingCall | null) {
  try {
    if (p) localStorage.setItem(STORE_KEY, JSON.stringify(p));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage blocked: the outcome prompt still works for this page load */
  }
}

const DialerContext = createContext<DialerApi | null>(null);
export const useDialer = () => {
  const d = useContext(DialerContext);
  if (!d) throw new Error("useDialer outside DialerProvider");
  return d;
};

export function DialerProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingCall | null>(loadPending);
  const [asking, setAsking] = useState(false);
  const left = useRef(false);

  const update = (p: PendingCall | null) => {
    savePending(p);
    setPending(p);
  };

  const call = useCallback((raw: string, label?: string) => {
    const phone = cleanNumber(raw);
    if (!phone) return;
    const clientId = crypto.randomUUID();
    update({ phone, label: label || phone, at: Date.now(), clientId });
    // Lets the server label the recorded call "via laptop"; best effort, never blocks dialling.
    api("/api/dial-intents", { method: "POST", body: { clientId, phone } }).catch(() => {});
    left.current = false;
    setAsking(false);
    // The desktop shell hands window.open'd tel: links to Windows (Phone Link); a browser follows the link itself.
    if (isDesktopApp()) window.open(`tel:${phone}`);
    else window.location.href = `tel:${phone}`;
  }, []);

  useEffect(() => {
    const away = () => {
      left.current = true;
    };
    const back = () => {
      if (document.visibilityState === "hidden") return;
      const p = loadPending();
      if (p && left.current && Date.now() - p.at > MIN_CALL_MS) setAsking(true);
      left.current = false;
    };
    window.addEventListener("blur", away);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("blur", away);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);

  return (
    <DialerContext.Provider value={{ call, pending, openOutcome: () => setAsking(true) }}>
      {children}
      {pending && !asking && (
        <div role="status" className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 text-sm">
            <span className="mr-auto">
              Call to <strong>{pending.label}</strong> started on your phone.
            </span>
            <button type="button" className="btn-primary" onClick={() => setAsking(true)}>
              Log outcome
            </button>
            <button type="button" className="btn-ghost" onClick={() => update(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {pending && (
        <OutcomeDialog
          key={pending.clientId}
          open={asking}
          call={pending}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            update(null);
          }}
        />
      )}
    </DialerContext.Provider>
  );
}

function OutcomeDialog({ open, call, onClose, onDone }: { open: boolean; call: PendingCall; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api("/api/activities", {
        method: "POST",
        body: {
          clientId: call.clientId,
          phone: call.phone,
          type: "CALL",
          outcome: outcome ?? undefined,
          note: note.trim() || undefined,
          followUpAt: outcome === "CALL_BACK" ? (fromLocalInput(followUp) ?? undefined) : undefined,
          occurredAt: new Date(call.at).toISOString(),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contacts"] });
      void qc.invalidateQueries({ queryKey: ["contact"] });
      void qc.invalidateQueries({ queryKey: ["followups-today"] });
      onDone();
    },
  });
  const needsDate = outcome === "CALL_BACK" && !followUp;

  return (
    <Modal
      open={open}
      title={`How did the call to ${call.label} go?`}
      onClose={() => !save.isPending && onClose()}
      footer={
        <>
          <button type="button" className="btn-ghost mr-auto" disabled={save.isPending} onClick={onDone}>
            Don't log
          </button>
          <button type="button" className="btn-ghost" disabled={save.isPending} onClick={onClose}>
            Later
          </button>
          <button type="button" className="btn-primary" disabled={!outcome || needsDate || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <fieldset>
        <legend className="label">Outcome</legend>
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(OUTCOME_LABEL) as CallOutcome[]).map((o) => (
            <button
              key={o}
              type="button"
              aria-pressed={outcome === o}
              className={outcome === o ? "btn-primary" : "btn-outline"}
              onClick={() => setOutcome(o)}
            >
              {OUTCOME_LABEL[o]}
            </button>
          ))}
        </div>
      </fieldset>
      {outcome === "CALL_BACK" && (
        <div className="mt-3">
          <label className="label" htmlFor="oc-fu">
            Call back on
          </label>
          <input id="oc-fu" type="datetime-local" className="input" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        </div>
      )}
      <div className="mt-3">
        <label className="label" htmlFor="oc-note">
          Note (optional)
        </label>
        <textarea id="oc-note" className="input" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <p className="hint mt-2">The recording is linked automatically once the phone uploads it.</p>
      {save.isError && (
        <p role="alert" className="mt-2 text-red-600 dark:text-red-400">
          {save.error.message}
        </p>
      )}
    </Modal>
  );
}

export function CallButton({ phone, label, className = "btn-outline" }: { phone: string | null | undefined; label?: string; className?: string }) {
  const { call } = useDialer();
  if (!phone) return null;
  return (
    <button
      type="button"
      className={className}
      title={`Call ${phone} on your phone`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        call(phone, label);
      }}
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
      </svg>
      <span>Call</span>
    </button>
  );
}
