import { useQuery } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type OutcomeDto, type OutcomeRule } from "../api";

/** The four seeded outcomes (fixed ids from the migration); used when /api/outcomes can't be loaded. */
export const DEFAULT_OUTCOMES: OutcomeDto[] = [
  { id: "00000000-0000-7000-8000-000000000001", key: "interested", label: "Interested", color: "#16A34A", sortOrder: 10, active: true, baseOutcome: "INTERESTED", rule: "NONE", retryHours: null, addToDnc: false },
  { id: "00000000-0000-7000-8000-000000000002", key: "call_back", label: "Call back", color: "#D97706", sortOrder: 20, active: true, baseOutcome: "CALL_BACK", rule: "ASK_CALLBACK", retryHours: null, addToDnc: false },
  { id: "00000000-0000-7000-8000-000000000003", key: "not_interested", label: "Not interested", color: "#DC2626", sortOrder: 30, active: true, baseOutcome: "NOT_INTERESTED", rule: "NONE", retryHours: null, addToDnc: false },
  { id: "00000000-0000-7000-8000-000000000004", key: "no_answer", label: "No answer", color: "#64748B", sortOrder: 40, active: true, baseOutcome: "NO_ANSWER", rule: "NONE", retryHours: null, addToDnc: false },
];

export const RULE_LABEL: Record<OutcomeRule, string> = {
  NONE: "No extra step",
  ASK_FOLLOW_UP: "Ask follow-up date",
  ASK_MEETING: "Ask meeting date & time",
  ASK_CALLBACK: "Ask call-back time",
  CLOSE_LEAD: "Close the lead",
  RETRY: "Retry automatically",
  REMOVE_FROM_LISTS: "Remove from all lists",
};

/** Active outcomes in sortOrder; falls back to the built-in four when the server can't be reached. */
export function useOutcomes() {
  const q = useQuery({
    queryKey: ["outcomes"],
    queryFn: () => api<{ items: OutcomeDto[] }>("/api/outcomes"),
    staleTime: 5 * 60_000,
  });
  const items = q.data
    ? q.data.items.filter((o) => o.active).sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    : q.isError
      ? DEFAULT_OUTCOMES
      : [];
  return { items, isPending: q.isPending && !q.isError };
}

/** The prompt label for rules that need a date, or null. A NONE rule on a Call back base still needs one (as before). */
export function datePrompt(o: OutcomeDto): string | null {
  switch (o.rule) {
    case "ASK_FOLLOW_UP":
      return "Follow-up date";
    case "ASK_MEETING":
      return "Meeting date & time";
    case "ASK_CALLBACK":
      return "Call back at";
    case "NONE":
      return o.baseOutcome === "CALL_BACK" ? "Call back at" : null;
    default:
      return null;
  }
}

export type QuickPick = { key: string; label: string; at: Date };

/**
 * One-tap times offered after a dated outcome: in 1 hour (rounded up to 5 min), tomorrow 11 am, next week
 * (7 days from today) 11 am. A follow-up date rule has no time of day, so it skips "In 1 hour".
 */
export function quickPicks(o: OutcomeDto, now = new Date()): QuickPick[] {
  if (!datePrompt(o)) return [];
  const step = 5 * 60_000;
  const inHour = new Date(Math.ceil((now.getTime() + 3600_000) / step) * step);
  const at11 = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(11, 0, 0, 0);
    return d;
  };
  const picks: QuickPick[] = [
    { key: "1h", label: "In 1 hour", at: inHour },
    { key: "tomorrow", label: "Tomorrow 11 am", at: at11(1) },
    { key: "week", label: "Next week", at: at11(7) },
  ];
  return o.rule === "ASK_FOLLOW_UP" ? picks.slice(1) : picks;
}

/** Readable text on an outcome colour: dark text on light colours. */
function textOn(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#0f172a" : "#fff";
}

/** A pill coloured by the outcome's own colour. */
export function OutcomeChip({ label, color }: { label: string; color: string | null | undefined }) {
  const c = color || "#64748B";
  return (
    <Badge className="border-transparent" style={{ backgroundColor: c, color: textOn(c) }}>
      {label}
    </Badge>
  );
}

/** Large outcome buttons coloured by `color`; the selected one is filled. Dated outcomes end in "…". */
export function OutcomeButtons({
  items,
  value,
  onPick,
  disabled,
}: {
  items: OutcomeDto[];
  value: string | null;
  onPick: (o: OutcomeDto) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {items.map((o) => {
        const on = o.id === value;
        const style: CSSProperties = on ? { backgroundColor: o.color, borderColor: o.color, color: textOn(o.color) } : { borderColor: o.color };
        return (
          <Button key={o.id} variant="outline" aria-pressed={on} disabled={disabled} className="h-auto min-h-14 justify-start border-2 px-4 text-base text-foreground hover:opacity-90" style={style} onClick={() => onPick(o)}>
            {!on && <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: o.color }} />}
            {o.label}
            {datePrompt(o) ? " …" : ""}
          </Button>
        );
      })}
    </div>
  );
}
