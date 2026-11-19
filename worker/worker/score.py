"""AI call scoring with Claude: script adherence, objections, sentiment, next step, strengths, improvements, overall.

Reads the same transcript lines as summarize.py (English where translated, speaker names when known). The call
list's script (if the call was made from one) comes with the claimed job. Structured output (JSON schema);
the model is SCORE_MODEL (default: the summary model). `score_batch` uses the Message Batches API for backlog calls.
"""

import json
import time

from .summarize import MAX_CHARS, SENTIMENTS, transcript_lines
from .translate import SONNET

MAX_OBJECTIONS, MAX_POINTS = 10, 5

PROMPT = """You coach sales and service staff of USA India CFO (an Indian accounting / CFO services firm). Below is one
phone call between a staff member and a customer or prospect, one line per utterance ("speaker: text" when speakers
are known). The staff member on this call is: {agent}.

{script}

Return:
- scriptAdherence: 0-100, how well the staff member followed the call script sections above (covered each section's
  intent, in a sensible order). 0 when no script is given (it is then ignored).
- objections: up to 10 customer objections or concerns (price, timing, trust, "already have a CA", ...), each with
  handled = true when the staff member addressed it convincingly. Empty list if there were none.
- sentiment: the customer's overall sentiment: positive, neutral, negative or mixed.
- nextStep: the next step both sides agreed on, in one short sentence; an empty string if none was agreed.
- strengths: up to 5 short things the staff member did well.
- improvements: up to 5 short, concrete things the staff member should do better next time.
- overall: 0-100 for the whole call (rapport, discovery, handling objections, a clear next step).
Keep names, amounts and tax terms exactly. Write in English.

Transcript:
"""

SCHEMA = {
    "type": "object",
    "properties": {
        # Plain types only (no nullable unions): no script -> ignored by parse_reply; no next step -> "".
        "scriptAdherence": {"type": "integer"},
        "objections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"objection": {"type": "string"}, "handled": {"type": "boolean"}},
                "required": ["objection", "handled"],
                "additionalProperties": False,
            },
        },
        "sentiment": {"type": "string", "enum": list(SENTIMENTS)},
        "nextStep": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "improvements": {"type": "array", "items": {"type": "string"}},
        "overall": {"type": "integer"},
    },
    "required": ["scriptAdherence", "objections", "sentiment", "nextStep", "strengths", "improvements", "overall"],
    "additionalProperties": False,
}


class ScoreError(Exception):
    """`usage` (when set) is what Claude charged for the failed attempts, reported so the monthly cap counts it."""
    usage: dict | None = None


def script_text(script: dict | None) -> str:
    """The call script for the prompt, or a note that there is none."""
    sections = (script or {}).get("sections") or []
    lines = [f"{str(s.get('heading', '')).strip().upper()}: {' '.join(str(s.get('text', '')).split())}"
             for s in sections if str(s.get("heading", "")).strip() or str(s.get("text", "")).strip()]
    if not lines:
        return "There is no call script for this call: return scriptAdherence as 0."
    name = str((script or {}).get("name") or "Call script").strip()
    return f"Call script \"{name}\":\n" + "\n".join(lines)


def request_params(model: str, lines: list[str], agent: str | None, script: dict | None) -> dict:
    body = "\n".join(lines)
    if len(body) > MAX_CHARS:
        body = body[:MAX_CHARS] + "\n[transcript cut here: too long]"
    content = PROMPT.format(agent=agent or "not known", script=script_text(script)) + body
    params = {
        "model": model,
        "max_tokens": 3000,
        "messages": [{"role": "user", "content": content}],
        "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
    }
    if model.startswith("claude-sonnet"):
        params["thinking"] = {"type": "between_tools"}
    return params


def _clamp(v, lo: int = 0, hi: int = 100) -> int:
    return max(lo, min(hi, int(round(float(v)))))


def _clean_list(v, limit: int, width: int) -> list[str]:
    out = [" ".join(str(x).split())[:width] for x in (v or []) if str(x).strip()]
    return out[:limit]


