import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Home, Link2, ListChecks, Phone, Smartphone, Users, XCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type CallPage, type PhoneStatus } from "../api";
import { useMe } from "../App";
import { useDialer } from "../dialer";
import { ago, DIRECTION_LABEL } from "../format";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Exposed by the Windows app (desktop/src/preload.js); absent in a normal browser. */
interface UicDesktop {
  phoneLinkStatus: () => Promise<{ installed: boolean } | null>;
  openPhoneLink: () => Promise<boolean>;
}
const desktop = (): UicDesktop | undefined => (window as unknown as { uicDesktop?: UicDesktop }).uicDesktop;

const STEPS = [
  "Open Phone Link on this PC (button below) and choose Android.",
  "On your work phone, install \"Link to Windows\" and scan the QR code shown on the PC.",
  "In Phone Link, open Calls and allow it. Turn on Bluetooth on both, and accept the pairing prompt.",
  "In the UIC Dialer app on your phone: Settings → Calls from PC → turn on \"Dial from my laptop\".",
  "Test it: press Call on any contact here. Your phone dials, and you talk through the PC.",
];

/** "2m ago" style, for the status card. */
function shortAgo(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ago`;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** One line of the card; amber when something needs fixing. */
function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${ok ? "bg-green-400" : "bg-amber-400"}`} />
      <span className="text-white/70">{label}:</span>
      <span className={`truncate font-medium ${ok ? "text-white/90" : "text-amber-300"}`}>{value}</span>
    </span>
  );
}

const SHORTCUTS = [
  { to: "/", label: "Today", icon: Home },
  { to: "/calls", label: "Calls", icon: Phone },
  { to: "/contacts", label: "Contacts", icon: Users },
  { to: "/lists", label: "Call lists", icon: ListChecks },
];

