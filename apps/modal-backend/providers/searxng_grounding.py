"""Small, snippet-only SearXNG grounding adapter for B2.

The adapter never follows result URLs.  It only normalizes the JSON returned by
the local SearXNG deployment and gives the planner stable local source ids.
"""

from __future__ import annotations

import html
import os
import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx


class SearxngGroundingError(RuntimeError):
    """Raised when the local SearXNG JSON contract cannot be used."""


_TRACKING_KEYS = {"fbclid", "gclid", "mc_cid", "mc_eid"}


def plain_text(value: object, limit: int = 360) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit].strip()


def useful_source_snippet(
    *,
    content: object = "",
    snippet: object = "",
    title: object = "",
    url: object = "",
    limit: int = 360,
) -> str:
    """Return display-only source text without inventing factual prose."""

    for candidate in (content, snippet, title):
        value = plain_text(candidate, limit=limit)
        if value:
            return value

    try:
        hostname = urlsplit(str(url or "")).hostname or ""
    except ValueError:
        hostname = ""
    return plain_text(hostname, limit=limit) or "Source"


def canonical_http_url(raw: object) -> str | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        return None
    kept: list[tuple[str, str]] = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        low = key.lower()
        if low.startswith("utm_") or low in _TRACKING_KEYS:
            continue
        kept.append((key, value))
    return urlunsplit(
        (
            parts.scheme.lower(),
            parts.netloc.lower(),
            parts.path or "/",
            urlencode(kept),
            "",
        )
    )


@dataclass(frozen=True)
class GroundingSource:
    id: str
    title: str
    url: str
    snippet: str
    engine: str | None = None

    def page_contract_ref(self) -> dict[str, str]:
        title = plain_text(self.title, limit=180)
        if not title:
            try:
                title = plain_text(urlsplit(self.url).hostname or "", limit=180)
            except ValueError:
                title = ""
        title = title or "Source"
        return {
            "id": self.id,
            "title": title,
            "url": self.url,
            "snippet": useful_source_snippet(
                snippet=self.snippet,
                title=title,
                url=self.url,
            ),
        }


def normalize_results(payload: dict, limit: int = 5) -> list[GroundingSource]:
    rows = payload.get("results")
    if not isinstance(rows, list):
        raise SearxngGroundingError("SearXNG JSON has no results array")

    seen_urls: set[str] = set()
    per_host: dict[str, int] = {}
    out: list[GroundingSource] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = canonical_http_url(row.get("url"))
        if not url or url in seen_urls:
            continue
        host = urlsplit(url).netloc
        if per_host.get(host, 0) >= 2:
            continue
        title = plain_text(row.get("title"), 180) or host
        snippet = useful_source_snippet(
            content=row.get("content"),
            snippet=row.get("snippet"),
            title=title,
            url=url,
        )
        out.append(
            GroundingSource(
                id=f"S{len(out) + 1}",
                title=title,
                url=url,
                snippet=snippet,
                engine=plain_text(row.get("engine"), 80) or None,
            )
        )
        seen_urls.add(url)
        per_host[host] = per_host.get(host, 0) + 1
        if len(out) >= limit:
            break
    return out


class SearxngClient:
    """POST-only client with injectable transport for zero-call tests."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout_s: float = 8.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=httpx.Timeout(timeout_s),
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def search(
        self,
        query: str,
        *,
        language: str = "all",
        limit: int = 5,
    ) -> list[GroundingSource]:
        response = await self._client.post(
            "/search",
            data={
                "q": query,
                "format": "json",
                "categories": "general",
                "language": language,
                "safesearch": "1",
                "pageno": "1",
            },
            headers={"Accept": "application/json"},
        )
        if response.status_code == 403:
            raise SearxngGroundingError("SearXNG JSON format is disabled (HTTP 403)")
        if response.status_code != 200:
            raise SearxngGroundingError(
                f"SearXNG HTTP {response.status_code}: {response.text[:200]}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise SearxngGroundingError("SearXNG response was not JSON") from exc
        if not isinstance(payload, dict):
            raise SearxngGroundingError("SearXNG response was not a JSON object")
        return normalize_results(payload, limit=limit)


def configured_base_url() -> str:
    return os.environ.get("FLIPBOOK_SEARXNG_BASE_URL", "").strip().rstrip("/")
