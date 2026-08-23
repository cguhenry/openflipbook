"""Operational usage/cap accounting for the NAS OpenClaw path."""

from __future__ import annotations

import pytest

from providers import usage


@pytest.fixture(autouse=True)
def _fresh_usage(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("FLIPBOOK_MAX_RUNTIME_GENERATIONS", raising=False)
    monkeypatch.delenv("FLIPBOOK_MAX_SESSION_GENERATIONS", raising=False)
    usage.reset_for_tests()
    yield
    usage.reset_for_tests()


def test_zero_caps_are_unlimited_and_scope_is_explicit() -> None:
    first = usage.begin_generation("session-a")
    second = usage.begin_generation("session-a")
    usage.finish_generation(first, "success")
    usage.finish_generation(second, "cancelled")

    snapshot = usage.snapshot()
    assert snapshot["scope"] == "since backend start"
    assert snapshot["caps"] == {"runtime_generations": 0, "session_generations": 0}
    assert snapshot["counters"]["generation_requests"] == 2
    assert snapshot["counters"]["generation_success"] == 1
    assert snapshot["counters"]["generation_cancelled"] == 1
    assert snapshot["accepted_generations"] == 2


def test_runtime_cap_rejects_n_plus_one_before_provider_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FLIPBOOK_MAX_RUNTIME_GENERATIONS", "1")
    usage.begin_generation("session-a")

    with pytest.raises(usage.UsageCapError) as raised:
        usage.begin_generation("session-b")

    assert raised.value.code == "OPENFLIPBOOK_USAGE_CAP_REACHED"
    assert raised.value.scope == "runtime"
    snapshot = usage.snapshot()
    assert snapshot["accepted_generations"] == 1
    assert snapshot["counters"]["generation_requests"] == 2
    assert snapshot["counters"]["generation_failed"] == 1
    assert snapshot["counters"]["planner_calls"] == 0
    assert snapshot["counters"]["alignment_calls"] == 0
    assert snapshot["counters"]["image_calls"] == 0


def test_session_cap_is_isolated_by_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLIPBOOK_MAX_SESSION_GENERATIONS", "1")
    usage.begin_generation("session-a")
    usage.begin_generation("session-b")

    with pytest.raises(usage.UsageCapError) as raised:
        usage.begin_generation("session-a")

    assert raised.value.scope == "session"
    snapshot = usage.snapshot()
    assert snapshot["accepted_generations"] == 2
    assert snapshot["tracked_sessions"] == 2


def test_provider_counters_only_change_at_explicit_dispatch_points() -> None:
    usage.record_provider_call("planner")
    usage.record_provider_call("alignment")
    usage.record_provider_call("image")
    usage.record_searxng_search()

    counters = usage.snapshot()["counters"]
    assert counters["planner_calls"] == 1
    assert counters["alignment_calls"] == 1
    assert counters["image_calls"] == 1
    assert counters["searxng_searches"] == 1


def test_generation_outcome_is_recorded_once() -> None:
    ticket = usage.begin_generation("session-a")
    usage.finish_generation(ticket, "failed")
    usage.finish_generation(ticket, "success")

    counters = usage.snapshot()["counters"]
    assert counters["generation_failed"] == 1
    assert counters["generation_success"] == 0
