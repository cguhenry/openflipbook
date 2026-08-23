from __future__ import annotations

import base64
from typing import Any

import httpx
import pytest

import generate
from providers import spend


def _image_data_url() -> str:
    return "data:image/jpeg;base64," + base64.b64encode(b"b3-fixture-image").decode()


@pytest.mark.asyncio
async def test_mock_image_seed_is_one_metered_vision_call_without_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.delenv("FLIPBOOK_LIVE_PROVIDER", raising=False)
    spend.reset_for_tests()
    calls: list[str] = []

    def record_vlm_call(session_id: str) -> float:
        calls.append(session_id)
        return 0.005

    monkeypatch.setattr(spend, "record_vlm_call", record_vlm_call)

    async def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("mock image seed reached a live provider route")

    monkeypatch.setattr("providers.openclaw_runtime.OpenClawGatewayClient.image_seed", forbidden)
    monkeypatch.setattr("providers.openclaw_runtime.OpenClawGatewayClient.align_hotspots", forbidden)
    monkeypatch.setattr("providers.openclaw_runtime.OpenClawGatewayClient.image_generate", forbidden)

    transport = httpx.ASGITransport(app=generate.fastapi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/image-seed",
            headers={"x-trace-id": "b3-mock-trace"},
            json={"session_id": "session_b3_mock", "image_data_url": _image_data_url()},
        )

    assert response.status_code == 200
    payload = response.json()
    assert calls == ["session_b3_mock"]
    assert len(payload["page_plan"]["text_blocks"]) == 2
    assert 2 <= len(payload["page_plan"]["hotspots"]) <= 8
    assert {row["id"] for row in payload["page_plan"]["hotspots"]} == {
        row["id"] for row in payload["aligned_hotspots"]
    }
    assert all("tap_region" in row for row in payload["aligned_hotspots"])
