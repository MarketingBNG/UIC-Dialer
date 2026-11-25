"""English translation jobs: their own loop, separate from the transcription slots.

Live calls (priority >= 10) are translated right away; backlog calls are collected and sent as one
Message Batch (50% off) once TRANSLATE_BATCH_MAX jobs are waiting or TRANSLATE_BATCH_WAIT_S has passed.
Every claimed job is heartbeated while it waits or while its batch runs (a batch can take hours).

A batch's id is saved on its jobs. When the worker stops (a deploy), it hands its jobs back at once; the next
worker that claims them waits for the same batch instead of sending (and paying for) a new one.
"""

import threading
import time
from typing import Callable

import structlog

from .config import Settings
from .pii import mask_segments
from .batches import BatchCancelled
from .translate import TranslationError, translate_batch, translate_segments

CLAIM_MAX = 20  # server limit per /internal/jobs/claim

log = structlog.get_logger()

LIVE_PRIORITY = 10
HEARTBEAT_SECONDS = 60


def segments_of(transcript: dict) -> list[dict]:
    """The transcript's segments; one segment per text line when it has none."""
    segs = transcript.get("segments") or []
    if segs:
        return segs
    return [{"text": line} for line in (transcript.get("text") or "").splitlines() if line.strip()]


def translation_payload(segments: list[dict], usage: dict, default_model: str, batch: bool, mask: bool = False) -> dict:
    if mask:
        # Claude may write a spoken number as digits, so the English side is masked too.
        segments = mask_segments(segments)
    return {
        "model": usage.get("model") or default_model,
        "textEn": "\n".join(s["en"] for s in segments),
        "segments": segments,
        "usage": {"inputTokens": usage.get("input_tokens", 0), "outputTokens": usage.get("output_tokens", 0),
                  "batch": batch},
    }


