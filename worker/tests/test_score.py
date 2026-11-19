import json
from types import SimpleNamespace

import httpx
import pytest
import respx

from worker.config import Settings
from worker.main import Api
from worker.score import SCHEMA, ScoreError, parse_reply, request_params, score_batch, score_call, script_text
from worker.scorer import Scorer, score_payload

ENV = {"WORKER_TOKEN": "w" * 40, "API_URL": "http://api.test", "WORKER_ID": "t1", "ANTHROPIC_API_KEY": "k",
       "TRANSLATE_BATCH_MAX": "2", "SCORE_ENABLED": "true"}

GOOD = {"scriptAdherence": 70, "objections": [{"objection": "Too costly", "handled": True}, {"objection": " ", "handled": False}],
        "sentiment": "positive", "nextStep": "Send the quote on Friday", "strengths": ["Warm intro", " "],
        "improvements": ["Ask about volume"], "overall": 78}

TRANSCRIPT = {"text": "namaste\nhaan", "textEn": "hello\nyes", "segments": [
    {"text": "namaste", "en": "hello", "speaker": "Ravi"},
    {"text": "haan", "en": "yes", "speaker": "Speaker 2"},
]}
SCRIPT = {"name": "GST pitch", "sections": [{"heading": "Open", "text": "Introduce yourself"},
                                            {"heading": "Ask", "text": "When is the GST return due?"}]}


def reply(d, stop="end_turn"):
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(d) if isinstance(d, dict) else d)],
                           stop_reason=stop, usage=SimpleNamespace(input_tokens=100, output_tokens=20))


class FakeMessages:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def create(self, **kw):
        self.calls.append(kw)
        return self.replies.pop(0)


def client(*replies, batches=None):
    c = SimpleNamespace(messages=FakeMessages(replies))
    c.messages.batches = batches
    return c


def test_request_params_include_script_and_agent():
    p = request_params("claude-sonnet-5-5", ["Ravi: hello"], "Ravi", SCRIPT)
    content = p["messages"][0]["content"]
    assert p["output_config"]["format"]["schema"] is SCHEMA
    assert "staff member on this call is: Ravi" in content
    assert "OPEN: Introduce yourself" in content and "GST pitch" in content
    assert "no call script" in request_params("claude-opus-5-5", ["x"], None, None)["messages"][0]["content"]
    assert script_text({"sections": []}).startswith("There is no call script")


def test_parse_reply_clamps_and_cleans():
    out = parse_reply(reply({**GOOD, "overall": 140}), True)
    assert out["overall"] == 100 and out["scriptAdherence"] == 70
    assert out["objections"] == [{"objection": "Too costly", "handled": True}]
    assert out["strengths"] == ["Warm intro"]
    # No script: adherence is always null.
    assert parse_reply(reply(GOOD), False)["scriptAdherence"] is None
    assert parse_reply(reply({**GOOD, "sentiment": "angry", "nextStep": " "}), False)["sentiment"] == "neutral"
    assert parse_reply(reply({**GOOD, "nextStep": None}), False)["nextStep"] is None
    with pytest.raises(ScoreError):
        parse_reply(reply(GOOD, stop="refusal"), True)
    with pytest.raises(ScoreError):
        parse_reply(reply({"overall": "lots"}), True)


def test_score_call_retries_once_and_reports_usage_on_failure():
    out, usage = score_call(client(reply("oops"), reply(GOOD)), TRANSCRIPT, "Ravi", SCRIPT)
    assert out["overall"] == 78
    assert usage == {"model": "claude-sonnet-5-5", "input_tokens": 200, "output_tokens": 40}
    with pytest.raises(ScoreError) as e:
        score_call(client(reply("bad"), reply("bad")), TRANSCRIPT)
    assert e.value.usage["input_tokens"] == 200
    with pytest.raises(ScoreError):
        score_call(client(), {"text": ""})


class FakeBatches:
    def __init__(self, fail=()):
        self.fail, self.created = set(fail), []

    def create(self, requests):
        self.created.append(requests)
        return SimpleNamespace(id="b1")

    def retrieve(self, _id):
        return SimpleNamespace(id="b1", processing_status="ended")

    def results(self, _id):
        for req in self.created[-1]:
            cid = req["custom_id"]
            kind = "errored" if cid in self.fail else "succeeded"
            yield SimpleNamespace(custom_id=cid, result=SimpleNamespace(type=kind, message=reply(GOOD)))


