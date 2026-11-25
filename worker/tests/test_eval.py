import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from worker.evalscore import cer, judge_translation, normalize, wer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import eval_transcripts  # noqa: E402


def test_wer_and_cer():
    assert normalize("Haan, GST file ho  gaya!") == "haan gst file ho gaya"
    assert wer("haan gst file ho gaya", "Haan, GST file ho gaya.") == 0
    assert wer("a b c d", "a x c") == 0.5  # one substitution + one deletion
    assert wer("", "") == 0 and wer("", "x") == 1
    assert cer("abcd", "abxd") == 0.25
    assert wer("नमस्ते जी", "नमस्ते जी") == 0


def test_judge_parses_structured_reply():
    reply = SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(
        type="text", text=json.dumps({"accuracy": 5, "terms": 4, "fluency": 3, "notes": "ok"}))])
    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: reply))
    assert judge_translation(client, "ref", "cand")["mean"] == 4.0
    refused = SimpleNamespace(stop_reason="refusal", content=[])
    with pytest.raises(ValueError):
        judge_translation(SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: refused)), "r", "c")


def test_eval_scores_cached_providers(tmp_path):
    refs, out = tmp_path / "refs", tmp_path / "out"
    refs.mkdir()
    out.mkdir()
    (refs / "c1.json").write_text(json.dumps({"audio": "c1.m4a", "text": "haan gst file ho gaya", "en": "Yes, GST is filed",
                                              "fireflies": {"text": "haan gst file gaya", "en": "Yes GST filed"}}))
    (out / "c1.whisper.json").write_text(json.dumps({"text": "haan gst file ho gaya"}))
    judge = lambda r, c: {"mean": 5.0 if c == "Yes GST filed" else 1.0}  # noqa: E731
    result = eval_transcripts.score(eval_transcripts.load_refs(refs), out, judge)
    assert result["summary"]["whisper"]["wer"] == 0
    assert result["summary"]["whisper"]["judge"] is None  # no English in the cached run
    assert result["summary"]["fireflies"]["wer"] == 0.2
    assert result["summary"]["fireflies"]["judge"] == 5.0
