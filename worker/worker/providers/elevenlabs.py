"""ElevenLabs Scribe transcription, with a free speech check first and Fireflies as the fallback.

Per call:
  1. a job already uploaded to Fireflies stays there (the server says so in the claim);
  2. otherwise the audio is downloaded and its speech found locally (vad.py, free);
  3. a copy without the long silences goes to Scribe (every call is transcribed, so nothing is missed);
     times are mapped back to the original recording;
  4. the transcript is deleted from ElevenLabs once we have it;
  5. a call with no real talk left once greetings ("hello", "yes") and voicemail / network messages are
     removed is tagged NO_SPEECH or VOICEMAIL: the transcript is kept, but no translation or summary is made.
When ElevenLabs says the credits are used up, calls go to Fireflies (if configured) for the next hour.
"""

import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import httpx
import structlog

from .. import vad
from ..config import Settings
from . import PermanentError, Transcript

log = structlog.get_logger()

API = "https://api.elevenlabs.io/v1/speech-to-text"
EXHAUSTED_PAUSE_S = 3600
# Fewer real words than this (after voicemail sentences and greetings) -> tagged, no summary.
MIN_REAL_WORDS = 4
VOICEMAIL = re.compile(
    r"forwarded to (the )?voice ?mail|record your (name|message)|leave (a|your) message|at the (tone|beep)"
    r"|after the (tone|beep)|(person|number|subscriber) you (are|have|have been|re) (trying|calling|dialled|dialed)"
    r"|is (currently )?(not reachable|switched off|unreachable)|out of (network )?coverage|please try (again )?later"
    r"|mailbox is full|cannot pick up|truecaller|(see|check) if this person is available"
    r"|(person|subscriber) (is|you.{0,20}is) (not|currently not) available|stay on the line|hang up"
    r"|finished recording|(would like|wish) to leave|not answering|उत्तर नहीं दे रहे|व्यस्त है"
    r"|आप जिस (नंबर|व्यक्ति)|स्विच ऑफ|पहुंच से बाहर|कृपया (थोड़ी देर बाद|बाद में)", re.IGNORECASE)


class QuotaExceeded(Exception):
    """ElevenLabs can't be used right now: credits / the key's credit limit used up, or the key refused.
    Never fails a job: calls go to the fallback (or wait) and ElevenLabs is tried again an hour later."""


FILLER = {"hello", "hallo", "helo", "hi", "hey", "yes", "yeah", "ya", "yep", "no", "ok", "okay", "hmm", "hm",
          "um", "uh", "umm", "ah", "oh", "sir", "madam", "ma'am", "ji", "haan", "han", "ha", "accha", "acha",
          "हेलो", "हैलो", "हलो", "हाँ", "हां", "हा", "जी", "हम्म", "अच्छा", "ओके", "नहीं", "उम्म", "अ", "सर"}
_SENTENCE = re.compile(r"(?<=[.?!।|])\s+|\n+")
_PUNCT = ".,?!।|;:-–—\"'()[]…"


def classify(text: str) -> str | None:
    """VOICEMAIL / NO_SPEECH when nothing real was said; None for a real conversation (even one with a
    voicemail message in it)."""
    real, voicemail = 0, False
    for sentence in _SENTENCE.split(text):
        if VOICEMAIL.search(sentence):
            voicemail = True
            continue
        words = (w.strip(_PUNCT) for w in sentence.lower().split())
        real += sum(1 for w in words if w and w not in FILLER)
    if real >= MIN_REAL_WORDS:
        return None
    return "VOICEMAIL" if voicemail else "NO_SPEECH"


def words_to_segments(words: list[dict], to_original=lambda t: t) -> list[dict]:
    """Scribe's word list -> our segments: one per speaker turn (split on pauses over 1.5 s or 30 s length)."""
    segs: list[dict] = []
    cur: dict | None = None
    for w in words:
        kind = w.get("type", "word")
        if kind == "audio_event":
            continue
        text = w.get("text", "")
        if kind == "spacing":
            if cur is not None:
                cur["text"] += text
            continue
        start, end = float(w.get("start") or 0), float(w.get("end") or 0)
        speaker = w.get("speaker_id")
        if (cur is None or speaker != cur["_spk"] or start - cur["_end"] > 1.5 or end - cur["_start"] > 30):
            if cur is not None:
                segs.append(cur)
            cur = {"_spk": speaker, "_start": start, "_end": end, "text": ""}
        cur["text"] += text
        cur["_end"] = end
    if cur is not None:
        segs.append(cur)
    names: dict[Any, str] = {}
    out = []
    for s in segs:
        text = re.sub(r"\s+", " ", s["text"]).strip()
        if not text:
            continue
        seg = {"start": to_original(s["_start"]), "end": to_original(s["_end"]), "text": text}
        if s["_spk"] is not None:
            seg["speaker"] = names.setdefault(s["_spk"], f"Speaker {len(names) + 1}")
        out.append(seg)
    return out


