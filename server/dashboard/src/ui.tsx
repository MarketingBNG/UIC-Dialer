/**
 * App-level building blocks composed from shadcn/ui (src/components/ui). No hand-made primitives here:
 * only domain helpers (status badges, page header, empty/error/loading states).
 */
import { AlertCircle, ArrowDownLeft, ArrowUpRight, Inbox, PhoneMissed, RotateCw } from "lucide-react";
import { useId, type ReactNode } from "react";
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
import { CONTACT_STATUS_LABEL, DIRECTION_LABEL, STATUS_LABEL, VIA_LABEL } from "./format";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
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

/** Empty state: say what's missing and, where possible, what to do next (pass an action button). */
export function Empty({ children, action, icon }: { children: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-3 p-8 text-center text-sm text-muted-foreground">
      <span aria-hidden className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground [&>svg]:size-5">
        {icon ?? <Inbox />}
      </span>
      <div className="max-w-md">{children}</div>
      {action}
    </Card>
  );
}

export type Tone = "gray" | "green" | "amber" | "red" | "blue";
export function ToneBadge({ tone = "gray", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <Badge variant={tone} className={className}>
      {children}
    </Badge>
  );
}

const STATUS_TONE: Record<CallStatus, Tone> = {
  PENDING_UPLOAD: "gray",
  UPLOADED: "blue",
  TRANSCRIBING: "amber",
  TRANSCRIBED: "green",
  FAILED: "red",
};
export const StatusBadge = ({ status }: { status: CallStatus }) => <Badge variant={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;

const DIR_ICON: Record<Direction, ReactNode> = {
  INCOMING: <ArrowDownLeft className="size-4" />,
  OUTGOING: <ArrowUpRight className="size-4" />,
  MISSED: <PhoneMissed className="size-4" />,
  UNKNOWN: null,
};
export function DirectionTag({ direction }: { direction: Direction }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-sm", direction === "MISSED" && "text-destructive")}>
      <span aria-hidden>{DIR_ICON[direction]}</span>
      {DIRECTION_LABEL[direction]}
    </span>
  );
}

/** "via laptop" / "via app" / "via phone dialer"; nothing when unknown. */
export function ViaTag({ via }: { via: DialVia | null | undefined }) {
  if (!via) return null;
  return <Badge variant={via === "LAPTOP" ? "blue" : via === "APP" ? "green" : "gray"}>{VIA_LABEL[via]}</Badge>;
}

/** AI call score out of 100: green 75+, amber 50+, red below. */
export const ScorePill = ({ score }: { score: number }) => (
  <Badge variant={score >= 75 ? "green" : score >= 50 ? "amber" : "red"}>
    <span className="tabular-nums">{score}</span>
    <span className="sr-only"> out of 100</span>
  </Badge>
);

const CONTACT_TONE: Record<ContactStatus, Tone> = {
  NEW: "gray",
  INTERESTED: "green",
  CALL_BACK: "blue",
  NOT_INTERESTED: "red",
  NO_ANSWER: "amber",
};
export const ContactStatusBadge = ({ status }: { status: ContactStatus }) => <Badge variant={CONTACT_TONE[status]}>{CONTACT_STATUS_LABEL[status]}</Badge>;

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
