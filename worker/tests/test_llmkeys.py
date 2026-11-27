"""Anthropic key failover (worker/llmkeys.py)."""
from types import SimpleNamespace

import pytest

from worker.llmkeys import PROBE_AFTER_S, FailoverClient, is_credit_error


class ApiErr(Exception):
    def __init__(self, status: int, msg: str) -> None:
        super().__init__(msg)
        self.status_code = status


CREDIT = ApiErr(400, "Your credit balance is too low to access the Anthropic API.")


class Fake:
    def __init__(self, name: str, fail: Exception | None = None, batches: set[str] | None = None) -> None:
        self.name, self.fail, self.calls = name, fail, 0
        self.owned = batches if batches is not None else set()
        outer = self

        class B:
            def create(self, **kw):
                outer.calls += 1
                if outer.fail:
                    raise outer.fail
                outer.owned.add(f"b-{outer.name}")
                return SimpleNamespace(id=f"b-{outer.name}")

            def retrieve(self, bid):
                if bid not in outer.owned:
                    raise ApiErr(404, "not found")
                return SimpleNamespace(processing_status="ended", key=outer.name)

            def results(self, bid):
                if bid not in outer.owned:
                    raise ApiErr(404, "not found")
                return iter([outer.name])

        class M:
            batches = B()

            def create(self, **kw):
                outer.calls += 1
                if outer.fail:
                    raise outer.fail
                return outer.name

        self.messages = M()


def test_credit_error_detection():
    assert is_credit_error(CREDIT)
    assert is_credit_error(ApiErr(402, "payment required"))
    assert not is_credit_error(ApiErr(429, "rate limit"))
    assert not is_credit_error(ApiErr(500, "overloaded"))
    assert not is_credit_error(ApiErr(400, "messages: field required"))


def test_switches_to_second_key_on_credit_error_and_skips_the_first_for_a_day():
    now = [1000.0]
    a, b = Fake("a", fail=CREDIT), Fake("b")
    fc = FailoverClient([("anthropic-1", a), ("anthropic-2", b)], clock=lambda: now[0])
    assert fc.messages.create(model="m") == "b"
    assert fc.messages.create(model="m") == "b"
    assert a.calls == 1  # skipped while marked out
    now[0] += PROBE_AFTER_S
    a.fail = None
    assert fc.messages.create(model="m") == "a"  # re-probed after 24 h, works again


def test_rate_limits_do_not_switch_keys():
    a, b = Fake("a", fail=ApiErr(429, "rate limit")), Fake("b")
    fc = FailoverClient([("anthropic-1", a), ("anthropic-2", b)])
    with pytest.raises(ApiErr):
        fc.messages.create(model="m")
    assert b.calls == 0


def test_all_keys_out_raises_the_credit_error():
    fc = FailoverClient([("anthropic-1", Fake("a", fail=CREDIT)), ("anthropic-2", Fake("b", fail=CREDIT))])
    with pytest.raises(ApiErr):
        fc.messages.create(model="m")


def test_batches_are_read_with_the_key_that_created_them():
    a, b = Fake("a", fail=CREDIT), Fake("b")
    fc = FailoverClient([("anthropic-1", a), ("anthropic-2", b)])
    batch = fc.messages.batches.create(requests=[])
    assert batch.id == "b-b"
    assert fc.messages.batches.retrieve("b-b").key == "b"
    assert list(fc.messages.batches.results("b-b")) == ["b"]


def test_resumed_batch_is_found_on_whichever_key_has_it():
    a, b = Fake("a", batches=set()), Fake("b", batches={"old"})
    fc = FailoverClient([("anthropic-1", a), ("anthropic-2", b)])
    assert fc.messages.batches.retrieve("old").key == "b"
