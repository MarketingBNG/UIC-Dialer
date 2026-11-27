import { api } from "./api";

/**
 * One-click calling from the laptop: the server asks the UIC app on the rep's phone to dial (it holds a live
 * connection while "Calls from PC" is on), and the phone answers back. Phone Link then carries the audio to the
 * laptop as usual. When no phone is listening or it doesn't answer in time, the caller falls back to tel:.
 */

/** LiveUpdates re-dispatches the server's "dialack" stream events as this window event. */
export const DIAL_ACK_EVENT = "uic-dial-ack";

export interface DialAck {
  id: string;
  ok: boolean;
  error?: string;
}

/** How long to wait for the phone to say it dialled (it may need to wake up). */
const ACK_WAIT_MS = 6000;

/**
 * "placed": the phone is dialling. "failed": the phone answered but couldn't (error shown to the rep).
 * "unavailable": no phone listening, no answer in time, or the request failed: use Phone Link's dialer instead.
 * Needs the dial intent for [clientId] (POST /api/dial-intents) made first.
 */
export async function dialOnPhone(clientId: string): Promise<{ result: "placed" | "failed" | "unavailable"; error?: string }> {
  let resolveAck: (a: DialAck) => void = () => {};
  const acked = new Promise<DialAck>((r) => (resolveAck = r));
  // Listen before asking, so a quick answer isn't missed.
  const onAck = (e: Event) => {
    const a = (e as CustomEvent<DialAck>).detail;
    if (a?.id === clientId) resolveAck(a);
  };
  window.addEventListener(DIAL_ACK_EVENT, onAck);
  try {
    const { phones } = await api<{ phones: number }>("/api/remote-dial", { method: "POST", body: { clientId } });
    if (phones === 0) return { result: "unavailable" };
    const ack = await Promise.race([acked, new Promise<null>((r) => setTimeout(() => r(null), ACK_WAIT_MS))]);
    if (!ack) return { result: "unavailable" };
    return ack.ok ? { result: "placed" } : { result: "failed", ...(ack.error ? { error: ack.error } : {}) };
  } catch {
    return { result: "unavailable" };
  } finally {
    window.removeEventListener(DIAL_ACK_EVENT, onAck);
  }
}
