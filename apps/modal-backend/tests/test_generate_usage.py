"""Generation lifecycle integration for operational caps and outcomes."""

from __future__ import annotations

import json
import sys
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.modules.setdefault("modal", MagicMock())

import providers.image as image_mod  # noqa: E402
import providers.llm as llm_mod  # noqa: E402
from generate import GenerateBody, _event_stream, _friendly_error  # noqa: E402
from providers import openclaw_runtime, spend, usage  # noqa: E402
from providers.image import GeneratedImage  # noqa: E402
from providers.llm import PagePlan  # noqa: E402
from providers.openclaw_runtime import OpenClawCircuitOpenError  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_counters(monkeypatch: pytest.MonkeyPatch):
    usage.reset_for_tests()
    spend.reset_for_tests()
    monkeypatch.delenv("FLIPBOOK_MAX_RUNTIME_GENERATIONS", raising=False)
    monkeypatch.delenv("FLIPBOOK_MAX_SESSION_GENERATIONS", raising=False)
    monkeypatch.delenv("MAX_DAILY_SPEND", raising=False)
    monkeypatch.setenv("PROGRESSIVE_DRAFT", "false")
    yield
    usage.reset_for_tests()
    spend.reset_for_tests()


async def _collect(agen: Any) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async for chunk in agen:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for block in text.strip().split("\n\n"):
            block = block.strip()
            if block.startswith("data:"):
                events.append(json.loads(block[len("data:") :].strip()))
    return events


def _fake_provider_path(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    monkeypatch.setattr(
        llm_mod,
        "plan_page",
        AsyncMock(return_value=PagePlan("Boilers", "a cutaway", ["Drum"], [])),
    )
    generated = AsyncMock(
        return_value=GeneratedImage(b"jpeg", "image/jpeg", "fake/image", "r1")
    )
    monkeypatch.setattr(image_mod, "generate_image", generated)
    return generated


def _body(session_id: str = "session-a") -> GenerateBody:
    return GenerateBody(query="how boilers work", session_id=session_id, web_search=False)


async def test_zero_cap_allows_fake_flow_and_records_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generated = _fake_provider_path(monkeypatch)

    events = await _collect(_event_stream(_body(), "trace-1"))

    assert any(event["type"] == "final" for event in events)
    generated.assert_awaited_once()
    counters = usage.snapshot()["counters"]
    assert counters["generation_requests"] == 1
    assert counters["generation_success"] == 1


async def test_runtime_cap_rejects_before_fake_provider_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generated = _fake_provider_path(monkeypatch)
    monkeypatch.setenv("FLIPBOOK_MAX_RUNTIME_GENERATIONS", "1")
    await _collect(_event_stream(_body(), "trace-1"))

    events = await _collect(_event_stream(_body("session-b"), "trace-2"))

    assert generated.await_count == 1
    assert events == [
        {
            "type": "error",
            "code": "OPENFLIPBOOK_USAGE_CAP_REACHED",
            "scope": "runtime",
            "message": "Runtime generation cap reached. History, Resume and Offline export remain available.",
            "trace_id": "trace-2",
        }
    ]


async def test_session_cap_rejects_only_matching_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generated = _fake_provider_path(monkeypatch)
    monkeypatch.setenv("FLIPBOOK_MAX_SESSION_GENERATIONS", "1")
    await _collect(_event_stream(_body("session-a"), "trace-1"))
    await _collect(_event_stream(_body("session-b"), "trace-2"))

    events = await _collect(_event_stream(_body("session-a"), "trace-3"))

    assert generated.await_count == 2
    assert events[0]["code"] == "OPENFLIPBOOK_USAGE_CAP_REACHED"
    assert events[0]["scope"] == "session"


async def test_openclaw_path_ignores_legacy_guessed_dollar_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generated = _fake_provider_path(monkeypatch)
    monkeypatch.setattr(openclaw_runtime, "enabled", lambda: True)
    monkeypatch.setenv("MAX_DAILY_SPEND", "0.01")
    spend.record("legacy-estimate", 10.0)

    events = await _collect(_event_stream(_body(), "trace-1"))

    assert any(event["type"] == "final" for event in events)
    generated.assert_awaited_once()


async def test_cancelled_request_records_cancelled_not_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_provider_path(monkeypatch)

    async def disconnected() -> bool:
        return True

    events = await _collect(
        _event_stream(_body(), "trace-1", is_disconnected=disconnected)
    )

    assert events == []
    counters = usage.snapshot()["counters"]
    assert counters["generation_cancelled"] == 1
    assert counters["generation_failed"] == 0


async def test_error_terminal_frame_records_failed_not_success() -> None:
    body = GenerateBody(
        query="fix this image",
        session_id="session-a",
        mode="edit",
        edit_instruction="remove the label",
    )

    events = await _collect(_event_stream(body, "trace-1"))

    assert events[0]["type"] == "error"
    counters = usage.snapshot()["counters"]
    assert counters["generation_failed"] == 1
    assert counters["generation_success"] == 0


def test_circuit_open_error_explains_cooldown_and_persisted_fallbacks() -> None:
    message, detail = _friendly_error(OpenClawCircuitOpenError("image", 42))

    assert "42" in message
    assert "History" in message
    assert "Offline" in message
    assert "OPENCLAW_CIRCUIT_OPEN" in detail
