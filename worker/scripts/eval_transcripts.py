"""Scored transcription eval: Fireflies (and any cached provider) against hand-checked references.

uv run python scripts/eval_transcripts.py --refs REFS_DIR --out OUT_DIR [--judge]

REFS_DIR holds one <id>.json per call, checked by a person:
    {"id": "...", "audio": "file.m4a", "text": "<original-language transcript>", "en": "<English>",
     "fireflies": {"text": "...", "en": "..."}}          # optional: what production produced
The reference `text` must be in the SAME script the providers output (e.g. both Devanagari, or both
romanized). Otherwise WER is meaningless; CER is printed too, but compare like with like.

--judge        score each provider's English with Claude against `en` (PAID: needs ANTHROPIC_API_KEY).
Other providers' output is read from OUT_DIR (<id>.<provider>.json). Writes OUT_DIR/scores.json.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker.evalscore import cer, judge_translation, wer  # noqa: E402


def load_refs(refs: Path) -> list[dict]:
    out = []
    for p in sorted(refs.glob("*.json")):
        r = json.loads(p.read_text(encoding="utf-8"))
        r.setdefault("id", p.stem)
        out.append(r)
    return out


def hypotheses(ref: dict, out: Path) -> dict[str, dict]:
    """Provider name -> {"text", "en"?}: production Fireflies output from the ref file plus cached runs."""
    hyps: dict[str, dict] = {}
    if ref.get("fireflies"):
        hyps["fireflies"] = ref["fireflies"]
    for p in out.glob(f"{ref['id']}.*.json"):
        provider = p.name[len(ref["id"]) + 1 : -len(".json")]
        if provider != "judge":
            hyps[provider] = json.loads(p.read_text(encoding="utf-8"))
    return hyps


def score(refs: list[dict], out: Path, judge=None) -> dict:
    """Per-provider mean WER / CER (and judge mean when `judge(ref_en, cand_en)` is given)."""
    per: dict[str, dict[str, list]] = {}
    rows = []
    for ref in refs:
        for provider, h in hypotheses(ref, out).items():
            row = {"id": ref["id"], "provider": provider, "wer": round(wer(ref["text"], h.get("text", "")), 4),
                   "cer": round(cer(ref["text"], h.get("text", "")), 4)}
            if judge and ref.get("en") and h.get("en"):
                row["judge"] = judge(ref["en"], h["en"])
            rows.append(row)
            agg = per.setdefault(provider, {"wer": [], "cer": [], "judge": []})
            agg["wer"].append(row["wer"])
            agg["cer"].append(row["cer"])
            if "judge" in row:
                agg["judge"].append(row["judge"]["mean"])
    mean = lambda xs: round(sum(xs) / len(xs), 4) if xs else None  # noqa: E731
    summary = {p: {"calls": len(a["wer"]), "wer": mean(a["wer"]), "cer": mean(a["cer"]), "judge": mean(a["judge"])}
               for p, a in per.items()}
    return {"summary": summary, "rows": rows}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refs", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--judge", action="store_true")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    refs = load_refs(a.refs)
    judge = None
    if a.judge:
        import anthropic

        client = anthropic.Anthropic()
        judge = lambda ref_en, cand_en: judge_translation(client, ref_en, cand_en)  # noqa: E731
    result = score(refs, a.out, judge)
    (a.out / "scores.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    for provider, s in sorted(result["summary"].items()):
        print(f"{provider:12} calls={s['calls']:3} WER={s['wer']} CER={s['cer']} judge={s['judge']}")


if __name__ == "__main__":
    main()
