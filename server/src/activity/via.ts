import type { CallDirection, DialVia } from "../generated/prisma/client.js";

export const VIA_VALUES = ["LAPTOP", "APP", "PHONE_DIALER"] as const;

/**
 * How an outgoing call was dialled: the phone's own app-dial log wins, then a desktop click-to-call intent,
 * else the phone's dialer. Incoming, missed and unknown calls have no "via".
 */
export function decideCallVia(direction: CallDirection, bodyVia: DialVia | null | undefined, hasIntent: boolean): DialVia | null {
  if (direction !== "OUTGOING") return null;
  if (bodyVia === "APP") return "APP";
  if (hasIntent) return "LAPTOP";
  return "PHONE_DIALER";
}
