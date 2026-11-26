import os
import socket
from dataclasses import dataclass


def load_dotenv(path: str = ".env") -> None:
    """Local dev convenience: KEY="value" lines; real env vars (e.g. Coolify) win."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class Settings:
    api_url: str
    worker_token: str
    worker_id: str
    provider: str
    language: str | None
    concurrency: int
    idle_max_sleep: float
    # Provider-specific
    openai_api_key: str | None
    openai_model: str
    fireflies_api_key: str | None = None
    # Fireflies jobs are short now (upload, or one check), so this mostly bounds upload bursts.
    fireflies_concurrency: int = 20
    # English translation with Claude (off when no key)
    anthropic_api_key: str | None = None
    translate_model: str = "claude-opus-5-5"
    translate_batch_max: int = 100
    translate_batch_wait_s: float = 900
    # AI call summaries (summarize jobs; same batch size / wait as translation)
    summary_model: str = "claude-sonnet-5-5"
    summarize_enabled: bool = True
    # AI call scores (score jobs). Off unless SCORE_ENABLED; the model defaults to the summary model.
    score_enabled: bool = False
    score_model: str = "claude-sonnet-5-5"
    # Re-encode large transcribed recordings to small AAC (needs ffmpeg on PATH)
    compress_enabled: bool = True

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        e = os.environ if env is None else env
        token = e.get("WORKER_TOKEN", "")
        if len(token) < 32:
            raise SystemExit("WORKER_TOKEN must be set (32+ chars)")
        return cls(
            api_url=e.get("API_URL", "http://localhost:8000").rstrip("/"),
            worker_token=token,
            worker_id=e.get("WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}",
            provider=e.get("TRANSCRIBE_PROVIDER", "stub"),
            language=e.get("TRANSCRIBE_LANGUAGE") or None,
            # Jobs transcribed in parallel by this worker process.
            concurrency=max(1, int(e.get("WORKER_CONCURRENCY", "4"))),
            idle_max_sleep=float(e.get("WORKER_IDLE_MAX_SLEEP", "30")),
            openai_api_key=e.get("OPENAI_API_KEY") or None,
            openai_model=e.get("OPENAI_TRANSCRIBE_MODEL", "whisper-1"),
            fireflies_api_key=e.get("FIREFLIES_API_KEY") or None,
            fireflies_concurrency=max(1, int(e.get("FIREFLIES_CONCURRENCY", "20"))),
            anthropic_api_key=e.get("ANTHROPIC_API_KEY") or None,
            translate_model=e.get("TRANSLATE_MODEL") or "claude-opus-5-5",
            # Backlog translations: one Message Batch per this many calls, or after this long.
            translate_batch_max=max(1, int(e.get("TRANSLATE_BATCH_MAX", "100"))),
            translate_batch_wait_s=float(e.get("TRANSLATE_BATCH_WAIT_S", "900")),
            summary_model=e.get("SUMMARY_MODEL") or "claude-sonnet-5-5",
            # Summaries are only queued when the server has SUMMARIZE_ENABLED (or an admin backfill).
            summarize_enabled=(e.get("SUMMARIZE_ENABLED") or "true").lower() not in ("false", "0", "no"),
            # Scores are only queued when the server has SCORE_ENABLED (or an admin backfill); off by default.
            score_enabled=(e.get("SCORE_ENABLED") or "false").lower() in ("true", "1", "yes"),
            score_model=e.get("SCORE_MODEL") or e.get("SUMMARY_MODEL") or "claude-sonnet-5-5",
            compress_enabled=(e.get("COMPRESS_ENABLED") or "true").lower() not in ("false", "0", "no"),
        )
