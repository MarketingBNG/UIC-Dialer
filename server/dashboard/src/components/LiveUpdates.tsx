import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { RING_EVENT } from "./IncomingCall";

/**
 * Keeps the dashboard / Windows app in step with the phone: the server sends a small
 * "something changed" notice (no data) over /api/events, and we refetch whatever is on
 * screen. EventSource reconnects by itself; after a reconnect we refetch everything,
 * since changes may have been missed while offline.
 */
export function LiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connectedOnce = false;
    // Several notices often arrive together (outcome + contact + follow-up): refetch once.
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void qc.invalidateQueries({ refetchType: "active" }), 300);
    };
    const es = new EventSource("/api/events");
    es.addEventListener("ready", () => {
      if (connectedOnce) refresh();
      connectedOnce = true;
    });
    es.addEventListener("change", refresh);
    // The rep's phone is ringing / answered / done: the caller card (IncomingCall) shows who it is.
    es.addEventListener("ringing", (e) => {
      try {
        window.dispatchEvent(new CustomEvent(RING_EVENT, { detail: JSON.parse((e as MessageEvent<string>).data) }));
      } catch {
        /* ignore malformed */
      }
    });
    // Back from sleep / another tab: catch up straight away.
    const onVisible = () => {
      if (document.visibilityState === "visible" && es.readyState !== EventSource.OPEN) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      es.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [qc]);
  return null;
}
