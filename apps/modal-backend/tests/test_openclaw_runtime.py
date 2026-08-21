"""Fake-HTTP proof for the R1 OpenClaw Gateway adapter."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from providers.openclaw_runtime import (
    OpenClawGatewayClient,
    OpenClawGatewayError,
    enabled,
)


def _plan() -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "title": "Steam Engine",
        "summary": "A compact view of how steam pressure drives motion.",
        "scene": {
            "prompt": "Cutaway illustrated steam engine, no text, warm brass and blue steel.",
            "style": "clean illustrated textbook",
            "aspect_ratio": "16:9",
        },
        "text_blocks": [
            {"id": "t001", "role": "title", "text": "Steam Engine", "anchor": "top"},
            {
                "id": "t002",
                "role": "subtitle",
                "text": "Pressure becomes motion",
                "anchor": "bottom",
            },
        ],
        "hotspots": [
            {
                "id": "h001",
                "label": "Boiler",
                "sub_query": "steam boiler",
                "visual_target": "large cylindrical boiler",
                "desired_bbox": [0.08, 0.2, 0.2, 0.3],
            },
            {
                "id": "h002",
                "label": "Piston",
                "sub_query": "steam piston",
                "visual_target": "central piston and rod",
                "desired_bbox": [0.4, 0.2, 0.2, 0.3],
            },
            {
                "id": "h003",
                "label": "Flywheel",
                "sub_query": "steam engine flywheel",
                "visual_target": "large right flywheel",
                "desired_bbox": [0.72, 0.2, 0.2, 0.3],
            },
        ],
        "motion_hints": [],
        "sources": [],
    }


def _json_response(value: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, json=value)


def _prepare(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    secret = tmp_path / "gateway-secret"
    secret.write_text("test-secret\n", encoding="utf-8")
    secret.chmod(0o600)
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_BEARER_FILE", str(secret))
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_BASE_URL", "http://gateway.test")
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_MAX_CONCURRENT", "1")
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_IMAGE_TIMEOUT_S", "2")


def test_mock_selector_always_wins_over_openclaw(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLIPBOOK_LIVE_PROVIDER", "openclaw")
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    assert enabled() is False


@pytest.mark.asyncio
async def test_responses_page_plan_uses_gateway_route_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _prepare(monkeypatch, tmp_path)
    calls: list[tuple[str, dict[str, Any]]] = []
    auth_headers: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append((request.url.path, body))
        auth_headers.append(request.headers["authorization"])
        return _json_response(
            {
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": json.dumps(_plan())}],
                    }
                ],
            }
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await OpenClawGatewayClient(http).page_plan("system", "query")

    assert len(calls) == 1
    path, body = calls[0]
    assert path == "/v1/responses"
    assert body["model"] == "openclaw/flipbook"
    assert body["tool_choice"] == "none"
    assert auth_headers == ["Bearer test-secret"]
    assert result["schema_version"] == "1.0"
    assert [row["id"] for row in result["hotspots"]] == ["h001", "h002", "h003"]


@pytest.mark.asyncio
async def test_responses_alignment_sends_base64_image_and_exact_ids(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _prepare(monkeypatch, tmp_path)
    captured: list[dict[str, Any]] = []
    aligned = {
        "hotspots": [
            {"id": "h001", "bbox": [0.1, 0.2, 0.18, 0.25], "confidence": 0.91},
            {"id": "h002", "bbox": [0.42, 0.2, 0.17, 0.25], "confidence": 0.88},
            {"id": "h003", "bbox": [0.73, 0.2, 0.18, 0.25], "confidence": 0.94},
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return _json_response(
            {
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": json.dumps(aligned)}],
                    }
                ],
            }
        )

    image_data_url = "data:image/png;base64," + base64.b64encode(b"fake-image").decode()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await OpenClawGatewayClient(http).align_hotspots(_plan(), image_data_url)

    assert [row.id for row in result] == ["h001", "h002", "h003"]
    user_content = captured[0]["input"][1]["content"]
    assert user_content[-1] == {
        "type": "input_image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.b64encode(b"fake-image").decode(),
        },
    }


@pytest.mark.asyncio
async def test_image_generate_calls_tool_once_then_uses_media_ticket(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _prepare(monkeypatch, tmp_path)
    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        calls.append((request.method, request.url.path, body))
        if request.url.path == "/tools/invoke":
            return _json_response(
                {"ok": True, "result": {"details": {"paths": ["/tmp/steam.png"]}}}
            )
        if request.url.path == "/__openclaw__/assistant-media" and request.url.params.get("meta"):
            return _json_response({"available": True, "mediaTicket": "ticket-1"})
        return httpx.Response(200, content=b"png-bytes", headers={"content-type": "image/png"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        image = await OpenClawGatewayClient(http).image_generate("draw a steam engine")

    tool_calls = [
        body for method, path, body in calls if path == "/tools/invoke" and method == "POST"
    ]
    assert len(tool_calls) == 1
    assert tool_calls[0]["tool"] == "image_generate"
    assert tool_calls[0]["agentId"] == "flipbook"
    assert tool_calls[0]["args"] == {
        "prompt": "draw a steam engine",
        "model": "openai/gpt-image-2",
        "size": "1536x1024",
        "quality": "low",
        "background": "opaque",
        "count": 1,
    }
    assert image.jpeg_bytes == b"png-bytes"
    assert image.source == "/tmp/steam.png"


@pytest.mark.asyncio
async def test_async_image_task_polls_status_without_second_generate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _prepare(monkeypatch, tmp_path)
    actions: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/tools/invoke":
            body = json.loads(request.content)
            actions.append(str(body.get("action") or "generate"))
            if body.get("action") == "status":
                return _json_response(
                    {
                        "ok": True,
                        "result": {"details": {"active": True, "paths": ["/tmp/task.png"]}},
                    }
                )
            return _json_response(
                {"ok": True, "result": {"details": {"async": True, "task": {"taskId": "t1"}}}}
            )
        if request.url.params.get("meta"):
            return _json_response({"available": True, "mediaTicket": "ticket-2"})
        return httpx.Response(200, content=b"task-image", headers={"content-type": "image/jpeg"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        image = await OpenClawGatewayClient(http).image_generate("draw once")

    assert actions == ["generate", "status"]
    assert image.jpeg_bytes == b"task-image"


@pytest.mark.asyncio
async def test_async_image_task_reads_completed_media_from_session_history(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _prepare(monkeypatch, tmp_path)
    actions: list[str] = []
    source = "/home/node/.openclaw/media/tool-image-generation/steam---task.png"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/tools/invoke":
            body = json.loads(request.content)
            action = str(body.get("action") or body.get("tool") or "generate")
            actions.append(action)
            if body.get("action") == "status":
                return _json_response(
                    {"ok": True, "result": {"details": {"active": False}}}
                )
            if body.get("tool") == "sessions_history":
                return _json_response(
                    {
                        "ok": True,
                        "result": {
                            "details": {
                                "messages": [
                                    {"content": f"MEDIA:{source}"},
                                ]
                            }
                        },
                    }
                )
            return _json_response(
                {"ok": True, "result": {"details": {"async": True, "task": {"taskId": "t1"}}}}
            )
        if request.url.params.get("meta"):
            return _json_response({"available": True, "mediaTicket": "ticket-history"})
        return httpx.Response(200, content=b"history-image", headers={"content-type": "image/png"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        image = await OpenClawGatewayClient(http).image_generate("draw once")

    assert actions == ["image_generate", "status", "sessions_history"]
    assert image.jpeg_bytes == b"history-image"
    assert image.source == source


@pytest.mark.asyncio
async def test_gateway_error_is_not_retried(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _prepare(monkeypatch, tmp_path)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(OpenClawGatewayError):
            await OpenClawGatewayClient(http).responses_json("system", "query")

    assert calls == 1