/** Connected view: the phone, its status, shortcuts and the rep's last few calls with call-back. */
function ConnectedPhone({ model, online, phoneLink, onClose, onHelp, openPhoneLink }: {
  model: string | null; online: boolean; phoneLink: boolean | null;
  onClose: () => void; onHelp: () => void; openPhoneLink?: () => void;
}) {
  const me = useMe();
  const dialer = useDialer();
  const navigate = useNavigate();
  const recent = useQuery({
    queryKey: ["my-recent-calls", me.id],
    queryFn: () => api<CallPage>(`/api/calls?userId=${encodeURIComponent(me.id)}&limit=3`),
    staleTime: 30_000,
  });
  const go = (to: string) => { onClose(); void navigate(to); };
  return (
    <div className="flex flex-col gap-5">
      <DialogTitle className="sr-only">Your phone</DialogTitle>
      <DialogDescription className="sr-only">Connected. Calls dial on your phone.</DialogDescription>
      <div className="flex flex-col items-center gap-2 pt-2">
        <div aria-hidden className="flex h-24 w-12 items-end justify-center rounded-xl border-4 border-foreground/80 bg-gradient-to-b from-sky-400 to-blue-700 pb-1">
          <span className="h-0.5 w-4 rounded-full bg-white/60" />
        </div>
        <p className="text-lg font-semibold">{model ?? "Your phone"}</p>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1" title="Calls from this PC dial on your phone">
            <CheckCircle2 className="size-4 text-green-600" /> Connected
          </span>
          <span className="flex items-center gap-1">
            <span aria-hidden className={`size-2 rounded-full ${online ? "bg-green-500" : "bg-amber-500"}`} />
            {online ? "Online" : "Offline"}
          </span>
          {phoneLink !== null && (
            <span className="flex items-center gap-1" title={phoneLink ? "Phone Link installed" : "Phone Link not installed"}>
              <Link2 className={`size-4 ${phoneLink ? "text-green-600" : "text-amber-600"}`} /> Phone Link
            </span>
          )}
        </div>
      </div>
      <nav className="flex flex-col">
        {SHORTCUTS.map(({ to, label, icon: Icon }) => (
          <button key={to} type="button" onClick={() => go(to)} className="flex items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
            <Icon className="size-4 text-muted-foreground" /> {label}
          </button>
        ))}
        {openPhoneLink && (
          <button type="button" onClick={openPhoneLink} className="flex items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted">
            <Link2 className="size-4 text-muted-foreground" /> Open Phone Link
          </button>
        )}
      </nav>
      <div className="flex flex-col gap-1">
        <p className="px-2 text-sm font-semibold">Recent</p>
        {recent.isLoading && <Skeleton className="h-24 w-full" />}
        {recent.data?.items.length === 0 && <p className="px-2 text-sm text-muted-foreground">No calls yet.</p>}
        {recent.data?.items.map((c) => {
          const num = c.phoneE164 ?? c.phoneRaw;
          return (
            <div key={c.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
              <button type="button" onClick={() => go(`/calls/${c.id}`)} className="flex min-w-0 flex-1 flex-col text-left">
                <span className="truncate text-sm font-medium">{c.contactName || c.lead?.name || num || "Unknown"}</span>
                <span className="text-xs text-muted-foreground">{DIRECTION_LABEL[c.direction]} · {ago(c.startedAt)}</span>
              </button>
              {num && (
                <Button size="icon" variant="ghost" aria-label={`Call ${num}`} onClick={() => { onClose(); void dialer.call(num, c.contactName ?? undefined); }}>
                  <Phone className="size-4" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" onClick={onHelp} className="self-center text-xs text-muted-foreground underline-offset-2 hover:underline">
        Setup help
      </button>
    </div>
  );
}

/**
 * Sidebar status card: the rep's phone heartbeat, whether it takes laptop calls, and (in the Windows app)
 * whether Phone Link is installed. Clicking opens the Phone Link setup steps.
 * Windows doesn't say whether a phone is paired, so we only check Phone Link is installed.
 */
export function PhoneStatusCard() {
  const d = desktop();
  const [open, setOpen] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const me = useQuery({ queryKey: ["me-phone"], queryFn: () => api<PhoneStatus>("/api/me/phone"), refetchInterval: 60_000 });
  const status = useQuery({
    queryKey: ["phone-link-status"],
    queryFn: async () => (await d!.phoneLinkStatus()) ?? { installed: false },
    enabled: !!d,
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });
  // Phones listening for laptop calls ("Dial from my laptop" on in the app).
  const phone = useQuery({
    queryKey: ["remote-dial-status"],
    queryFn: () => api<{ phones: number }>("/api/remote-dial/status"),
    refetchInterval: 30_000,
  });
  if (!me.data) return <Skeleton className="h-16 w-full bg-white/10" />;
  const p = me.data;
  const installed = status.data?.installed;
  const connected = (phone.data?.phones ?? 0) > 0;
  // Set up: phone listens for laptop calls, and (in the Windows app) Phone Link is installed.
  const ready = connected && (!d || installed === true);
  const phoneText =!p.lastSeenAt ? "Not signed in" : p.online ? `Online · seen ${shortAgo(p.lastSeenAt)}` : `Offline · ${shortAgo(p.lastSeenAt)}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Phone status. Open calling setup"
        title={p.model ? `${p.model}${p.appVersion ? ` · app ${p.appVersion}` : ""} · calls use its SIM` : undefined}
        className="flex w-full flex-col gap-1 rounded-lg bg-white/10 px-3 py-2 text-left text-xs outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <span className="flex items-center gap-2 font-medium text-white/90">
          <Smartphone aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{p.model ?? "Your phone"}</span>
        </span>
        <span role="status" className="flex flex-col gap-0.5">
          <Row label="Phone" value={phoneText} ok={!!p.online} />
          {phone.data && <Row label="Dial from laptop" value={connected ? "On" : "Off"} ok={connected} />}
          {d && installed !== undefined && <Row label="Phone Link" value={installed ? "Ready" : "Install"} ok={installed} />}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        {ready && !showSteps ? (
          <DialogContent className="max-w-sm">
            <ConnectedPhone model={p.model} online={!!p.online} phoneLink={d ? !!installed : null} onClose={() => setOpen(false)} onHelp={() => setShowSteps(true)} openPhoneLink={d ? () => void d.openPhoneLink() : undefined} />
          </DialogContent>
        ) : (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ready ? "Calling from this PC is ready" : "Call from this PC"}</DialogTitle>
            <DialogDescription>
              {ready
                ? "Your work phone dials, and Phone Link brings the call to this PC."
                : "Phone Link dials on your work phone and brings the call to this PC. Set it up once on each PC."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-sm">
            {connected ? (
              <CheckCircle2 className="size-4 text-green-700" />
            ) : (
              <XCircle className="size-4 text-amber-600" />
            )}
            {connected ? "Your phone is connected: Call dials on it straight away." : "Your phone isn't connected yet (see step 4 below)."}
          </div>
          {d && <div className="flex items-center gap-2 text-sm">
            {installed ? (
              <>
                <CheckCircle2 className="size-4 text-green-700" /> Phone Link is installed
              </>
            ) : (
              <>
                <XCircle className="size-4 text-amber-600" /> Phone Link isn't installed. Get it free from the Microsoft Store (search "Phone Link").
              </>
            )}
          </div>}
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            Incoming calls: Phone Link shows Answer on this PC, and this app shows who is calling from your contacts.
          </p>
          <DialogFooter className="gap-2">
            {ready && (
              <Button variant="ghost" onClick={() => setShowSteps(false)}>
                Back
              </Button>
            )}
            {!d ? null : installed ? (
              <Button onClick={() => void d.openPhoneLink()}>Open Phone Link</Button>
            ) : (
              <Button variant="outline" onClick={() => void status.refetch()}>
                I've installed it
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
        )}
      </Dialog>
    </>
  );
}
