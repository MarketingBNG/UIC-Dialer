"""Claude Message Batches shared by translate / summarize / score: send once, resume after a restart."""

import contextlib
import time
from typing import Callable

import structlog

log = structlog.get_logger()

# Waiting on a batch takes hours; a network blip or a 429/5xx while polling must not throw the batch away
# (the jobs would be failed, the batch id cleared and the same work sent and billed again).
RETRY_MAX_SLEEP_S = 300
RESULTS_TRIES = 5


class BatchCancelled(Exception):
    """Shutdown began before the batch was sent: nothing was sent or billed."""


def _definitive(e: Exception) -> bool:
    """Errors that retrying can't fix: bad request, auth, or the batch is gone (expired / deleted)."""
    status = getattr(e, "status_code", None)
    return status in (400, 401, 403, 404)


def open_batch(client, build_requests: Callable[[], list[dict]], batch_id: str | None = None,
               on_submit: Callable[[str], None] | None = None, guard=None,
               allowed: Callable[[], bool] | None = None) -> str:
    """The batch to wait for: [batch_id] when resuming one sent before a worker restart, else a new one.

    A new batch is sent and its id saved ([on_submit]) while holding [guard], so a worker shutting down (which
    takes the same lock before handing its jobs back) never leaves a paid batch without its id. If [allowed]
    says no (shutdown began), nothing is sent and BatchCancelled is raised."""
    if batch_id:
        log.info("resuming batch", batch_id=batch_id)
        return batch_id
    with guard if guard is not None else contextlib.nullcontext():
        if allowed is not None and not allowed():
            raise BatchCancelled()
        batch = client.messages.batches.create(requests=build_requests())
        if on_submit:
            try:
                on_submit(batch.id)
            except Exception:  # noqa: BLE001 - the batch still runs; only resume-after-restart is lost
                log.exception("could not save batch id", batch_id=batch.id)
    return batch.id


def wait_batch(client, batch_id: str, poll_s: float) -> None:
    errors = 0
    while True:
        try:
            if client.messages.batches.retrieve(batch_id).processing_status == "ended":
                return
            errors = 0
        except Exception as e:  # noqa: BLE001
            if _definitive(e):
                raise
            errors += 1
            log.warning("batch poll failed; retrying", batch_id=batch_id, error=f"{type(e).__name__}: {e}"[:200])
            time.sleep(min(RETRY_MAX_SLEEP_S, poll_s * 2 ** min(errors, 6)))
            continue
        time.sleep(poll_s)


def batch_results(client, batch_id: str, poll_s: float = 30) -> list:
    """All results of an ended batch, retrying transient errors (the whole list, so a retry never repeats a reply)."""
    for attempt in range(1, RESULTS_TRIES + 1):
        try:
            return list(client.messages.batches.results(batch_id))
        except Exception as e:  # noqa: BLE001
            if _definitive(e) or attempt == RESULTS_TRIES:
                raise
            log.warning("batch results failed; retrying", batch_id=batch_id, attempt=attempt)
            time.sleep(min(RETRY_MAX_SLEEP_S, poll_s * 2 ** attempt))
    return []
