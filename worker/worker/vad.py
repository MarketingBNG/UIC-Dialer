"""Speech check before paid transcription: how much talking a recording has, and a copy without the silences.

Silero VAD (MIT, model file in assets/; detection loop adapted from faster-whisper, MIT) on 16 kHz mono PCM
decoded by ffmpeg. Calls with almost no speech (rings, a dropped "hello?") are tagged instead of transcribed;
the rest are sent with long silences cut out (holds, ringing), which the provider bills for, and the
timestamps it returns are mapped back to the original recording.
"""

import io
import subprocess
import threading
import wave
from bisect import bisect_right
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SR = 16000
WINDOW = 512
CONTEXT = 64
MODEL_PATH = Path(__file__).parent / "assets" / "silero_vad_v6.onnx"
# Silence kept between two kept speech parts in the trimmed copy (so words never run together).
GAP_S = 0.4
# Speech padding on each side of a detected part (VAD edges clip soft word starts/ends).
PAD_S = 0.3

_session = None
_lock = threading.Lock()


def decode(path: Path, run=subprocess.run) -> np.ndarray:
    """Any audio file -> float32 mono 16 kHz samples."""
    out = run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(path), "-vn",
               "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, timeout=1800, check=True)
    return np.frombuffer(out.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def _model():
    global _session
    with _lock:
        if _session is None:
            import onnxruntime

            opts = onnxruntime.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = 1
            opts.log_severity_level = 4
            _session = onnxruntime.InferenceSession(str(MODEL_PATH), providers=["CPUExecutionProvider"],
                                                    sess_options=opts)
        return _session


def speech_probs(audio: np.ndarray) -> np.ndarray:
    """Speech probability per 32 ms window."""
    if len(audio) == 0:
        return np.zeros(0, dtype=np.float32)
    audio = np.pad(audio, (0, (-len(audio)) % WINDOW))
    batch = audio.reshape(-1, WINDOW)
    context = np.roll(batch[:, -CONTEXT:].copy(), 1, 0)
    context[0] = 0
    batch = np.concatenate([context, batch], 1).astype(np.float32)
    h = np.zeros((1, 1, 128), dtype=np.float32)
    c = np.zeros((1, 1, 128), dtype=np.float32)
    outs = []
    for i in range(0, len(batch), 10000):
        o, h, c = _model().run(None, {"input": batch[i:i + 10000], "h": h, "c": c})
        outs.append(o)
    return np.concatenate(outs).reshape(-1)


def speech_parts(audio: np.ndarray, threshold: float = 0.5, min_silence_s: float = 0.5,
                 probs: np.ndarray | None = None) -> list[tuple[float, float]]:
    """(start, end) seconds of speech, unpadded."""
    p = speech_probs(audio) if probs is None else probs
    neg = max(threshold - 0.15, 0.01)
    min_sil = SR * min_silence_s
    parts: list[tuple[int, int]] = []
    start = None
    temp_end = 0
    for i, prob in enumerate(p):
        pos = WINDOW * i
        if prob >= threshold:
            temp_end = 0
            if start is None:
                start = pos
            continue
        if start is not None and prob < neg:
            if not temp_end:
                temp_end = pos
            if pos - temp_end >= min_sil:
                parts.append((start, temp_end))
                start, temp_end = None, 0
    if start is not None:
        parts.append((start, len(audio)))
    return [(s / SR, min(e, len(audio)) / SR) for s, e in parts]


@dataclass
class Trimmed:
    wav: bytes
    # (start in trimmed copy, start in original) for each kept piece, sorted
    pieces: list[tuple[float, float]]
    original_s: float
    trimmed_s: float

    def to_original(self, t: float) -> float:
        """Maps a time in the trimmed copy back to the original recording."""
        if not self.pieces:
            return t
        i = max(0, bisect_right([p[0] for p in self.pieces], t) - 1)
        trim_start, orig_start = self.pieces[i]
        return round(min(self.original_s, orig_start + (t - trim_start)), 3)


def trim(audio: np.ndarray, parts: list[tuple[float, float]]) -> Trimmed:
    """Copy of the audio with only the (padded) speech parts, GAP_S of silence between them, as 16 kHz WAV."""
    dur = len(audio) / SR
    merged: list[list[float]] = []
    for s, e in parts:
        s, e = max(0.0, s - PAD_S), min(dur, e + PAD_S)
        if merged and s <= merged[-1][1] + GAP_S:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    gap = np.zeros(int(GAP_S * SR), dtype=np.float32)
    chunks, pieces, pos = [], [], 0.0
    for k, (s, e) in enumerate(merged):
        if k:
            chunks.append(gap)
            pos += GAP_S
        seg = audio[int(s * SR):int(e * SR)]
        pieces.append((round(pos, 3), round(s, 3)))
        chunks.append(seg)
        pos += len(seg) / SR
    data = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(data, -1, 1) * 32767).astype(np.int16).tobytes())
    return Trimmed(wav=buf.getvalue(), pieces=pieces, original_s=dur, trimmed_s=len(data) / SR)
