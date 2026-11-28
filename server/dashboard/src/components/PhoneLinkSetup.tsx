import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Smartphone, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type PhoneStatus } from "../api";
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

/**
 * Sidebar status card: the rep's phone heartbeat, whether it takes laptop calls, and (in the Windows app)
 * whether Phone Link is installed. Clicking opens the Phone Link setup steps.
 * Windows doesn't say whether a phone is paired, so we only check Phone Link is installed.
 */
export function PhoneStatusCard() {
  const d = desktop();
  const [open, setOpen] = useState(false);
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
  const phoneText = !p.lastSeenAt ? "Not signed in" : p.online ? `Online · seen ${shortAgo(p.lastSeenAt)}` : `Offline · ${shortAgo(p.lastSeenAt)}`;

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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Call from this PC</DialogTitle>
            <DialogDescription>
              Phone Link dials on your work phone and brings the call to this PC. Set it up once on each PC.
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
          <DialogFooter>
            {!d ? null : installed ? (
              <Button onClick={() => void d.openPhoneLink()}>Open Phone Link</Button>
            ) : (
              <Button variant="outline" onClick={() => void status.refetch()}>
                I've installed it
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
