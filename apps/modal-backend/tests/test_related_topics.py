from __future__ import annotations

import httpx
import pytest

import generate
from providers import spend


@pytest.mark.asyncio
async def test_related_topics_is_text_only_and_capped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    spend.reset_for_tests()

    async def forbidden(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("related topics must not reach an image provider")

    monkeypatch.setattr("providers.image.generate_image", forbidden)
    transport = httpx.ASGITransport(app=generate.fastapi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/related-topics",
            json={
                "session_id": "session-related-test",
                "page_title": "A clock tower",
                "query": "clock tower",
                "output_locale": "zh-TW",
            },
        )

    assert response.status_code == 200
    topics = response.json()["topics"]
    assert 3 <= len(topics) <= 5
    assert all(isinstance(topic, str) and topic for topic in topics)
