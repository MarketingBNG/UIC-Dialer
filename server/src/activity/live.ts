/**
 * Who is on a call right now, from the phones' /v1/ringing reports (incoming calls only: ringing / answered / ended).
 * In memory per server instance; every instance sees every report through the realtime fan-out.
 * A lost "ended" report must not leave a rep "on a call" forever, so states expire.
 */

export type LiveState = "ringing" | "onCall";

/** A ring with no answer / end report is stale after this. */
export const RINGING_MAX_MS = 2 * 60_000;
/** An answered call with no end report is stale after this. */
export const ON_CALL_MAX_MS = 90 * 60_000;

interface Entry {
  state: LiveState;
  since: number;
}

export class LiveCalls {
  private readonly byUser = new Map<string, Entry>();

  /** Applies one phone report. */
  report(userId: string, state: "ringing" | "answered" | "ended", at = Date.now()): void {
    if (state === "ended") {
      this.byUser.delete(userId);
      return;
    }
    const next: LiveState = state === "answered" ? "onCall" : "ringing";
    const cur = this.byUser.get(userId);
    // Keep the start time while the same call goes on (repeated reports).
    if (cur && cur.state === next && this.fresh(cur, at)) return;
    this.byUser.set(userId, { state: next, since: at });
  }

  /** The rep's live state now, or null (idle / stale). */
  get(userId: string, now = Date.now()): { state: LiveState; since: Date } | null {
    const e = this.byUser.get(userId);
    if (!e) return null;
    if (!this.fresh(e, now)) {
      this.byUser.delete(userId);
      return null;
    }
    return { state: e.state, since: new Date(e.since) };
  }

  private fresh(e: Entry, now: number): boolean {
    return now - e.since <= (e.state === "ringing" ? RINGING_MAX_MS : ON_CALL_MAX_MS);
  }
}

/** Calls-table counts by direction: outgoing, incoming (picked up) and missed. UNKNOWN counts as neither. */
export interface DirectionCounts {
  outgoing: number;
  incoming: number;
  missed: number;
}

export function directionCounts(rows: { userId: string; direction: string; n: number }[], userIds: string[]): Map<string, DirectionCounts> {
  const out = new Map<string, DirectionCounts>(userIds.map((id) => [id, { outgoing: 0, incoming: 0, missed: 0 }]));
  for (const r of rows) {
    const c = out.get(r.userId);
    if (!c) continue;
    if (r.direction === "OUTGOING") c.outgoing += r.n;
    else if (r.direction === "INCOMING") c.incoming += r.n;
    else if (r.direction === "MISSED") c.missed += r.n;
  }
  return out;
}
