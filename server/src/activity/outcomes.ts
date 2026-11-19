import { z } from "zod";
import { HttpError } from "../context.js";
import type { CallOutcome, OutcomeDef, OutcomeRule } from "../generated/prisma/client.js";

/** The seeded default outcomes (migration 20261118100000); old apps' plain `outcome` maps to these. */
export const DEFAULT_OUTCOME_IDS: Record<CallOutcome, string> = {
  INTERESTED: "00000000-0000-7000-8000-000000000001",
  CALL_BACK: "00000000-0000-7000-8000-000000000002",
  NOT_INTERESTED: "00000000-0000-7000-8000-000000000003",
  NO_ANSWER: "00000000-0000-7000-8000-000000000004",
};

export const OUTCOME_RULES = ["NONE", "ASK_FOLLOW_UP", "ASK_MEETING", "ASK_CALLBACK", "CLOSE_LEAD", "RETRY", "REMOVE_FROM_LISTS"] as const;
export const ASK_RULES: readonly OutcomeRule[] = ["ASK_FOLLOW_UP", "ASK_MEETING", "ASK_CALLBACK"];

export const OutcomeInput = z.object({
  label: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  baseOutcome: z.enum(["INTERESTED", "CALL_BACK", "NOT_INTERESTED", "NO_ANSWER"]),
  rule: z.enum(OUTCOME_RULES),
  retryHours: z.number().int().min(1).max(720).nullable().optional(),
  addToDnc: z.boolean().optional(),
  active: z.boolean().optional(),
});

/** Admin validation (§2.2): CALL_BACK needs a date rule; RETRY needs its hours. */
export function checkOutcomeCombo(o: { baseOutcome: CallOutcome; rule: OutcomeRule; retryHours?: number | null | undefined }) {
  if (o.baseOutcome === "CALL_BACK" && !ASK_RULES.includes(o.rule) && o.rule !== "RETRY") {
    throw new HttpError(400, "A Call back outcome must ask for a date or retry");
  }
  if (o.rule === "RETRY" && !o.retryHours) throw new HttpError(400, "Retry needs retryHours (1-720)");
}

export function outcomeDto(o: OutcomeDef) {
  return {
    id: o.id,
    key: o.key,
    label: o.label,
    color: o.color,
    sortOrder: o.sortOrder,
    active: o.active,
    baseOutcome: o.baseOutcome,
    rule: o.rule,
    retryHours: o.retryHours,
    addToDnc: o.addToDnc,
  };
}

/** Does this rule (with this base) put the activity's followUpAt on the contact? */
export function keepsFollowUp(def: Pick<OutcomeDef, "rule" | "baseOutcome"> | null, base: CallOutcome) {
  if (!def) return base === "CALL_BACK";
  if (ASK_RULES.includes(def.rule) || def.rule === "RETRY") return true;
  return def.rule === "NONE" && base === "CALL_BACK";
}

/**
 * `{name}` = first word of the contact name (or "there"), `{rep}` = the rep's first name (name, else the email's
 * local part). Case-sensitive; unknown placeholders stay. The dashboard and the app implement the same rule.
 */
export function renderTemplate(body: string, contactName: string | null | undefined, repName: string | null | undefined): string {
  const first = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] ?? "";
  const name = first(contactName) || "there";
  const repRaw = (repName ?? "").includes("@") && !(repName ?? "").includes(" ") ? (repName ?? "").split("@")[0]! : repName;
  const rep = first(repRaw);
  return body.replace(/\{(name|rep)\}/g, (_m, k: string) => (k === "name" ? name : rep));
}

/** The rep's display name for {rep}: name, else the email's local part. */
export const repDisplayName = (u: { name: string | null; email: string }) => u.name?.trim() || u.email.split("@")[0]!;
