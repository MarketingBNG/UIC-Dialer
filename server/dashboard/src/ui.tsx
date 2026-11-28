/**
 * App-level building blocks composed from shadcn/ui (src/components/ui). No hand-made primitives here:
 * only domain helpers (status badges, page header, empty/error/loading states).
 */
import { AlertCircle, ArrowDownLeft, ArrowUpRight, Inbox, PhoneMissed, RotateCw } from "lucide-react";
import { useId, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { CallStatus, ContactStatus, DialVia, Direction } from "./api";
import { CONTACT_STATUS_LABEL, DIRECTION_LABEL, VIA_LABEL } from "./format";
import { callRowStatusText } from "./callStatus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOutcomes } from "./components/Outcomes";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-h1 font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Loading placeholder: shadcn Skeleton rows (screen readers hear the label). */
export function Spinner({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3 py-4">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-12 w-full", i === rows - 1 && "w-2/3")} />
      ))}
    </div>
  );
}

/** Loading placeholder shaped like a table: a header bar and 52px rows. */
export function TableSkeleton({ rows = 6, cols = 4, label = "Loading" }: { rows?: number; cols?: number; label?: string }) {
  return (
    <Card role="status" aria-live="polite" className="overflow-hidden">
      <span className="sr-only">{label}…</span>
      <div className="flex h-10 items-center gap-6 border-b bg-muted px-3">
        {Array.from({ length: cols }, (_, c) => (
          <Skeleton key={c} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-13 items-center gap-6 border-b px-3 last:border-0">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={cn("h-4 flex-1", c === 0 && "flex-[2]")} />
          ))}
        </div>
      ))}
    </Card>
  );
}

/** Loading placeholder shaped like a card: a title line and a few text lines. */
export function CardSkeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <Card role="status" aria-live="polite" className="flex flex-col gap-3 p-5">
      <span className="sr-only">{label}…</span>
      <Skeleton className="h-5 w-1/3" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-4 w-full", i === lines - 1 && "w-2/3")} />
      ))}
    </Card>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>{msg}</span>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw /> Try again
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Empty state: icon in a soft circle, a title, one line saying what to do, one button. */
export function Empty({ children, action, icon, title }: { children?: ReactNode; action?: ReactNode; icon?: ReactNode; title?: string }) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-muted-foreground">
      <span aria-hidden className="grid size-12 place-items-center rounded-full bg-primary-soft text-primary [&>svg]:size-6">
        {icon ?? <Inbox />}
      </span>
      {title && <p className="text-h2 font-semibold text-foreground">{title}</p>}
      {children && <div className="max-w-md">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </Card>
  );
}
export const EmptyState = Empty;

/** Pill colours. Red (danger) only when someone must act now. Old names (gray/green/amber/red/blue) still work. */
export type PillTone = "success" | "warning" | "danger" | "info" | "neutral";
export type Tone = PillTone | "gray" | "green" | "amber" | "red" | "blue";
const TONE_ALIAS: Record<Tone, PillTone> = {
  success: "success",
  warning: "warning",
  danger: "danger",
  info: "info",
  neutral: "neutral",
  gray: "neutral",
  green: "success",
  amber: "warning",
  red: "danger",
  blue: "info",
};
export const pillTone = (t: Tone): PillTone => TONE_ALIAS[t];

/** The one status pill: call status, score, talk tag, contact status. */
export function Pill({ tone = "neutral", icon, children, ...rest }: { tone?: Tone; icon?: ReactNode } & ComponentProps<"span">) {
  return (
    <Badge variant={pillTone(tone)} {...rest}>
      {icon}
      {children}
    </Badge>
  );
}
export const ToneBadge = Pill;

/** Calls with no real talk (tagged by the transcriber): transcript kept, no summary. */
export const TALK_TAG_LABEL: Record<string, string> = { VOICEMAIL: "Voicemail", NO_SPEECH: "No talk" };

