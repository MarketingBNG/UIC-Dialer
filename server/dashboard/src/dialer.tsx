import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, type OutcomeDto } from "./api";
import { fromLocalInput } from "./format";
import { OutcomeButtons, datePrompt, useOutcomes } from "./components/Outcomes";
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
  /** Set when the call was started from a call-list session: the outcome is saved against this item. */
  callListItemId?: string;
  listId?: string;
}
export interface CallOptions {
  /** Shown in the do-not-call confirm when the caller already knows it (contact.dnc.reason). */
  dncReason?: string | null;
  /** The caller already knows the number is on the do-not-call list: confirm before anything else. */
  dnc?: boolean;
  callListItemId?: string;
  listId?: string;
}
interface DialerApi {
  call: (phone: string, label?: string, opts?: CallOptions) => Promise<void>;
  pending: PendingCall | null;
  openOutcome: () => void;
}

const STORE_KEY = "uic.pendingCall";
/** Pending calls older than this are dropped instead of asked about (matches the Android app). */
const MAX_AGE_MS = 12 * 3600_000;
/** Ignore focus changes right after dialling (Phone Link may not have taken focus yet). */
const MIN_CALL_MS = 4000;
/** The dial intent is awaited only this long (it can block a do-not-call number); after that we dial anyway. */
const INTENT_WAIT_MS = 2500;

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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
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
  // unverified: the do-not-call check could not be made (timeout, offline, server error).
  const [dnc, setDnc] = useState<{ call: PendingCall; reason: string | null; unverified?: boolean } | null>(null);
  const left = useRef(false);

  const update = (p: PendingCall | null) => {
    savePending(p);
    setPending(p);
  };

  const dial = useCallback((p: PendingCall) => {
    update({ ...p, at: Date.now() });
    left.current = false;
    setAsking(false);
    // The desktop shell hands window.open'd tel: links to Windows (Phone Link); a browser follows the link itself.
    if (isDesktopApp()) window.open(`tel:${p.phone}`);
    else window.location.href = `tel:${p.phone}`;
  }, []);

  const call = useCallback(
    async (raw: string, label?: string, opts: CallOptions = {}) => {
      const phone = cleanNumber(raw);
      if (!phone) return;
      const clientId = crypto.randomUUID();
      const p: PendingCall = { phone, label: label || phone, at: Date.now(), clientId };
      if (opts.callListItemId) p.callListItemId = opts.callListItemId;
      if (opts.listId) p.listId = opts.listId;
      // Known do-not-call: confirm first, without waiting on the network.
      if (opts.dnc) {
        setDnc({ call: p, reason: opts.dncReason ?? null });
        return;
      }
      // The intent lets the server label the recorded call "via laptop" and stops do-not-call numbers. When the
      // check can't be made (slow server, offline, server error) the rep confirms instead of dialling blind.
      try {
        await withTimeout(api("/api/dial-intents", { method: "POST", body: { clientId, phone } }), INTENT_WAIT_MS);
      } catch (e) {
        if (e instanceof ApiError && e.code === "DNC") {
          setDnc({ call: p, reason: opts.dncReason ?? null });
          return;
        }
        if (!(e instanceof ApiError && e.status < 500)) {
          setDnc({ call: p, reason: null, unverified: true });
          return;
        }
      }
      dial(p);
    },
    [dial],
  );

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
      <Modal
        open={!!dnc}
        title={dnc?.unverified ? "Couldn't check the do-not-call list" : "Do not call"}
        onClose={() => setDnc(null)}
        footer={
          <>
            <button type="button" className="btn-ghost" onClick={() => setDnc(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => {
                if (!dnc) return;
                const p = dnc.call;
                setDnc(null);
                // Dial right away (inside the click), then record the override; the call record arrives much later.
                dial(p);
                api("/api/dial-intents", { method: "POST", body: { clientId: p.clientId, phone: p.phone, override: true } }).catch(() => {});
              }}
            >
              {dnc?.unverified ? "Call" : "Call anyway"}
            </button>
          </>
        }
      >
        {dnc?.unverified ? (
          <p>
            The server didn&apos;t answer in time, so this number wasn&apos;t checked against the do-not-call list. Call{" "}
            <strong>{dnc.call.label}</strong> anyway?
          </p>
        ) : (
          <p>
            On do-not-call list{dnc?.reason ? `: ${dnc.reason}` : ""}. Call <strong>{dnc?.call.label}</strong> anyway?
          </p>
        )}
      </Modal>
    </DialerContext.Provider>
  );
}

