import numpy as np
import pytest
import respx
from httpx import Response

from worker import vad
from worker.config import Settings
from worker.providers import PermanentError, Transcript
from worker.providers.elevenlabs import API, ElevenLabsProvider, classify, words_to_segments

SR = vad.SR


def settings(**kw) -> Settings:
    env = {"WORKER_TOKEN": "x" * 40, "ELEVENLABS_API_KEY": "sk_test", "TRANSCRIBE_PROVIDER": "elevenlabs"}
    env.update(kw)
    return Settings.from_env(env)


class FakeApi:
    def __init__(self) -> None:
        self.downloads = 0

    def download(self, path, dest) -> None:
        self.downloads += 1
        dest.write_bytes(b"audio")


class FakeFallback:
    def __init__(self) -> None:
        self.jobs = []

    def transcribe_job(self, api, job, language):
        self.jobs.append(job["jobId"])
        return Transcript(text="from fireflies", provider="fireflies")


def provider(monkeypatch, parts, fallback=None, audio_s=60.0):
    monkeypatch.setattr(vad, "speech_parts", lambda audio: parts)
    return ElevenLabsProvider(settings(), fallback=fallback,
                              decode=lambda p: np.zeros(int(audio_s * SR), dtype=np.float32))


JOB = {"jobId": "j1", "callId": "c1", "audioPath": "/internal/audio/c1"}
WORDS = [
    {"text": "Hello", "start": 0.0, "end": 0.5, "type": "word", "speaker_id": "speaker_0"},
    {"text": " ", "type": "spacing"},
    {"text": "sir.", "start": 0.5, "end": 0.9, "type": "word", "speaker_id": "speaker_0"},
    {"text": "(laughs)", "start": 1.0, "end": 1.2, "type": "audio_event", "speaker_id": "speaker_1"},
    {"text": "हाँ", "start": 1.4, "end": 1.8, "type": "word", "speaker_id": "speaker_1"},
]


def test_words_to_segments_by_speaker_and_mapped_times():
    segs = words_to_segments(WORDS, lambda t: t + 10)
    assert segs == [
        {"start": 10.0, "end": 10.9, "text": "Hello sir.", "speaker": "Speaker 1"},
        {"start": 11.4, "end": 11.8, "text": "हाँ", "speaker": "Speaker 2"},
    ]


def test_classify():
    assert classify("Your call has been forwarded to voicemail. The person you're trying to reach is not available.") == "VOICEMAIL"
    assert classify("Hi. If you record your name and reason for calling, I'll see if this person is available. "
                    "Insurance company. Thanks. Please stay on the line.") == "VOICEMAIL"
    assert classify("Hello? Hello?\nहाँ जी।") == "NO_SPEECH"
    assert classify("") == "NO_SPEECH"
    # A real conversation that ends in a network message is not voicemail.
    assert classify("Hello.\nSo first we'll talk internally and then I'll add her.\n"
                    "आप जिस व्यक्ति को call कर रहे हैं, वह उत्तर नहीं दे रहे हैं।") is None
    assert classify("I'll see if this person is available. Hello, Mr. Rana. It's regarding the US company registration.") is None
    assert classify("हेलो. जी sir, मैं हार्दिक बात कर रहा हूँ USA India CFO से।") is None


def test_trim_maps_times_back():
    audio = np.zeros(SR * 60, dtype=np.float32)
    t = vad.trim(audio, [(10.0, 12.0), (40.0, 41.0)])
    # 10-12 padded to 9.7-12.3 (2.6 s), gap 0.4 s, then 39.7-41.3
    assert t.pieces == [(0.0, 9.7), (3.0, 39.7)]
    assert t.to_original(1.0) == 10.7
    assert t.to_original(3.5) == 40.2
    assert round(t.trimmed_s, 1) == 4.6
    assert t.wav[:4] == b"RIFF"


@respx.mock
def test_silent_file_is_still_sent_whole(monkeypatch):
    route = respx.post(API).mock(return_value=Response(200, json={"text": "", "words": [], "transcription_id": "t1"}))
    respx.delete(f"{API}/transcripts/t1").mock(return_value=Response(200, json={}))
    p = provider(monkeypatch, [], audio_s=3.0)
    t = p.transcribe_job(FakeApi(), JOB, None)
    assert route.called and t.tag == "NO_SPEECH" and t.text == ""


@respx.mock
def test_transcribes_tags_voicemail_and_deletes(monkeypatch):
    words = [{"text": "Your call has been forwarded to voicemail.", "start": 0.0, "end": 3.0, "type": "word",
              "speaker_id": "speaker_0"}]
    post = respx.post(API).mock(return_value=Response(200, json={"text": "x", "language_code": "eng", "words": words,
                                                                 "transcription_id": "t9"}))
    delete = respx.delete(f"{API}/transcripts/t9").mock(return_value=Response(200, json={}))
    p = provider(monkeypatch, [(0.0, 8.0)])
    t = p.transcribe_job(FakeApi(), JOB, None)
    assert t.tag == "VOICEMAIL" and t.provider == "elevenlabs" and t.language == "eng"
    assert post.called and delete.called
    body = post.calls[0].request.content
    assert b'name="tag_audio_events"' in body and b"RIFF" in body


def test_fireflies_upload_stays_with_fireflies(monkeypatch):
    fb = FakeFallback()
    api = FakeApi()
    p = provider(monkeypatch, [(0.0, 30.0)], fallback=fb)
    t = p.transcribe_job(api, {**JOB, "firefliesUploaded": True}, None)
    assert t.text == "from fireflies" and api.downloads == 0


@respx.mock
def test_quota_falls_back_and_pauses(monkeypatch):
    route = respx.post(API).mock(return_value=Response(401, json={"detail": {"status": "quota_exceeded"}}))
    fb = FakeFallback()
    p = provider(monkeypatch, [(0.0, 30.0)], fallback=fb)
    assert p.transcribe_job(FakeApi(), JOB, None).text == "from fireflies"
    # Next call goes straight to the fallback (no ElevenLabs request).
    assert p.transcribe_job(FakeApi(), {**JOB, "jobId": "j2"}, None).text == "from fireflies"
    assert route.call_count == 1 and fb.jobs == ["j1", "j2"]


@respx.mock
def test_quota_without_fallback_is_retryable(monkeypatch):
    respx.post(API).mock(return_value=Response(401, json={"detail": {"status": "quota_exceeded"}}))
    p = provider(monkeypatch, [(0.0, 30.0)])
    with pytest.raises(RuntimeError):
        p.transcribe_job(FakeApi(), JOB, None)


@respx.mock
def test_refused_key_or_unknown_401_never_fails_the_call(monkeypatch):
    respx.post(API).mock(return_value=Response(401, json={"detail": {"status": "something_new"}}))
    fb = FakeFallback()
    p = provider(monkeypatch, [(0.0, 30.0)], fallback=fb)
    assert p.transcribe_job(FakeApi(), JOB, None).text == "from fireflies"


def test_unreadable_audio_is_permanent(monkeypatch):
    def bad(_):
        raise ValueError("bad file")

    p = ElevenLabsProvider(settings(), decode=bad)
    with pytest.raises(PermanentError):
        p.transcribe_job(FakeApi(), JOB, None)


def test_speech_parts_on_silence():
    assert vad.speech_parts(np.zeros(SR * 3, dtype=np.float32)) == []