def parse_reply(msg, has_script: bool) -> dict:
    if msg.stop_reason in ("refusal", "max_tokens"):
        raise ScoreError(f"stop_reason={msg.stop_reason}")
    text = next(b.text for b in msg.content if b.type == "text")
    try:
        d = json.loads(text)
        overall = _clamp(d["overall"])
    except (ValueError, KeyError, TypeError) as e:
        raise ScoreError(f"bad score reply: {e}") from e
    adherence = d.get("scriptAdherence")
    try:
        adherence = _clamp(adherence) if has_script and adherence is not None else None
    except (ValueError, TypeError):
        adherence = None
    objections = []
    for o in (d.get("objections") or [])[:MAX_OBJECTIONS]:
        text_o = " ".join(str((o or {}).get("objection", "")).split())[:500]
        if text_o:
            objections.append({"objection": text_o, "handled": bool(o.get("handled"))})
    next_step = " ".join(str(d.get("nextStep") or "").split())[:2000] or None
    return {
        "overall": overall,
        "scriptAdherence": adherence,
        "sentiment": d.get("sentiment") if d.get("sentiment") in SENTIMENTS else "neutral",
        "objections": objections,
        "nextStep": next_step,
        "strengths": _clean_list(d.get("strengths"), MAX_POINTS, 500),
        "improvements": _clean_list(d.get("improvements"), MAX_POINTS, 500),
    }


def _usage(msg, model: str) -> dict:
    return {"model": model, "input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens}


def _add_usage(a: dict, b: dict | None) -> dict:
    if not b:
        return dict(a)
    return {"model": a["model"], "input_tokens": a["input_tokens"] + b["input_tokens"],
            "output_tokens": a["output_tokens"] + b["output_tokens"]}


def score_call(client, transcript: dict, agent: str | None = None, script: dict | None = None,
               model: str = SONNET) -> tuple[dict, dict]:
    """Live calls: one request now (one retry on a bad reply). Returns (score dict, usage)."""
    lines, _ = transcript_lines(transcript)
    if not lines:
        raise ScoreError("empty transcript")
    tried, err = [], None
    for _ in range(2):
        msg = client.messages.create(**request_params(model, lines, agent, script))
        tried.append(_usage(msg, model))
        try:
            out = parse_reply(msg, bool(script))
        except ScoreError as e:
            err = e
            continue
        return out, {"model": model, "input_tokens": sum(u["input_tokens"] for u in tried),
                     "output_tokens": sum(u["output_tokens"] for u in tried)}
    err.usage = {"model": model, "input_tokens": sum(u["input_tokens"] for u in tried),
                 "output_tokens": sum(u["output_tokens"] for u in tried)}
    raise err


def score_batch(client, calls: dict[str, tuple[dict, str | None, dict | None]], model: str = SONNET,
                poll_s: int = 30) -> dict:
    """Backlog: one Message Batch. `calls` is {id: (transcript, agent, script)}. Returns {id: (score, usage) | Exception}."""
    results: dict = {}
    todo = {}
    for cid, (transcript, agent, script) in calls.items():
        lines, _ = transcript_lines(transcript)
        if lines:
            todo[cid] = (lines, agent, script)
        else:
            results[cid] = ScoreError("empty transcript")
    if not todo:
        return results
    batch = client.messages.batches.create(requests=[
        {"custom_id": cid, "params": request_params(model, lines, agent, script)}
        for cid, (lines, agent, script) in todo.items()
    ])
    while (batch := client.messages.batches.retrieve(batch.id)).processing_status != "ended":
        time.sleep(poll_s)
    for r in client.messages.batches.results(batch.id):
        if r.custom_id not in todo:
            continue
        _, agent, script = todo[r.custom_id]
        if r.result.type != "succeeded":
            results[r.custom_id] = ScoreError(f"batch result {r.result.type}")
            continue
        msg = r.result.message
        try:
            results[r.custom_id] = (parse_reply(msg, bool(script)), _usage(msg, model))
        except ScoreError:
            # Rare: redo this one call live. The failed batch reply was billed too, so its tokens are added to
            # whatever the live retry reports (success or failure) and the monthly cap counts them.
            failed = _usage(msg, model)
            try:
                score, usage = score_call(client, calls[r.custom_id][0], agent, script, model)
                results[r.custom_id] = (score, _add_usage(failed, usage))
            except Exception as e:  # noqa: BLE001 - fails only this call
                e.usage = _add_usage(failed, getattr(e, "usage", None))
                results[r.custom_id] = e
    return results
