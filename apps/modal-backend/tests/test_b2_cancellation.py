from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from providers.openclaw_runtime import OpenClawGatewayClient


@pytest.mark.asyncio
async def test_image_polling_stops_after_fake_delayed_transport_is_cancelled(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    secret = tmp_path / "gateway-secret"
    secret.write_text("fake-secret\n", encoding="utf-8")
    secret.chmod(0o600)
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_BEARER_FILE", str(secret))
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_BASE_URL", "http://fake-gateway")
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_IMAGE_TIMEOUT_S", "2")

    status_started = asyncio.Event()
    release_status = asyncio.Event()
    cancelled = False
    calls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal cancelled
        payload = json.loads(request.content)
        calls.append(str(payload.get("action") or payload["args"].get("action") or "generate"))
        if payload.get("action") == "status":
            status_started.set()
            await release_status.wait()
            return httpx.Response(200, json={"ok": True, "result": {"details": {"active": True}}})
        return httpx.Response(
            200,
            json={"ok": True, "result": {"details": {"task": {"id": "fake-task"}}}},
        )

    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport)
    client = OpenClawGatewayClient(http)

    async def is_cancelled() -> bool:
        return cancelled

    task = asyncio.create_task(
        client.image_generate("fake image", is_cancelled=lambda: cancelled)
    )
    await asyncio.wait_for(status_started.wait(), timeout=1)
    cancelled = True
    release_status.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    await http.aclose()

    assert calls == ["generate", "status"]
