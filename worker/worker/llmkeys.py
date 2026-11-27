"""Anthropic key failover: when a key runs out of credit, switch to the next one (ANTHROPIC_API_KEY, then
ANTHROPIC_API_KEY_2), like Lead-Enrichment's service/src/adapters/llm/keys.ts.

A key that ran out is skipped for 24 h, then tried again (credit may have been topped up). Ordinary rate limits
(429) and server errors are not credit errors and never switch keys; the callers' own retries handle those.

Message Batches belong to the key (workspace) that created them, so a batch is always polled and read with that
key; one resumed after a restart (key unknown) is looked up with each key in turn.
"""
from __future__ import annotations

import re
import threading
import time
from typing import Any, Callable

import structlog

log = structlog.get_logger()

PROBE_AFTER_S = 24 * 3600
_CREDIT = re.compile(r"credit balance (is )?too low|billing|usage limits?|insufficient.{0,20}credit", re.I)


def is_credit_error(e: BaseException) -> bool:
    """No credit / quota left on the key (not a 429 rate limit, not a 5xx)."""
    status = getattr(e, "status_code", None)
    if status == 402:
        return True
    if status in (400, 403):
        return bool(_CREDIT.search(str(e)))
    return False


def _not_found(e: BaseException) -> bool:
    return getattr(e, "status_code", None) == 404


class FailoverClient:
    """Drop-in for anthropic.Anthropic in the worker: .messages.create and .messages.batches.create / retrieve /
    results, switching keys on credit errors."""

    def __init__(self, keys: list[tuple[str, Any]], clock: Callable[[], float] = time.time) -> None:
        if not keys:
            raise ValueError("no Anthropic keys")
        self._keys = keys  # [(label, anthropic client)], in order of preference
        self._clock = clock
        self._out: dict[str, float] = {}  # label -> when it ran out of credit
        self._batch_key: dict[str, str] = {}  # batch id -> label of the key that created it
        self._lock = threading.Lock()
        self.messages = _Messages(self)

    # ---- key choice ----

    def _usable(self) -> list[tuple[str, Any]]:
        now = self._clock()
        with self._lock:
            ok = [(label, c) for label, c in self._keys if now - self._out.get(label, -PROBE_AFTER_S) >= PROBE_AFTER_S]
        # Every key out: try them anyway (in order) rather than stop translating for a day.
        return ok or list(self._keys)

    def _mark_out(self, label: str, e: BaseException, nxt: str | None) -> None:
        with self._lock:
            self._out[label] = self._clock()
        if nxt:
            log.warning("anthropic key out of credit; switched", key=label, to=nxt, error=str(e)[:200])
        else:
            log.error("anthropic key out of credit; no other key left", key=label, error=str(e)[:200])

    def _cleared(self, label: str) -> None:
        with self._lock:
            if self._out.pop(label, None) is not None:
                log.info("anthropic key works again", key=label)

    def _call(self, fn: Callable[[Any], Any]) -> tuple[str, Any]:
        """Runs [fn] with the first usable key, moving to the next one on a credit error."""
        keys = self._usable()
        for i, (label, client) in enumerate(keys):
            try:
                out = fn(client)
            except Exception as e:  # noqa: BLE001
                if not is_credit_error(e):
                    raise
                self._mark_out(label, e, keys[i + 1][0] if i + 1 < len(keys) else None)
                if i + 1 == len(keys):
                    raise
                continue
            self._cleared(label)
            return label, out
        raise RuntimeError("unreachable")

    def _with_batch_key(self, batch_id: str, fn: Callable[[Any], Any]) -> Any:
        """Runs [fn] with the key that owns [batch_id]; unknown (resumed) batches try each key until one has it."""
        with self._lock:
            known = self._batch_key.get(batch_id)
        order = [k for k in self._keys if k[0] == known] or list(self._keys)
        for i, (label, client) in enumerate(order):
            try:
                out = fn(client)
            except Exception as e:  # noqa: BLE001
                if _not_found(e) and not known and i + 1 < len(order):
                    continue
                raise
            with self._lock:
                self._batch_key[batch_id] = label
            return out
        raise RuntimeError("unreachable")


class _Messages:
    def __init__(self, fc: FailoverClient) -> None:
        self._fc = fc
        self.batches = _Batches(fc)

    def create(self, **kwargs: Any) -> Any:
        return self._fc._call(lambda c: c.messages.create(**kwargs))[1]


class _Batches:
    def __init__(self, fc: FailoverClient) -> None:
        self._fc = fc

    def create(self, **kwargs: Any) -> Any:
        label, batch = self._fc._call(lambda c: c.messages.batches.create(**kwargs))
        with self._fc._lock:
            self._fc._batch_key[batch.id] = label
        return batch

    def retrieve(self, batch_id: str) -> Any:
        return self._fc._with_batch_key(batch_id, lambda c: c.messages.batches.retrieve(batch_id))

    def results(self, batch_id: str) -> Any:
        return self._fc._with_batch_key(batch_id, lambda c: list(c.messages.batches.results(batch_id)))


def make_client(settings) -> FailoverClient:
    import anthropic

    keys = [("anthropic-1", anthropic.Anthropic(api_key=settings.anthropic_api_key))]
    if settings.anthropic_api_key_2:
        keys.append(("anthropic-2", anthropic.Anthropic(api_key=settings.anthropic_api_key_2)))
    return FailoverClient(keys)
