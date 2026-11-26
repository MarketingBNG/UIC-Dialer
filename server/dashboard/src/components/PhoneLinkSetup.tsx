import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Link2, XCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
  "Test it: press Call on any contact here. Your phone dials, and you talk through the PC.",
];

/**
 * Sidebar box in the Windows app: is Phone Link (which dials on the rep's phone and carries the audio) ready?
 * Windows doesn't say whether a phone is paired, so we check it's installed and walk the rep through pairing.
 */
export function PhoneLinkSetup() {
  const d = desktop();
  const [open, setOpen] = useState(false);
  const status = useQuery({
    queryKey: ["phone-link-status"],
    queryFn: async () => (await d!.phoneLinkStatus()) ?? { installed: false },
    enabled: !!d,
    refetchOnWindowFocus: true,
    staleTime: 60_000,
  });
  if (!d) return null;
  const installed = status.data?.installed;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-left text-xs font-medium text-white/90 outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <Link2 aria-hidden className="size-4 shrink-0" />
        <span className="flex-1">Calling from PC (Phone Link)</span>
        {installed === undefined ? null : installed ? (
          <span className="text-white/70">Set up</span>
        ) : (
          <span className="text-amber-300">Install</span>
        )}
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
            {installed ? (
              <>
                <CheckCircle2 className="size-4 text-green-700" /> Phone Link is installed
              </>
            ) : (
              <>
                <XCircle className="size-4 text-amber-600" /> Phone Link isn't installed. Get it free from the Microsoft Store (search "Phone Link").
              </>
            )}
          </div>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            Incoming calls: Phone Link shows Answer on this PC, and this app shows who is calling from your contacts.
          </p>
          <DialogFooter>
            {installed ? (
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
