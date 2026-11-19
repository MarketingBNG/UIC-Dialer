"""AI call score jobs: the same loop as translation and summaries (live calls now, backlog in one Message Batch,
heartbeats, failure usage reported toward the Claude monthly cap), with score.py doing the work."""

import structlog

from .pii import mask_text
from .score import ScoreError, score_batch, score_call
from .translator import Translator

log = structlog.get_logger()


def score_payload(out: dict, usage: dict, default_model: str, batch: bool, script_id: str | None,
                  mask: bool = False) -> dict:
    if mask:
        # Admin privacy setting: Aadhaar / card numbers never reach the database.
        out = {
            **out,
            "nextStep": mask_text(out["nextStep"]) if out.get("nextStep") else out.get("nextStep"),
            "objections": [{**o, "objection": mask_text(o["objection"])} for o in out["objections"]],
            "strengths": [mask_text(s) for s in out["strengths"]],
            "improvements": [mask_text(s) for s in out["improvements"]],
        }
    return {
        **out,
        "scriptId": script_id,
        "model": usage.get("model") or default_model,
        "usage": {"inputTokens": usage.get("input_tokens", 0), "outputTokens": usage.get("output_tokens", 0),
                  "batch": batch},
    }


class Scorer(Translator):
    KIND = "score"

    @property
    def model(self) -> str:
        return self.settings.score_model

    def translate_live(self, job: dict) -> None:
        job_id = job["jobId"]
        self._hold(job_id)
        try:
            transcript = self.api.get_transcript(job["callId"])
            out, usage = score_call(self.client, transcript, job.get("agentName"), job.get("script"), self.model)
            self.api.post_score(job_id, score_payload(out, usage, self.model, False, job.get("scriptId"),
                                                      bool(job.get("maskPii"))))
            log.info("scored", job_id=job_id, call_id=job["callId"], batch=False)
        except Exception as e:  # noqa: BLE001 - reported and retried by the API
            log.exception("score failed", job_id=job_id)
            self._fail(job_id, e)
        finally:
            self._release(job_id)

    def translate_backlog(self, jobs: list[dict]) -> None:
        calls: dict[str, tuple[dict, str | None, dict | None]] = {}
        by_id = {job["jobId"]: job for job in jobs}
        for job in jobs:
            try:
                calls[job["jobId"]] = (self.api.get_transcript(job["callId"]), job.get("agentName"), job.get("script"))
            except Exception as e:  # noqa: BLE001
                log.exception("could not fetch transcript", job_id=job["jobId"])
                self._fail(job["jobId"], e)
        if not calls:
            return
        try:
            results = score_batch(self.client, calls, model=self.model, poll_s=self.poll_s)
        except Exception as e:  # noqa: BLE001 - whole batch failed; every job is retried
            log.exception("score batch failed", jobs=len(calls))
            for job_id in calls:
                self._fail(job_id, e)
            return
        for job_id in calls:
            r = results.get(job_id, ScoreError("missing from batch results"))
            if isinstance(r, Exception):
                self._fail(job_id, r)
                continue
            out, usage = r
            job = by_id[job_id]
            try:
                self.api.post_score(job_id, score_payload(out, usage, self.model, True, job.get("scriptId"),
                                                          bool(job.get("maskPii"))))
            except Exception:
                log.exception("could not post score", job_id=job_id)
        log.info("score batch done", jobs=len(calls))
