"""Translate a transcript's segments to English with Claude, keeping one English line per segment.

Cost levers (measured on 18 real calls: output ~63% of cost, ~30% of output was thinking):
- lines already in English are not sent at all;
- Sonnet with thinking off by default; Opus only for hard calls (Urdu/Arabic-script speech-to-text output);
- compact input ("n|text") and output (bare list of strings), low effort;
- `translate_batch` uses the Message Batches API (50% off) for backlog calls.
"""

import json
import re
import time
from .batches import batch_results, open_batch, wait_batch

SONNET = "claude-sonnet-5-5"
OPUS = "claude-opus-5-5"

PROMPT = """You translate phone-call transcripts from an Indian accounting/CFO services firm into English.
The lines may be Hindi, English or Hinglish, written in Devanagari, Latin or Urdu script (the speech-to-text
sometimes writes Hindi in Urdu script). Translate each line into natural, accurate English. Keep names,
numbers, amounts, company and tax terms (GST, TDS, PAN, ITR, ITC, etc.) exactly. If a line is unclear,
translate it as best you can; never drop or merge lines. Return a JSON list "en" with exactly one English
string per input line, in order.

Lines ("index|text"):
"""

SCHEMA = {
    "type": "object",
    "properties": {"en": {"type": "array", "items": {"type": "string"}}},
    "required": ["en"],
    "additionalProperties": False,
}

_ARABIC = re.compile(r"[؀-ۿݐ-ݿ]")
_WORD = re.compile(r"[a-z']+")
# Common romanized Hindi words (English look-alikes like "to", "the", "main" left out): a Latin-script
# line containing any of these still needs translating.
_HINGLISH = set("""
hai hain haan nahi nahin nai kya kyu kyun kaise kaisa kaun kab kahan kidhar yaha yahan waha wahan toh bhi aur
lekin mein mujhe mera meri mere tera teri tum tumhe aap aapka aapki aapke hum humko hamara apna apni apne ka
ki ke ko se tak wala wali wale woh wo ye yeh iska uska unka theek thik achha acha accha haanji ji jee sahi
bilkul matlab abhi phir aaj parso jaldi kar karo karna karke kiya kiye karenge karunga karte karta karti hoga
hogi hoge hua hui hue thi raha rahi rahe gaya gayi gaye diya diye dena dedo lena liya bhej bhejo bhejna bhejdo
dekho bolo bata batao bataiye samjha samjho chahiye chalo sakte sakta sakti paisa paise baat bhai didi
""".split())


def needs_translation(text: str) -> bool:
    """False only for lines that look like plain English (Latin script, no common Hindi words)."""
    t = text.strip()
    if not t:
        return False
    if not t.isascii():
        return True
    return any(w in _HINGLISH for w in _WORD.findall(t.lower()))


def pick_model(texts: list[str]) -> str:
    """Opus only where speech-to-text produced Urdu/Arabic script (hard, garbled); Sonnet otherwise."""
    return OPUS if any(_ARABIC.search(t) for t in texts) else SONNET


class TranslationError(Exception):
    """`usage` (when set) is what Claude charged for the failed attempts, reported so the monthly cap counts it."""
    usage: dict | None = None


def plan(segments: list[dict], model: str | None = None) -> tuple[list[int], list[str], str]:
    """Which segment indexes to send, their cleaned text, and the model to use."""
    texts = [" ".join(s.get("text", "").split()) for s in segments]
    idx = [i for i, t in enumerate(texts) if needs_translation(t)]
    send = [texts[i] for i in idx]
    return idx, send, model or pick_model(send)


def request_params(model: str, texts: list[str]) -> dict:
    params = {
        "model": model,
        "max_tokens": 16000,
        "messages": [{"role": "user", "content": PROMPT + "\n".join(f"{i}|{t}" for i, t in enumerate(texts))}],
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
    }
    if model.startswith("claude-sonnet"):
        # Sonnet 5.5 can skip thinking entirely (effort high or below); Opus 5.5 cannot.
        params["thinking"] = {"type": "between_tools"}
    return params