function OutcomeDialog({ open, call, onClose, onDone }: { open: boolean; call: PendingCall; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const outcomes = useOutcomes();
  const [picked, setPicked] = useState<OutcomeDto | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [note, setNote] = useState("");
  const prompt = picked ? datePrompt(picked) : null;
  const save = useMutation({
    mutationFn: () =>
      api("/api/activities", {
        method: "POST",
        body: {
          clientId: call.clientId,
          phone: call.phone,
          type: "CALL",
          outcomeId: picked?.id,
          // Base outcome too, for safety with servers that predate custom outcomes.
          outcome: picked?.baseOutcome,
          note: note.trim() || undefined,
          followUpAt: prompt ? (fromLocalInput(followUp) ?? undefined) : undefined,
          callListItemId: call.callListItemId,
          occurredAt: new Date(call.at).toISOString(),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contacts"] });
      void qc.invalidateQueries({ queryKey: ["contact"] });
      void qc.invalidateQueries({ queryKey: ["followups-today"] });
      void qc.invalidateQueries({ queryKey: ["me-today"] });
      // Auto-advance: a list session refetches `next` once its outcome is saved.
      if (call.listId) {
        void qc.invalidateQueries({ queryKey: ["list-next", call.listId] });
        void qc.invalidateQueries({ queryKey: ["my-lists"] });
        // A manager's list detail / overview in this session shows item states and counts.
        void qc.invalidateQueries({ queryKey: ["call-list", call.listId] });
        void qc.invalidateQueries({ queryKey: ["call-lists"] });
      }
      onDone();
    },
  });
  const needsDate = !!prompt && !followUp;

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
          <button type="button" className="btn-primary" disabled={!picked || needsDate || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : picked?.rule === "REMOVE_FROM_LISTS" ? "Confirm & save" : "Save"}
          </button>
        </>
      }
    >
      <fieldset>
        <legend className="label">Outcome</legend>
        {outcomes.isPending ? (
          <p className="hint">Loading outcomes…</p>
        ) : (
          <OutcomeButtons
            items={outcomes.items}
            value={picked?.id ?? null}
            onPick={(o) => {
              setPicked(o);
              save.reset();
            }}
          />
        )}
      </fieldset>
      {prompt && (
        <div className="mt-3">
          <label className="label" htmlFor="oc-fu">
            {prompt}
          </label>
          <input id="oc-fu" type="datetime-local" className="input" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        </div>
      )}
      {picked?.rule === "RETRY" && <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">Will retry in {picked.retryHours ?? "?"} h.</p>}
      {picked?.rule === "CLOSE_LEAD" && <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">Closes the lead and takes it off other call lists.</p>}
      {picked?.rule === "REMOVE_FROM_LISTS" && (
        <p className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          This removes the contact from all call lists{picked.addToDnc ? " and marks the number do-not-call" : ""}. Press Confirm & save to go ahead.
        </p>
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

export function CallButton({
  phone,
  label,
  className = "btn-outline",
  dncReason,
  dnc,
  text = "Call",
}: {
  phone: string | null | undefined;
  label?: string;
  className?: string;
  dncReason?: string | null;
  dnc?: boolean;
  text?: string;
}) {
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
        void call(phone, label, { dncReason, dnc });
      }}
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
      </svg>
      <span>{text}</span>
    </button>
  );
}