def test_score_batch():
    b = FakeBatches(fail={"j2"})
    res = score_batch(client(batches=b), {"j1": (TRANSCRIPT, "Ravi", SCRIPT), "j2": (TRANSCRIPT, None, None),
                                          "j3": ({"text": ""}, None, None)}, poll_s=0)
    assert len(b.created[0]) == 2
    assert res["j1"][0]["scriptAdherence"] == 70
    assert isinstance(res["j2"], ScoreError) and isinstance(res["j3"], ScoreError)


def test_score_payload_masks_pii_and_carries_script_id():
    out = parse_reply(reply({**GOOD, "nextStep": "Verify Aadhaar 2341 2341 2346"}), True)
    p = score_payload(out, {"model": "m", "input_tokens": 1, "output_tokens": 2}, "d", True, "s-1", mask=True)
    assert "2341 2341 2346" not in p["nextStep"]
    assert p["scriptId"] == "s-1" and p["model"] == "m"
    assert p["usage"] == {"inputTokens": 1, "outputTokens": 2, "batch": True}


class FakeApi:
    def __init__(self, jobs):
        self.jobs, self.claims, self.scores, self.results = list(jobs), [], {}, {}

    def claim(self, limit, kinds=("transcribe",)):
        self.claims.append(tuple(kinds))
        taken, self.jobs = self.jobs[:limit], self.jobs[limit:]
        return taken

    def get_transcript(self, call_id):
        return TRANSCRIPT

    def post_score(self, job_id, payload):
        self.scores[job_id] = payload

    def post_result(self, job_id, payload):
        self.results[job_id] = payload

    def heartbeat(self, job_id):
        return True


def test_scorer_claims_score_jobs_and_posts_live_results():
    settings = Settings.from_env(ENV)
    api = FakeApi([{"jobId": "j1", "callId": "c1", "priority": 10, "agentName": "Ravi", "script": SCRIPT,
                    "scriptId": "s-1"}])
    s = Scorer(api, client(reply(GOOD)), settings)
    assert s.tick() == 1
    assert api.claims[0] == ("score",)
    assert api.scores["j1"]["overall"] == 78 and api.scores["j1"]["scriptId"] == "s-1"
    assert "Introduce yourself" in s.client.messages.calls[0]["messages"][0]["content"]


def test_scorer_failure_reports_usage():
    api = FakeApi([{"jobId": "j1", "callId": "c1", "priority": 10}])
    Scorer(api, client(reply("x"), reply("x")), Settings.from_env(ENV)).tick()
    r = api.results["j1"]
    assert r["ok"] is False and r["model"] == "claude-sonnet-5-5"
    assert r["usage"]["inputTokens"] == 200


def test_settings_score_defaults():
    s = Settings.from_env({"WORKER_TOKEN": "w" * 40})
    assert not s.score_enabled and s.score_model == "claude-sonnet-5-5"
    s = Settings.from_env({"WORKER_TOKEN": "w" * 40, "SCORE_ENABLED": "true", "SUMMARY_MODEL": "claude-opus-5-5"})
    assert s.score_enabled and s.score_model == "claude-opus-5-5"
    assert Settings.from_env({"WORKER_TOKEN": "w" * 40, "SCORE_MODEL": "x"}).score_model == "x"


@respx.mock
def test_api_post_score_ignores_lost_lock():
    api = Api(Settings.from_env(ENV))
    route = respx.post("http://api.test/internal/jobs/j1/score").mock(return_value=httpx.Response(409))
    api.post_score("j1", {"overall": 1})
    assert json.loads(route.calls[0].request.content)["workerId"] == "t1"


class BadReplyBatches(FakeBatches):
    """Every batch result 'succeeds' with an unparseable reply."""

    def results(self, _id):
        for req in self.created[-1]:
            yield SimpleNamespace(custom_id=req["custom_id"], result=SimpleNamespace(type="succeeded", message=reply("oops")))


def test_score_batch_live_fallback_counts_the_failed_batch_reply():
    # Batch reply bad (100/20), live retry good on first try (100/20): 200/40 reported.
    res = score_batch(client(reply(GOOD), batches=BadReplyBatches()), {"j1": (TRANSCRIPT, None, None)}, poll_s=0)
    _, usage = res["j1"]
    assert usage["input_tokens"] == 200 and usage["output_tokens"] == 40
    # Batch reply bad and both live attempts bad: all three replies are on the error's usage.
    res = score_batch(client(reply("bad"), reply("bad"), batches=BadReplyBatches()), {"j1": (TRANSCRIPT, None, None)},
                      poll_s=0)
    assert isinstance(res["j1"], ScoreError)
    assert res["j1"].usage["input_tokens"] == 300 and res["j1"].usage["output_tokens"] == 60