def parse_reply(msg, expected: int) -> list[str]:
    if msg.stop_reason in ("refusal", "max_tokens"):
        raise TranslationError(f"stop_reason={msg.stop_reason}")
    try:
        text = next(b.text for b in msg.content if b.type == "text")
        en = json.loads(text)["en"]
        if not isinstance(en, list):
            raise TypeError("en is not a list")
    except (StopIteration, ValueError, KeyError, TypeError) as e:
        # A malformed reply must not escape as a non-TranslationError: in translate_batch that would
        # abort the whole batch (every already-billed result lost) instead of retrying this one call.
        raise TranslationError(f"bad translation reply: {e}") from e
    if len(en) != expected:
        raise TranslationError(f"expected {expected} lines, got {len(en)}")
    return en


def merge(segments: list[dict], idx: list[int], en: list[str]) -> list[dict]:
    """English for every segment: translated lines from Claude, English lines copied as they were."""
    out = [{**s, "en": " ".join(s.get("text", "").split())} for s in segments]
    for i, e in zip(idx, en):
        out[i]["en"] = e
    return out


def _usage(msg, model: str) -> dict:
    return {"model": model, "input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens}


def _add_usage(a: dict, b: dict | None) -> dict:
    if not b:
        return dict(a)
    return {**b, "model": b.get("model") or a["model"], "input_tokens": a["input_tokens"] + b["input_tokens"],
            "output_tokens": a["output_tokens"] + b["output_tokens"]}


def translate_segments(client, segments: list[dict], model: str | None = None) -> tuple[list[dict], dict]:
    """Live calls: one request now. Returns (segments with `en`, usage). `model` overrides the routing.
    If the reply has the wrong number of lines it retries once, then falls back to Opus."""
    idx, send, model = plan(segments, model)
    if not send:
        return merge(segments, [], []), {"model": None, "input_tokens": 0, "output_tokens": 0}
    tried, err = [], None
    for m in dict.fromkeys([model, model, OPUS]):  # model, (model again if not Opus), Opus
        for _ in range(2 if m == model and m != OPUS else 1):
            msg = client.messages.create(**request_params(m, send))
            tried.append(_usage(msg, m))
            try:
                en = parse_reply(msg, len(send))
            except TranslationError as e:
                err = e
                continue
            total = {"model": m, "input_tokens": sum(u["input_tokens"] for u in tried),
                     "output_tokens": sum(u["output_tokens"] for u in tried), "attempts": len(tried)}
            return merge(segments, idx, en), total
    err.usage = {"model": tried[-1]["model"], "input_tokens": sum(u["input_tokens"] for u in tried),
                 "output_tokens": sum(u["output_tokens"] for u in tried)}
    raise err


def translate_batch(client, calls: dict[str, list[dict]], model: str | None = None, poll_s: int = 30,
                    batch_id: str | None = None, on_submit=None, guard=None, allowed=None) -> dict:
    """Backlog: all calls in one Message Batch (50% off). Returns {call_id: (segments, usage) | TranslationError}.
    With [batch_id], waits for that earlier batch instead of sending a new one (resume after a worker restart)."""
    plans = {cid: plan(segs, model) for cid, segs in calls.items()}
    results: dict = {cid: (merge(calls[cid], [], []), {"model": None, "input_tokens": 0, "output_tokens": 0})
                     for cid, (_, send, _) in plans.items() if not send}
    todo = {cid: p for cid, p in plans.items() if p[1]}
    if not todo:
        return results
    bid = open_batch(client, lambda: [
        {"custom_id": cid, "params": request_params(m, send)} for cid, (_, send, m) in todo.items()
    ], batch_id, on_submit, guard, allowed)
    wait_batch(client, bid, poll_s)
    for r in batch_results(client, bid, poll_s):
        if r.custom_id not in todo:  # a resumed batch holds jobs this worker didn't claim
            continue
        idx, send, m = todo[r.custom_id]
        if r.result.type != "succeeded":
            results[r.custom_id] = TranslationError(f"batch result {r.result.type}")
            continue
        try:
            msg = r.result.message
            results[r.custom_id] = (merge(calls[r.custom_id], idx, parse_reply(msg, len(send))), _usage(msg, m))
        except TranslationError:
            # Rare (a dropped line): redo this one call live, with retry and Opus fallback. The failed batch
            # reply was billed too, so its tokens are added to whatever the live retry reports.
            failed = _usage(msg, m)
            try:
                segs, usage = translate_segments(client, calls[r.custom_id], model)
                results[r.custom_id] = (segs, _add_usage(failed, usage))
            except Exception as e:  # noqa: BLE001 - API/network errors fail only this call, not the batch
                e.usage = _add_usage(failed, getattr(e, "usage", None))
                results[r.custom_id] = e
    return results
