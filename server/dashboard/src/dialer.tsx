import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, type OutcomeDto } from "./api";
import { dialOnPhone } from "./remoteDial";
import { RING_EVENT } from "./components/IncomingCall";
import { fromLocalInput } from "./format";
import { OutcomeButtons, datePrompt, quickPicks, useOutcomes } from "./components/Outcomes";
import { AlertTriangle, CalendarClock, Check, ClipboardCheck, Phone, PhoneCall, ShieldAlert } from "lucide-react";
import type * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "./ui";

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
  /** Typed in the call bar during the call; pre-fills the outcome note. */
  note?: string;
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

/** m:ss for the live call timer. */
const clock = (ms: number) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

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

  const update = (p: PendingCall | null) => {
    savePending(p);
    setPending(p);
  };
  // What the phone reports about the current call: dialling, on the call (since), or ended.
  const [live, setLive] = useState<{ state: "dialing" | "on" | "ended"; since: number }>({ state: "dialing", since: Date.now() });
  const [, tick] = useState(0);
  useEffect(() => {
    if (live.state !== "on") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live.state]);

  const dial = useCallback(async (p: PendingCall, viaPhone = true) => {
    update({ ...p, at: Date.now() });
    setLive({ state: "dialing", since: Date.now() });
    setAsking(false);
    // One click: the UIC app on the rep's phone dials by itself (Phone Link still brings the audio here).
    // Needs the dial intent, which only exists when the check above went through.
    const onPhone = viaPhone ? await dialOnPhone(p.clientId) : { result: "unavailable" as const };
    if (onPhone.result === "failed") {
      toast.error(`Your phone couldn't dial${onPhone.error ? `: ${onPhone.error}` : ""}.`);
      update(null);
      return;
    }
    if (onPhone.result === "unavailable") {
      // No phone listening: the desktop shell hands window.open'd tel: links to Windows (Phone Link); a browser
      // follows the link itself.
      if (isDesktopApp()) window.open(`tel:${p.phone}`);
      else window.location.href = `tel:${p.phone}`;
    } else {
      toast.success("Calling on your phone…");
    }
    // Legal: the other person must be told the call is recorded (India DPDP notice; US all-party-consent states).
    toast("Tell the caller: “This call is recorded for quality and records.”", { duration: 8000 });
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
      void dial(p);
    },
    [dial],
  );

  // Ask for the outcome when the phone reports the call ended (not when the window gets focus back: Phone Link's
  // own popup takes focus, and the rep may switch windows mid-call). The "Log outcome" bar stays as a fallback.
  useEffect(() => {
    const onRing = (e: Event) => {
      const state = (e as CustomEvent<{ state?: string }>).detail?.state;
      const p = loadPending();
      if (!p) return;
      if (state === "answered") setLive({ state: "on", since: Date.now() });
      if (state !== "ended") return;
      setLive({ state: "ended", since: Date.now() });
      if (Date.now() - p.at > MIN_CALL_MS) setAsking(true);
    };
    window.addEventListener(RING_EVENT, onRing);
    return () => window.removeEventListener(RING_EVENT, onRing);
  }, []);

  return (
    <DialerContext.Provider value={{ call, pending, openOutcome: () => setAsking(true) }}>
      {children}
      {pending && !asking && (
        <div role="status" className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur md:left-(--sidebar-width)">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 text-sm">
            <span className="mr-auto flex items-center gap-2">
              <PhoneCall aria-hidden className="size-4 text-success" />
              <span>
                {live.state === "on" ? (
                  <>
                    On call with <strong>{pending.label}</strong> · <span className="tabular-nums">{clock(Date.now() - live.since)}</span>
                  </>
                ) : live.state === "ended" ? (
                  <>
                    Call with <strong>{pending.label}</strong> ended.
                  </>
                ) : (
                  <>
                    Calling <strong>{pending.label}</strong> on your phone…
                  </>
                )}
              </span>
            </span>
            <Input
              aria-label="Call notes"
              placeholder="Notes during the call…"
              className="h-9 w-full sm:w-72"
              value={pending.note ?? ""}
              onChange={(e) => update({ ...pending, note: e.target.value.slice(0, 2000) })}
            />
            <Button onClick={() => setAsking(true)}>
              <ClipboardCheck /> Log outcome
            </Button>
            <Button variant="ghost" onClick={() => update(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {pending && (
        <OutcomeDialog
          key={`${pending.clientId}${asking ? "-open" : ""}`}
          open={asking}
          call={pending}
          // Keep the note on the pending call, so "Later" or a reopen never loses it.
          onNote={(note) => update({ ...pending, note })}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            update(null);
          }}
        />
      )}
      <AlertDialog open={!!dnc} onOpenChange={(o) => !o && setDnc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert aria-hidden className="size-5 text-destructive" />
              {dnc?.unverified ? "Couldn't check the do-not-call list" : "Do not call"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
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
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!dnc) return;
                const p = dnc.call;
                setDnc(null);
                // Dial right away (inside the click), then record the override; the call record arrives much later.
                // Straight to Phone Link: the phone path needs the intent, which is only recorded after this.
                void dial(p, false);
                api("/api/dial-intents", { method: "POST", body: { clientId: p.clientId, phone: p.phone, override: true } }).catch(() => {});
              }}
            >
              <Phone /> {dnc?.unverified ? "Call" : "Call anyway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialerContext.Provider>
  );
}

function OutcomeDialog({
  open,
  call,
  onNote,
  onClose,
  onDone,
}: {
  open: boolean;
  call: PendingCall;
  onNote: (note: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const outcomes = useOutcomes();
  /** The tapped outcome when it still needs a time (quick picks) or a remove-from-lists confirm. */
  const [picked, setPicked] = useState<OutcomeDto | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [custom, setCustom] = useState(false);
  // Starts with what was typed during the call; every edit is copied back to the pending call.
  const [note, setNoteState] = useState(call.note ?? "");
  const setNote = (v: string) => {
    setNoteState(v);
    onNote(v);
  };
  const prompt = picked ? datePrompt(picked) : null;
  const save = useMutation({
    mutationFn: ({ o, followUpAt }: { o: OutcomeDto; followUpAt?: string }) =>
      api("/api/activities", {
        method: "POST",
        body: {
          clientId: call.clientId,
          phone: call.phone,
          type: "CALL",
          outcomeId: o.id,
          // Base outcome too, for safety with servers that predate custom outcomes.
          outcome: o.baseOutcome,
          note: note.trim() || undefined,
          followUpAt: datePrompt(o) ? followUpAt : undefined,
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

  /** One tap: outcomes that need nothing more save right away; dated ones show quick picks; remove asks first. */
  function choose(o: OutcomeDto) {
    save.reset();
    setCustom(false);
    setFollowUp("");
    if (datePrompt(o) || o.rule === "REMOVE_FROM_LISTS") setPicked(o);
    else {
      setPicked(null);
      save.mutate({ o });
    }
  }
  const back = () => {
    setPicked(null);
    setCustom(false);
    save.reset();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>How did the call to {call.label} go?</DialogTitle>
          <DialogDescription>One tap logs it. The recording is linked automatically once the phone uploads it.</DialogDescription>
        </DialogHeader>
        {/* Note first: the outcome tap saves it along with the outcome. */}
        <div>
          <Label htmlFor="oc-note">Note (optional)</Label>
          <Textarea id="oc-note" rows={3} maxLength={2000} placeholder="What was said, next step…" value={note} disabled={save.isPending} onChange={(e) => setNote(e.target.value.slice(0, 2000))} />
        </div>
        {!picked ? (
          <fieldset>
            <legend className="sr-only">Outcome</legend>
            {outcomes.isPending ? (
              <div role="status" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <span className="sr-only">Loading outcomes…</span>
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            ) : (
              <OutcomeButtons
                items={outcomes.items}
                value={save.isPending ? (save.variables?.o.id ?? null) : null}
                disabled={save.isPending}
                onPick={choose}
              />
            )}
          </fieldset>
        ) : prompt ? (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: picked.color }} />
              {picked.label}: {prompt.toLowerCase()}?
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {quickPicks(picked).map((q) => (
                <Button
                  key={q.key}
                  className="h-auto min-h-12 text-base"
                  disabled={save.isPending}
                  onClick={() => save.mutate({ o: picked, followUpAt: q.at.toISOString() })}
                >
                  {q.label}
                </Button>
              ))}
              <Button variant="outline" className="h-auto min-h-12 text-base" disabled={save.isPending} onClick={() => setCustom(true)}>
                <CalendarClock /> Pick…
              </Button>
            </div>
            {custom && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="grow">
                  <Label htmlFor="oc-fu">{prompt}</Label>
                  <Input id="oc-fu" type="datetime-local" autoFocus value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
                </div>
                <Button
                  disabled={!followUp || save.isPending}
                  onClick={() => save.mutate({ o: picked, followUpAt: fromLocalInput(followUp) ?? undefined })}
                >
                  <Check /> {save.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            )}
            <Button variant="link" className="px-0" disabled={save.isPending} onClick={back}>
              Back to outcomes
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Alert variant="warning">
              <AlertTriangle />
              <AlertDescription>
                {picked.label}: this removes the contact from all call lists{picked.addToDnc ? " and marks the number do-not-call" : ""}.
              </AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Button variant="outline" disabled={save.isPending} onClick={back}>
                Back
              </Button>
              <Button variant="destructive" disabled={save.isPending} onClick={() => save.mutate({ o: picked })}>
                <Check /> {save.isPending ? "Saving…" : "Confirm & save"}
              </Button>
            </div>
          </div>
        )}
        <FormError error={save.isError ? save.error : null} />
        <DialogFooter>
          <Button variant="ghost" className="sm:mr-auto" disabled={save.isPending} onClick={onDone}>
            Don&apos;t log
          </Button>
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>
            Later
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type BtnVariant = NonNullable<React.ComponentProps<typeof Button>["variant"]>;
type BtnSize = NonNullable<React.ComponentProps<typeof Button>["size"]>;

export function CallButton({
  phone,
  label,
  className,
  variant,
  size,
  dncReason,
  dnc,
  text = "Call",
}: {
  phone: string | null | undefined;
  label?: string;
  className?: string;
  variant?: BtnVariant;
  size?: BtnSize;
  dncReason?: string | null;
  dnc?: boolean;
  text?: string;
}) {
  const { call } = useDialer();
  if (!phone) return null;
  return (
    <Button
      variant={variant ?? "outline"}
      size={size}
      className={className}
      title={`Call ${phone} on your phone`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void call(phone, label, { dncReason, dnc });
      }}
    >
      <Phone aria-hidden />
      <span>{text}</span>
    </Button>
  );
}
