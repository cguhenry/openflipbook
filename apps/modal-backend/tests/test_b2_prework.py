from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from providers import usage
from providers.cancel_registry import GenerationCancelled, GenerationCancelRegistry
from providers.grounded_contract import inject_canonical_sources
from providers.searxng_grounding import (
    GroundingSource,
    SearxngClient,
    SearxngGroundingError,
    canonical_http_url,
    normalize_results,
    useful_source_snippet,
)

RECOVERY_FIXTURE = Path(__file__).parent / "fixtures" / "b2_recovery_child_empty_snippets.json"


def test_canonical_url_removes_tracking_and_fragment() -> None:
    assert (
        canonical_http_url("HTTPS://Example.COM/a?utm_source=x&x=1#frag")
        == "https://example.com/a?x=1"
    )


def test_normalize_dedupes_and_caps_per_host() -> None:
    rows = normalize_results(
        {
            "results": [
                {"title": "<b>A</b>", "url": "https://a.test/1?utm_source=x", "content": "<p>One</p>"},
                {"title": "A duplicate", "url": "https://a.test/1", "content": "dup"},
                {"title": "A2", "url": "https://a.test/2", "content": "Two"},
                {"title": "A3", "url": "https://a.test/3", "content": "Three"},
                {"title": "B", "url": "https://b.test/", "content": "Bee"},
            ]
        }
    )
    assert [row.id for row in rows] == ["S1", "S2", "S3"]
    assert [row.url for row in rows] == [
        "https://a.test/1",
        "https://a.test/2",
        "https://b.test/",
    ]
    assert rows[0].title == "A"
    assert rows[0].snippet == "One"


@pytest.mark.asyncio
async def test_searxng_client_posts_json_search() -> None:
    usage.reset_for_tests()
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/search"
        body = request.content.decode()
        assert "format=json" in body
        assert "safesearch=1" in body
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "Steam engine",
                        "url": "https://example.org/steam",
                        "content": "A heat engine.",
                    }
                ]
            },
        )

    client = SearxngClient("http://searxng", transport=httpx.MockTransport(handler))
    try:
        rows = await client.search("steam engine")
    finally:
        await client.aclose()
    assert rows[0].id == "S1"
    assert usage.snapshot()["counters"]["searxng_searches"] == 1
    usage.reset_for_tests()


@pytest.mark.asyncio
async def test_searxng_403_is_explicit() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="disabled")

    client = SearxngClient("http://searxng", transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(SearxngGroundingError, match="disabled"):
            await client.search("x")
    finally:
        await client.aclose()


def test_canonical_sources_override_model_sources_and_unknown_ids() -> None:
    sources = [
        GroundingSource("S1", "A", "https://a.test/", "aaa"),
        GroundingSource("S2", "B", "https://b.test/", "bbb"),
    ]
    result = inject_canonical_sources(
        {
            "text_blocks": [
                {"id": "t1", "text": "hello", "source_ids": ["S2", "FAKE", "S2"]},
                {"id": "t2", "text": "world"},
            ],
            "sources": [{"id": "FAKE", "url": "https://evil.invalid"}],
        },
        sources,
    )
    assert result["text_blocks"][0]["source_ids"] == ["S2"]
    assert result["text_blocks"][1]["source_ids"] == []
    assert [row["id"] for row in result["sources"]] == ["S1", "S2"]


def test_actual_b2_recovery_fixture_gets_nonempty_display_fallback() -> None:
    payload = json.loads(RECOVERY_FIXTURE.read_text(encoding="utf-8"))
    for source in payload["sources"]:
        result = useful_source_snippet(
            snippet=source["snippet"],
            title=source["title"],
            url=source["url"],
        )
        assert result == source["title"]
        assert GroundingSource(
            source["id"], source["title"], source["url"], source["snippet"]
        ).page_contract_ref()["snippet"] == source["title"]


def test_source_snippet_prefers_content_and_then_hostname() -> None:
    assert (
        useful_source_snippet(
            content="<p>Steam powers a piston.</p>",
            title="example.org",
            url="https://example.org/",
        )
        == "Steam powers a piston."
    )
    assert (
        useful_source_snippet(
            content="", snippet="", title="", url="https://example.org/path"
        )
        == "example.org"
    )


@pytest.mark.asyncio
async def test_cancel_registry_lifecycle() -> None:
    registry = GenerationCancelRegistry()
    token = await registry.start("g1")
    assert not token.cancelled()
    assert await registry.active("g1")
    assert await registry.cancel("g1")
    assert token.cancelled()
    with pytest.raises(GenerationCancelled):
        token.raise_if_cancelled()
    await registry.finish("g1")
    assert not await registry.active("g1")
    assert not await registry.cancel("g1")