export function TalkTag({ tag }: { tag?: string | null }) {
  if (!tag || !TALK_TAG_LABEL[tag]) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pill tone="neutral" tabIndex={0}>
          {TALK_TAG_LABEL[tag]}
        </Pill>
      </TooltipTrigger>
      <TooltipContent>No real conversation, so no summary was made. The transcript is kept.</TooltipContent>
    </Tooltip>
  );
}

export function StatusBadge({
  status,
  logType,
  direction,
  durationS,
  mine,
}: {
  status: CallStatus;
  logType?: string | null;
  direction?: Direction;
  durationS?: number | null;
  /** False when the viewer doesn't own the phone ("Waiting for phone" instead of "Waiting to upload"). */
  mine?: boolean;
}) {
  const t = callRowStatusText(status, logType, direction, durationS, mine);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Pill tone={t.tone} tabIndex={0}>
          {t.label}
        </Pill>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{t.explanation}</TooltipContent>
    </Tooltip>
  );
}

const DIR_ICON: Record<Direction, ReactNode> = {
  INCOMING: <ArrowDownLeft className="size-4" />,
  OUTGOING: <ArrowUpRight className="size-4" />,
  MISSED: <PhoneMissed className="size-4" />,
  UNKNOWN: null,
};
export function DirectionTag({ direction }: { direction: Direction }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-sm", direction === "MISSED" && "text-warning-text")}>
      <span aria-hidden>{DIR_ICON[direction]}</span>
      {DIRECTION_LABEL[direction]}
    </span>
  );
}

/** "via laptop" / "via app" / "via phone dialer"; nothing when unknown. */
export function ViaTag({ via }: { via: DialVia | null | undefined }) {
  if (!via) return null;
  return <Pill tone={via === "LAPTOP" ? "info" : via === "APP" ? "success" : "neutral"}>{VIA_LABEL[via]}</Pill>;
}

/** AI call score out of 100: green 75+, amber 50+, red below. */
export const ScorePill = ({ score }: { score: number }) => (
  <Pill tone={score >= 75 ? "success" : score >= 50 ? "warning" : "danger"}>
    <span className="tabular-nums">{score}</span>
    <span className="sr-only"> out of 100</span>
  </Pill>
);

/** The one contact-status colour table (same as the phone). An admin's outcome colour wins when set. */
export const CONTACT_STATUS_COLOR: Record<ContactStatus, string> = {
  NEW: "#6B7280",
  INTERESTED: "#16A34A",
  CALL_BACK: "#D97706",
  NOT_INTERESTED: "#DC2626",
  NO_ANSWER: "#64748B",
};
export function ContactStatusBadge({ status }: { status: ContactStatus }) {
  const outcomes = useOutcomes();
  // Built-in outcomes' keys are the lower-case contact status (interested, call_back, ...).
  const color = outcomes.items.find((o) => o.key === status.toLowerCase())?.color ?? CONTACT_STATUS_COLOR[status];
  // Soft tint of the colour with darker text, so any admin-picked colour reads like the other pills.
  const style: CSSProperties = {
    backgroundColor: `color-mix(in srgb, ${color} 12%, var(--card))`,
    borderColor: `color-mix(in srgb, ${color} 25%, transparent)`,
    color: `color-mix(in srgb, ${color} 75%, var(--foreground))`,
  };
  return (
    <Badge variant="outline" style={style}>
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {CONTACT_STATUS_LABEL[status]}
    </Badge>
  );
}

/** Error line under a form or inside a dialog. */
export function FormError({ error }: { error: unknown }) {
  if (error == null) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error instanceof Error ? error.message : String(error || "Failed")}
    </p>
  );
}

/** Small helper text under a field. */
export function Hint({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <p id={id} className={cn("mt-1 text-xs text-muted-foreground", className)}>
      {children}
    </p>
  );
}

/** Switch with a label and optional hint, as one 44px row. */
export function SwitchRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <Label htmlFor={id} className="mb-0 cursor-pointer">
          {label}
        </Label>
        {hint && (
          <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <Switch id={id} className="mt-0.5" aria-describedby={hint ? `${id}-hint` : undefined} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** Destructive confirm built on AlertDialog (stays open while busy; shows the error). */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{body}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <FormError error={error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
