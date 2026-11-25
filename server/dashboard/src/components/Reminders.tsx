import { useQuery } from "@tanstack/react-query";
import { BellRing, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { BASE } from "@/lib/motion";
import { useNavigate } from "react-router";
import { api, type FollowUpItem, type FollowUpsToday, type Me } from "../api";
import { Button } from "@/components/ui/button";

/**
 * Desktop reminders: while signed in (and once the rep turned them on), checks today's follow-ups every minute and
 * shows a system notification when a follow-up comes due or a new missed call lands. Works in a browser and in the
 * Windows app (which allows notifications for this origin only and raises its window on a click).
 */

const SEEN_KEY = "uic.reminders.seen";
const DISMISS_KEY = "uic.reminders.bannerDismissed";
const MAX_SEEN = 500;

const supported = () => typeof window !== "undefined" && "Notification" in window;

function readSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeSeen(ids: string[]) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(-MAX_SEEN)));
  } catch {
    /* private window or storage blocked: we may repeat a reminder, nothing worse */
  }
}

const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });
const time = (iso: string) => timeFmt.format(new Date(iso)).toLowerCase();

/** Snoozing moves dueAt, so a snoozed follow-up reminds again when it comes due again. */
const reminderId = (i: FollowUpItem) => `${i.key}@${i.dueAt}`;

/** Follow-ups that are due now, and missed calls; new leads are left to the Today page. */
function dueNow(items: FollowUpItem[], now: number) {
  return items.filter((i) => (i.kind === "MISSED_CALL" ? true : i.kind === "FOLLOW_UP" && Date.parse(i.dueAt) <= now));
}

function openToday(navigate: ReturnType<typeof useNavigate>, phone?: string) {
  const q = new URLSearchParams();
  if (phone) q.set("call", phone);
  // from=reminder lets the Windows app bring its window to the front (it watches for it); r makes each click a new URL.
  q.set("from", "reminder");
  q.set("r", String(Date.now()));
  navigate(`/today?${q}`);
  try {
    window.focus();
  } catch {
    /* ignore */
  }
}

function notify(fresh: FollowUpItem[], navigate: ReturnType<typeof useNavigate>) {
  if (!fresh.length) return;
  let title: string;
  let body: string;
  let phone: string | undefined;
  if (fresh.length === 1) {
    const i = fresh[0]!;
    title = `Call ${i.name || i.phoneE164}`;
    body = i.kind === "MISSED_CALL" ? `Missed call ${time(i.dueAt)}` : `Follow-up due ${time(i.dueAt)}`;
    if (i.company) body += ` · ${i.company}`;
    phone = i.phoneE164;
  } else {
    const missed = fresh.filter((i) => i.kind === "MISSED_CALL").length;
    const fus = fresh.length - missed;
    const parts = [fus && `${fus} follow-up${fus > 1 ? "s" : ""} due`, missed && `${missed} missed call${missed > 1 ? "s" : ""}`].filter(Boolean);
    title = parts.join(" · ");
    body = fresh
      .slice(0, 3)
      .map((i) => i.name || i.phoneE164)
      .join(", ")
      .concat(fresh.length > 3 ? ` and ${fresh.length - 3} more` : "");
    phone = fresh[0]!.phoneE164;
  }
  try {
    const n = new Notification(title, { body, tag: "uic-reminder", icon: "/favicon.ico" });
    n.onclick = () => {
      n.close();
      openToday(navigate, phone);
    };
  } catch {
    /* some browsers only allow notifications from a service worker; skip quietly */
  }
}

export function Reminders() {
  // Same cache entries as App and Today, so no extra requests when those are already loaded.
  const me = useQuery<Me | null>({ queryKey: ["me"], enabled: false });
  const signedIn = !!me.data;
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() => (supported() ? Notification.permission : "unsupported"));
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;

  const on = signedIn && permission === "granted";
  const fu = useQuery({
    queryKey: ["followups-today"],
    queryFn: () => api<FollowUpsToday>("/api/followups/today?v=2"),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    enabled: on,
  });
  // Re-check every minute even if the list didn't change, for follow-ups whose time has just come.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [on]);

  useEffect(() => {
    if (!on || !fu.data) return;
    const seen = readSeen();
    const seenSet = new Set(seen);
    const fresh = dueNow(fu.data.items, Date.now()).filter((i) => !seenSet.has(reminderId(i)));
    if (!fresh.length) return;
    writeSeen([...seen, ...fresh.map(reminderId)]);
    notify(fresh, navRef.current);
  }, [on, fu.data, tick]);

  const show = signedIn && permission === "default" && !dismissed;

  const turnOn = async () => {
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission(Notification.permission);
    }
  };
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <AnimatePresence>
      {show && (
    <m.div key="reminder-banner" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={BASE} className="fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border bg-background p-3 shadow-lg">
      <BellRing className="size-5 shrink-0 text-primary" />
      <div className="min-w-0 text-sm">
        <div className="font-medium">Get a pop-up when a follow-up is due</div>
        <div className="text-muted-foreground">Also for missed calls, like on your phone.</div>
      </div>
      <Button size="sm" onClick={() => void turnOn()}>
        Turn on desktop reminders
      </Button>
      <Button size="icon" variant="ghost" aria-label="Not now" onClick={dismiss}>
        <X />
      </Button>
    </m.div>
      )}
    </AnimatePresence>
  );
}
