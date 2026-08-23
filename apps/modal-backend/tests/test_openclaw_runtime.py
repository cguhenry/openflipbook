"""Fake-HTTP proof for the R1 OpenClaw Gateway adapter."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from providers.openclaw_contract import (
    OPENCLAW_RESPONSES_ALIGNMENT_INVALID,
    OPENCLAW_RESPONSES_JSON_SCHEMA_INVALID,
    OPENCLAW_RESPONSES_NO_OUTPUT_TEXT,
    OPENCLAW_RESPONSES_PAGEPLAN_INVALID,
    OPENCLAW_RESPONSES_POSSIBLY_TRUNCATED_JSON,
    OPENCLAW_RESPONSES_STATUS_ERROR,
    OPENCLAW_RESPONSES_TEXT_NOT_JSON,
    classify_response_failure,
    extract_json_object_from_envelope,
    safe_response_diagnostics,
    safe_validation_errors,
)
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


def _response_envelope(
    text: str | None = None,
    *,
    status: str = "completed",
    content_type: str = "output_text",
) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    if text is not None:
        content.append({"type": content_type, "text": text})
    return {
        "id": "resp_synthetic",
        "status": status,
        "output": [{"type": "message", "content": content}],
    }


def test_response_envelope_observability_matrix_is_safe() -> None:
    json_object = '{"page_plan": {}}'
    assert extract_json_object_from_envelope(_response_envelope(json_object)) == {
        "page_plan": {}
    }
    assert extract_json_object_from_envelope(
        _response_envelope("```json\n{" + '"ok": true' + "}\n```")
    ) == {"ok": True}
    assert extract_json_object_from_envelope(
        _response_envelope("result follows {\"ok\":true} done")
    ) == {"ok": True}

    cases = (
        (_response_envelope("not json"), OPENCLAW_RESPONSES_TEXT_NOT_JSON),
        (_response_envelope(), OPENCLAW_RESPONSES_NO_OUTPUT_TEXT),
        (
            _response_envelope('{"page_plan":'),
            OPENCLAW_RESPONSES_POSSIBLY_TRUNCATED_JSON,
        ),
        (_response_envelope("failed", status="failed"), OPENCLAW_RESPONSES_STATUS_ERROR),
    )
    for envelope, expected in cases:
        assert classify_response_failure(envelope) == expected
        diagnostics = safe_response_diagnostics(envelope)
        assert diagnostics["code"] == expected
        assert diagnostics["raw_text_saved"] is False
        assert diagnostics["raw_envelope_saved"] is False

    secret_text = (
        "Authorization: Bearer TOP_SECRET data:image/png;base64,AAAA {\"x\":"
    )
    diagnostics = safe_response_diagnostics(
        _response_envelope(secret_text),
    )
    serialized = json.dumps(diagnostics, sort_keys=True)
    for forbidden in ("TOP_SECRET", "data:image", "Authorization", "AAAA"):
        assert forbidden not in serialized
    candidate = diagnostics["candidate_texts"][0]
    assert candidate["length"] == len(secret_text)
    assert len(candidate["sha256"]) == 64
    assert classify_response_failure(_response_envelope(json_object)) == (
        OPENCLAW_RESPONSES_JSON_SCHEMA_INVALID
    )

    refusal = _response_envelope()
    refusal["output"][0]["content"] = [
        {"type": "refusal", "refusal": "private refusal text"}
    ]
    refusal["error"] = {
        "type": "provider_error",
        "code": "synthetic_error",
        "message": "do not expose this message",
    }
    refusal["incomplete_details"] = {
        "type": "max_output_tokens",
        "reason": "synthetic reason",
    }
    refusal_diagnostics = safe_response_diagnostics(refusal)
    assert refusal_diagnostics["code"] == OPENCLAW_RESPONSES_NO_OUTPUT_TEXT
    assert refusal_diagnostics["content_part_types"] == ["refusal"]
    assert refusal_diagnostics["error"] == {
        "type": "provider_error",
        "code": "synthetic_error",
    }
    assert refusal_diagnostics["incomplete"]["reason"] == "synthetic reason"
    assert "private refusal text" not in json.dumps(refusal_diagnostics)
    assert "do not expose this message" not in json.dumps(refusal_diagnostics)


@pytest.mark.asyncio
async def test_responses_failure_contains_only_safe_diagnostics(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _prepare(monkeypatch, tmp_path)
    secret_text = "Authorization: Bearer TOP_SECRET data:image/png;base64," + "A" * 300

    def handler(_request: httpx.Request) -> httpx.Response:
        return _json_response(_response_envelope(secret_text))

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        with pytest.raises(OpenClawGatewayError) as raised:
            await OpenClawGatewayClient(http).responses_json("system", "user")

    message = str(raised.value)
    assert OPENCLAW_RESPONSES_TEXT_NOT_JSON in message
    assert "raw_text_saved" in message
    assert "raw_envelope_saved" in message
    for forbidden in ("TOP_SECRET", "data:image", "Authorization", "AAAA"):
        assert forbidden not in message


@pytest.mark.asyncio
async def test_image_seed_schema_and_alignment_failures_are_stable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _prepare(monkeypatch, tmp_path)
    payloads = (
        (
            {"page_plan": {}},
            OPENCLAW_RESPONSES_PAGEPLAN_INVALID,
        ),
        (
            {"page_plan": _plan(), "aligned_hotspots": []},
            OPENCLAW_RESPONSES_ALIGNMENT_INVALID,
        ),
    )

    for payload, expected_code in payloads:
        def handler(
            _request: httpx.Request, payload: dict[str, Any] = payload
        ) -> httpx.Response:
            return _json_response(_response_envelope(json.dumps(payload)))

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            with pytest.raises(OpenClawGatewayError) as raised:
                await OpenClawGatewayClient(http).image_seed(
                    "data:image/png;base64," + base64.b64encode(b"seed").decode()
                )
        assert expected_code in str(raised.value)
        detail = json.loads(str(raised.value).split("] ", 1)[1])
        assert set(detail) == {"validation_errors"}
        assert all(set(row) == {"loc", "type"} for row in detail["validation_errors"])


def test_pageplan_validation_diagnostics_are_only_safe_locations_and_types() -> None:
    from contracts.page_contract import PagePlan

    with pytest.raises(Exception) as raised:
        PagePlan.model_validate(
            {"schema_version": "1.0", "scene": {"prompt": "private image body"}}
        )

    safe = safe_validation_errors(raised.value)
    assert safe
    assert all(set(row) == {"loc", "type"} for row in safe)
    assert all("input" not in row for row in safe)


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
async def test_image_seed_returns_contract_and_makes_one_vision_request(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _prepare(monkeypatch, tmp_path)
    calls: list[tuple[str, dict[str, Any]]] = []
    body_sizes: list[int] = []
    aligned = {
        "aligned_hotspots": [
            {
                "id": "h001",
                "actual_bbox": [0.1, 0.2, 0.18, 0.25],
                "alignment_confidence": 0.91,
                "tap_region": [[0, 0], [1, 0], [1, 1]],
            },
            {
                "id": "h002",
                "actual_bbox": [0.42, 0.2, 0.17, 0.25],
                "alignment_confidence": 0.88,
            },
            {
                "id": "h003",
                "actual_bbox": [0.73, 0.2, 0.18, 0.25],
                "alignment_confidence": 0.94,
            },
        ],
    }
    envelope = {"page_plan": _plan(), **aligned}

    def handler(request: httpx.Request) -> httpx.Response:
        body_sizes.append(len(request.content))
        calls.append((request.url.path, json.loads(request.content)))
        return _json_response(
            {
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": json.dumps(envelope)}],
                    }
                ],
            }
        )

    image_data_url = "data:image/jpeg;base64," + base64.b64encode(b"seed-image").decode()
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        plan, result = await OpenClawGatewayClient(http).image_seed(image_data_url)

    assert len(calls) == 1
    assert body_sizes[0] <= 20 * 1024 * 1024
    assert calls[0][0] == "/v1/responses"
    assert calls[0][1]["tool_choice"] == "none"
    assert not calls[0][1].get("tools")
    assert calls[0][1]["model"] == "openclaw/flipbook"
    assert calls[0][1]["max_output_tokens"] == 3000
    system_text = calls[0][1]["input"][0]["content"][0]["text"]
    assert "first character must be {" in system_text
    assert "last character must be }" in system_text
    assert "no markdown" in system_text
    assert "explicitly contain the words 'no text'" in system_text
    for required in (
        '"title"',
        '"summary"',
        '"t001"',
        '"anchor"',
        '"hotspots"',
        '"aligned_hotspots"',
        '"actual_bbox"',
        '"alignment_confidence"',
        '"motion_hints"',
        '"sources"',
    ):
        assert required in system_text
    assert "Do not emit bbox inside text_blocks" in system_text
    assert "MotionHint fields target_id and hint" in system_text
    user_content = calls[0][1]["input"][1]["content"]
    image_parts = [part for part in user_content if part["type"] == "input_image"]
    assert len(image_parts) == 1
    assert image_parts[0]["source"]["type"] == "base64"
    assert "url" not in image_parts[0]["source"]
    assert image_parts[0]["source"]["media_type"] in {
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/heic",
        "image/heif",
    }
    assert len(base64.b64decode(image_parts[0]["source"]["data"], validate=True)) <= 10 * 1024 * 1024
    assert plan["sources"] == []
    assert [row["id"] for row in result] == ["h001", "h002", "h003"]
    assert result[0]["tap_region"] != aligned["aligned_hotspots"][0]["tap_region"]


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
        body
        for method, path, body in calls
        if path == "/tools/invoke" and method == "POST" and body is not None
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