class Translator:
    """Claims `KIND` jobs; subclasses (the summarizer) override the work methods and the model."""

    KIND = "translate"

    @property
    def model(self) -> str:
        return self.settings.translate_model

    def __init__(self, api, client, settings: Settings, stopping: Callable[[], bool] = lambda: False,
                 clock: Callable[[], float] = time.monotonic, poll_s: float = 30) -> None:
        self.api, self.client, self.settings = api, client, settings
        self.stopping, self.clock, self.poll_s = stopping, clock, poll_s
        self.pending: list[dict] = []
        self.pending_since: float | None = None
        self.held: set[str] = set()  # job ids we keep alive with heartbeats
        self.lock = threading.Lock()
        self.batch_thread: threading.Thread | None = None
        self.resume_threads: list[threading.Thread] = []
        # Held while a new batch is sent and its id saved; release_held takes it too, so a shutdown never hands
        # jobs back between "batch sent (billed)" and "id saved" (the next worker would send it again).
        self.submit_lock = threading.Lock()
        self._beat_stop = threading.Event()
        self._thread: threading.Thread | None = None

    @classmethod
    def start(cls, api, settings: Settings, stopping: Callable[[], bool]) -> "Translator":
        import anthropic

        t = cls(api, anthropic.Anthropic(api_key=settings.anthropic_api_key), settings, stopping)
        t._thread = threading.Thread(target=t.run, name=cls.KIND, daemon=True)
        t._thread.start()
        return t

    def join(self) -> None:
        if self._thread:
            self._thread.join()

    # ---- loop ----

    def run(self) -> None:
        beat = threading.Thread(target=self._beat_loop, name=f"{self.KIND}-heartbeat", daemon=True)
        beat.start()
        idle = 1.0
        try:
            # Stop promptly: a batch can take hours, longer than any deploy waits. Its jobs are handed back with
            # their batch id (release_held) and the next worker resumes the batch.
            while not self.stopping():
                got = self.tick()
                if got:
                    idle = 1.0
                else:
                    time.sleep(idle)
                    idle = min(idle * 2, self.settings.idle_max_sleep)
        finally:
            self._beat_stop.set()
            self.release_held()

    def release_held(self) -> None:
        """Shutdown: hand every held job back to the queue at once (not counted as a failed attempt). Jobs already
        in a Claude batch keep its id, so the next worker waits for that batch instead of sending a new one."""
        with self.submit_lock:  # a batch being sent finishes saving its id first; later ones see stopping()
            with self.lock:
                ids, self.held = list(self.held), set()
                self.pending, self.pending_since = [], None
        for job_id in ids:
            self.api.release(job_id)

    def tick(self) -> int:
        """One round: claim, start a due batch, run live jobs. Returns jobs claimed."""
        jobs: list[dict] = []
        # The API hands out at most CLAIM_MAX jobs per request; bigger batches fill over several ticks.
        room = min(CLAIM_MAX, self.settings.translate_batch_max - len(self.pending))
        if not self.stopping() and room > 0:
            try:
                jobs = self.api.claim(room, (self.KIND,))
            except Exception:
                log.exception("claim failed", kind=self.KIND)
        live = []
        resume: dict[str, list[dict]] = {}
        with self.lock:
            for job in jobs:
                if job.get("batchId"):
                    # Sent in a batch before a worker restart: wait for that batch, whatever the priority.
                    self.held.add(job["jobId"])
                    resume.setdefault(job["batchId"], []).append(job)
                elif job.get("priority", 0) >= LIVE_PRIORITY:
                    live.append(job)
                else:
                    self.held.add(job["jobId"])
                    if not self.pending:
                        self.pending_since = self.clock()
                    self.pending.append(job)
        for batch_id, group in resume.items():
            t = threading.Thread(target=self._safe_batch, args=(group, batch_id), name=f"{self.KIND}-resume", daemon=True)
            self.resume_threads = [x for x in self.resume_threads if x.is_alive()] + [t]
            t.start()
        # Start a due batch before live work so live calls never delay the batch timer.
        self._maybe_start_batch()
        for job in live:
            self.translate_live(job)
        self._maybe_start_batch()
        return len(jobs)

    def _maybe_start_batch(self) -> None:
        if not self.pending or self._batch_running() or self.stopping():
            return
        full = len(self.pending) >= self.settings.translate_batch_max
        waited = self.pending_since is not None and self.clock() - self.pending_since >= self.settings.translate_batch_wait_s
        if not (full or waited):
            return
        with self.lock:
            jobs, self.pending, self.pending_since = self.pending, [], None
        if not jobs:
            return
        self.batch_thread = threading.Thread(target=self._safe_batch, args=(jobs,), name=f"{self.KIND}-batch", daemon=True)
        self.batch_thread.start()

    def _batch_running(self) -> bool:
        """Only the new-batch thread: resumed batches run alongside and don't hold up the next new batch."""
        return self.batch_thread is not None and self.batch_thread.is_alive()

    # ---- heartbeats ----

    def _hold(self, job_id: str) -> None:
        with self.lock:
            self.held.add(job_id)

    def _release(self, job_id: str) -> None:
        with self.lock:
            self.held.discard(job_id)

    def beat_once(self) -> None:
        with self.lock:
            ids = list(self.held)
        for job_id in ids:
            if not self.api.heartbeat(job_id):
                log.warning("lost translate job lock", job_id=job_id)
                with self.lock:
                    self.held.discard(job_id)
                    self.pending = [j for j in self.pending if j["jobId"] != job_id]
                    if not self.pending:
                        self.pending_since = None

    def _beat_loop(self) -> None:
        while not self._beat_stop.wait(HEARTBEAT_SECONDS):
            self.beat_once()

    # ---- work ----

    def _fail(self, job_id: str, e: BaseException) -> None:
        payload: dict = {"ok": False, "error": f"{type(e).__name__}: {e}"[:2000], "retryable": True}
        if usage := getattr(e, "usage", None):
            # Claude already charged for these tokens; the API adds them to the monthly spend.
            payload["model"] = usage.get("model") or self.model
            payload["usage"] = {"inputTokens": usage.get("input_tokens", 0), "outputTokens": usage.get("output_tokens", 0),
                                "batch": False}
        try:
            self.api.post_result(job_id, payload)
        except Exception:
            log.exception("could not report failure", kind=self.KIND, job_id=job_id)

    def translate_live(self, job: dict) -> None:
        job_id = job["jobId"]
        self._hold(job_id)
        try:
            segs = segments_of(self.api.get_transcript(job["callId"]))
            out, usage = translate_segments(self.client, segs, model=self.settings.translate_model)
            self.api.post_translation(job_id, translation_payload(out, usage, self.settings.translate_model, False,
                                                                       bool(job.get("maskPii"))))
            log.info("translated", job_id=job_id, call_id=job["callId"], batch=False)
        except Exception as e:  # noqa: BLE001 - reported and retried by the API
            log.exception("translate failed", job_id=job_id)
            self._fail(job_id, e)
        finally:
            self._release(job_id)

    def _safe_batch(self, jobs: list[dict], batch_id: str | None = None) -> None:
        try:
            self.translate_backlog(jobs, batch_id)
        except Exception:
            log.exception("batch crashed", kind=self.KIND)
        finally:
            if not self.stopping():  # on shutdown release_held hands them back instead
                for job in jobs:
                    self._release(job["jobId"])

    def _remember_batch(self, job_ids: list[str]):
        """on_submit callback: saves the new batch id on these jobs."""
        return lambda batch_id: self.api.set_batch(job_ids, batch_id)

    def _batch_opts(self, job_ids: list[str], batch_id: str | None) -> dict:
        """Keyword args for *_batch: resume [batch_id], or send a new batch under submit_lock and save its id."""
        return {"batch_id": batch_id, "on_submit": self._remember_batch(job_ids), "guard": self.submit_lock,
                "allowed": lambda: not self.stopping()}

    def _batch_failed(self, job_ids, e: BaseException) -> None:
        """Whole batch failed. On shutdown the jobs are handed back instead (release_held), not failed: failing
        would count an attempt and clear a batch id the next worker can still resume."""
        if self.stopping() or isinstance(e, BatchCancelled):
            return
        for job_id in job_ids:
            self._fail(job_id, e)

    def translate_backlog(self, jobs: list[dict], batch_id: str | None = None) -> None:
        calls: dict[str, list[dict]] = {}
        mask = {job["jobId"]: bool(job.get("maskPii")) for job in jobs}
        for job in jobs:
            try:
                calls[job["jobId"]] = segments_of(self.api.get_transcript(job["callId"]))
            except Exception as e:  # noqa: BLE001
                log.exception("could not fetch transcript", job_id=job["jobId"])
                self._fail(job["jobId"], e)
        if not calls:
            return
        try:
            results = translate_batch(self.client, calls, model=self.settings.translate_model, poll_s=self.poll_s,
                                      **self._batch_opts(list(calls), batch_id))
        except Exception as e:  # noqa: BLE001 - whole batch failed; every job is retried
            log.exception("translate batch failed", jobs=len(calls))
            self._batch_failed(calls, e)
            return
        for job_id in calls:
            r = results.get(job_id, TranslationError("missing from batch results"))
            if isinstance(r, Exception):
                self._fail(job_id, r)
                continue
            out, usage = r
            try:
                self.api.post_translation(job_id, translation_payload(out, usage, self.settings.translate_model, True,
                                                                       mask[job_id]))
            except Exception:
                log.exception("could not post translation", job_id=job_id)
        log.info("translate batch done", jobs=len(calls))