class ElevenLabsProvider:
    name = "elevenlabs"
    remote = True  # handles the whole job itself (download, check, fallback); see main.process_job

    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None, fallback=None,
                 decode=vad.decode) -> None:
        if not settings.elevenlabs_api_key:
            raise SystemExit("ELEVENLABS_API_KEY is required for TRANSCRIBE_PROVIDER=elevenlabs")
        self.settings = settings
        self.http = httpx.Client(headers={"xi-api-key": settings.elevenlabs_api_key},
                                 timeout=httpx.Timeout(900, connect=15), transport=transport)
        self.fallback = fallback
        self.decode = decode
        self._slots = threading.BoundedSemaphore(settings.elevenlabs_concurrency)
        self._exhausted_until = 0.0

    def transcribe(self, *_: Any) -> Transcript:
        raise NotImplementedError("use transcribe_job")

    def sweep_leftovers(self, api) -> int:
        return self.fallback.sweep_leftovers(api) if self.fallback and hasattr(self.fallback, "sweep_leftovers") else 0

    # ---- one job ----

    def transcribe_job(self, api, job: dict, language: str | None) -> Transcript:
        if job.get("firefliesUploaded") and self.fallback:
            # Already sent to (and paid at) Fireflies: wait for that transcript.
            return self.fallback.transcribe_job(api, job, language)
        if time.monotonic() < self._exhausted_until:
            return self._fall_back(api, job, language, "credits used up")
        try:
            # Decoded audio is large: only ELEVENLABS_CONCURRENCY calls are held in memory at once.
            with self._slots:
                with tempfile.TemporaryDirectory(prefix="uic-el-") as tmp:
                    path = Path(tmp) / "audio.bin"
                    api.download(job["audioPath"], path)
                    try:
                        audio = self.decode(path)
                    except Exception as e:  # noqa: BLE001 - ffmpeg can't read it; retrying won't help
                        raise PermanentError(f"UNREADABLE_AUDIO: {e}"[:500]) from e
                parts = vad.speech_parts(audio)
                # No speech found at all: send the whole file anyway (quiet speech the check missed is caught).
                trimmed = vad.trim(audio, parts) if parts else vad.trim(audio, [(0, len(audio) / vad.SR)])
                del audio
                data = self._scribe(trimmed.wav, language)
        except QuotaExceeded as e:
            self._exhausted_until = time.monotonic() + EXHAUSTED_PAUSE_S
            log.warning("elevenlabs unavailable (credits or key); using fallback for an hour", error=str(e))
            return self._fall_back(api, job, language, str(e))
        segments = words_to_segments(data.get("words") or [], trimmed.to_original)
        text = "\n".join(s["text"] for s in segments) or (data.get("text") or "").strip()
        tag = classify(text)
        log.info("elevenlabs transcribed", job_id=job["jobId"], audio_s=round(trimmed.original_s),
                 sent_s=round(trimmed.trimmed_s), tag=tag)
        return Transcript(text=text, provider=self.name, language=data.get("language_code"), segments=segments,
                          tag=tag)

    def _fall_back(self, api, job: dict, language: str | None, why: str) -> Transcript:
        if self.fallback:
            return self.fallback.transcribe_job(api, job, language)
        raise RuntimeError(f"ELEVENLABS: {why}")  # the API retries the job later

    def _scribe(self, wav: bytes, language: str | None) -> dict:
        form = {"model_id": self.settings.elevenlabs_model, "diarize": "true", "tag_audio_events": "false",
                "timestamps_granularity": "word"}
        if language:
            form["language_code"] = language
        for attempt in range(6):
            res = self.http.post(API, data=form, files={"file": ("audio.wav", wav, "audio/wav")})
            if res.status_code == 200:
                data = res.json()
                self._delete(data.get("transcription_id"))
                return data
            body = res.text[:500]
            if res.status_code in (401, 402, 403) or "quota_exceeded" in body:
                # Credits / key limit used up, or the key was refused: pause ElevenLabs, never fail the call.
                raise QuotaExceeded(f"{res.status_code}: {body}")
            if res.status_code == 429 or res.status_code >= 500:
                time.sleep(min(60, 5 * 2 ** attempt))
                continue
            raise RuntimeError(f"ELEVENLABS {res.status_code}: {body}")
        raise RuntimeError("ELEVENLABS: still busy after retries")

    def _delete(self, transcription_id: str | None) -> None:
        """Nothing stays at ElevenLabs: our copy is in the database."""
        if not transcription_id:
            return
        try:
            r = self.http.delete(f"{API}/transcripts/{transcription_id}", timeout=30)
            if r.status_code >= 400:
                log.warning("elevenlabs delete failed", id=transcription_id, status=r.status_code, body=r.text[:200])
        except httpx.HTTPError as e:
            log.warning("elevenlabs delete failed", id=transcription_id, error=str(e))
