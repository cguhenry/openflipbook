"""Fake-transport C acceptance for OpenClaw fail-fast resilience."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from providers import breaker, usage
from providers.openclaw_runtime import (
    OpenClawCircuitOpenError,
    OpenClawGatewayClient,
    OpenClawGatewayError,
)


def _plan() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "title": "Steam Engine",
        "summary": "Pressure drives motion.",
        "scene": {
            "prompt": "Illustrated engine cutaway, no text",
            "style": "textbook",
            "aspect_ratio": "16:9",
        },
        "text_blocks": [
            {"id": "t001", "role": "title", "text": "Steam", "anchor": "top"},
            {"id": "t002", "role": "body", "text": "Motion", "anchor": "bottom"},
        ],
        "hotspots": [
            {
                "id": f"h00{index}",
                "label": label,
                "sub_query": label.lower(),
                "visual_target": label.lower(),
                "desired_bbox": [0.1 + index * 0.2, 0.2, 0.15, 0.2],
            }
            for index, label in enumerate(("Boiler", "Piston", "Wheel"), start=1)
        ],
        "motion_hints": [],
        "sources": [],
    }


def _envelope(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": json.dumps(value)}],
            }
        ],
    }


@pytest.fixture(autouse=True)
def _fresh_runtime(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    secret = tmp_path / "gateway-secret"
    secret.write_text("fake-secret\n", encoding="utf-8")
    secret.chmod(0o600)
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_BEARER_FILE", str(secret))
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_BASE_URL", "http://gateway.test")
    breaker.reset_for_tests()
    usage.reset_for_tests()
    yield
    breaker.reset_for_tests()
    usage.reset_for_tests()


@pytest.mark.asyncio
async def test_three_transient_failures_open_responses_and_fourth_fails_before_dispatch() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = OpenClawGatewayClient(http)
        for _ in range(3):
            with pytest.raises(OpenClawGatewayError):
                await client.page_plan("system", "query")
        assert breaker.snapshot("openclaw:responses")["state"] == "open"
        with pytest.raises(OpenClawCircuitOpenError) as raised:
            await client.page_plan("system", "query")

    assert calls == 3
    assert raised.value.code == "OPENCLAW_CIRCUIT_OPEN"
    assert raised.value.stage == "responses"
    assert raised.value.retry_after_seconds > 0
    assert usage.snapshot()["counters"]["planner_calls"] == 3


@pytest.mark.asyncio
async def test_429_is_transient_but_user_400_and_contract_validation_are_not() -> None:
    statuses = iter((429, 400))

    def status_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(next(statuses), request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(status_handler)) as http:
        client = OpenClawGatewayClient(http)
        with pytest.raises(OpenClawGatewayError):
            await client.page_plan("system", "query")
        assert breaker.snapshot("openclaw:responses")["consecutive_failures"] == 1
        with pytest.raises(OpenClawGatewayError):
            await client.page_plan("system", "query")
        assert breaker.snapshot("openclaw:responses")["consecutive_failures"] == 1

    def invalid_handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_envelope({"schema_version": "1.0"}))

    async with httpx.AsyncClient(transport=httpx.MockTransport(invalid_handler)) as http:
        with pytest.raises(OpenClawGatewayError):
            await OpenClawGatewayClient(http).page_plan("system", "query")

    assert breaker.snapshot("openclaw:responses")["consecutive_failures"] == 0


@pytest.mark.asyncio
async def test_success_resets_consecutive_transient_failures() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls < 3:
            return httpx.Response(503, request=request)
        return httpx.Response(200, json=_envelope(_plan()))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = OpenClawGatewayClient(http)
        for _ in range(2):
            with pytest.raises(OpenClawGatewayError):
                await client.page_plan("system", "query")
        await client.page_plan("system", "query")

    snapshot = breaker.snapshot("openclaw:responses")
    assert snapshot["state"] == "closed"
    assert snapshot["consecutive_failures"] == 0


@pytest.mark.asyncio
async def test_cancelled_image_fails_before_dispatch_and_does_not_trip_breaker() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise AssertionError("cancelled request dispatched")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(BaseException) as raised:
            await OpenClawGatewayClient(http).image_generate(
                "draw",
                is_cancelled=lambda: True,
            )

    assert type(raised.value).__name__ == "CancelledError"
    assert calls == 0
    assert breaker.snapshot("openclaw:image")["consecutive_failures"] == 0
    assert usage.snapshot()["counters"]["image_calls"] == 0


@pytest.mark.asyncio
async def test_unreadable_local_bearer_is_not_counted_as_provider_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_BEARER_FILE", "/missing/local-secret")
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=_envelope(_plan()))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(OpenClawGatewayError):
            await OpenClawGatewayClient(http).page_plan("system", "query")

    assert calls == 0
    assert usage.snapshot()["counters"]["planner_calls"] == 0
    assert breaker.snapshot("openclaw:responses")["consecutive_failures"] == 0


@pytest.mark.asyncio
async def test_planner_alignment_and_image_counts_match_real_dispatches() -> None:
    aligned = {
        "hotspots": [
            {
                "id": row["id"],
                "bbox": row["desired_bbox"],
                "confidence": 0.95,
            }
            for row in _plan()["hotspots"]
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/responses":
            body = json.loads(request.content)
            system = body["input"][0]["content"][0]["text"]
            payload = aligned if "align planned" in system else _plan()
            return httpx.Response(200, json=_envelope(payload))
        if request.url.path == "/tools/invoke":
            return httpx.Response(
                200,
                json={"ok": True, "result": {"details": {"paths": ["/tmp/fake.png"]}}},
            )
        if request.url.params.get("meta"):
            return httpx.Response(200, json={"available": True, "mediaTicket": "ticket"})
        return httpx.Response(200, content=b"image", headers={"content-type": "image/png"})

    image_data_url = "data:image/png;base64," + base64.b64encode(b"image").decode()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = OpenClawGatewayClient(http)
        await client.page_plan("system", "query")
        await client.align_hotspots(_plan(), image_data_url)
        await client.image_generate("draw")

    counters = usage.snapshot()["counters"]
    assert counters["planner_calls"] == 1
    assert counters["alignment_calls"] == 1
    assert counters["image_calls"] == 1


@pytest.mark.asyncio
async def test_image_tool_failure_is_transient_and_never_retried() -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"ok": False, "error": "upstream unavailable"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(OpenClawGatewayError):
            await OpenClawGatewayClient(http).image_generate("draw")

    assert calls == 1
    assert breaker.snapshot("openclaw:image")["consecutive_failures"] == 1
