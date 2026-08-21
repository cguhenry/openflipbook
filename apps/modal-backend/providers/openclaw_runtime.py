"""Server-side OpenClaw Gateway runtime adapter for the R1 live path.

The adapter deliberately owns one narrow wire contract:

* text planning/alignment uses the authenticated OpenResponses endpoint with
  the ``openclaw/flipbook`` route;
* image generation uses the authenticated ``image_generate`` tool exactly once;
* an asynchronous image task may be polled for status, but is never generated
  again;
* generated media is downloaded through the assistant-media ticket flow.

There is no provider fallback or SDK retry in this module.  The Gateway is the
only live provider when ``FLIPBOOK_LIVE_PROVIDER=openclaw`` is selected.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from _env import env_flag
from providers.openclaw_contract import (
    AlignedBox,
    OpenClawContractError,
    extract_json_object_from_envelope,
    validate_alignment_minimal,
    validate_page_plan_minimal,
)

DEFAULT_BASE_URL = "http://host.docker.internal:18789"
DEFAULT_BEARER_FILE = "/run/secrets/openclaw_gateway_secret"
DEFAULT_AGENT = "flipbook"
DEFAULT_GATEWAY_MODEL = "openclaw/flipbook"
DEFAULT_TEXT_MODEL = "openai/gpt-5.6-luna"
DEFAULT_IMAGE_MODEL = "openai/gpt-image-2"
DEFAULT_IMAGE_SIZE = "1536x1024"
_MEDIA_PATH_RE = re.compile(
    r"/home/node/\.openclaw/media/[A-Za-z0-9._/-]+\.(?:png|jpe?g|webp|gif)",
    re.IGNORECASE,
)


class OpenClawGatewayError(RuntimeError):
    """Raised for an authenticated Gateway or contract failure."""


@dataclass(frozen=True)
class OpenClawImage:
    jpeg_bytes: bytes
    mime_type: str
    source: str


_GATEWAY_SEMAPHORE: asyncio.Semaphore | None = None
_GATEWAY_SEMAPHORE_LIMIT: int | None = None


def enabled() -> bool:
    """Return whether the live OpenClaw branch is selected.

    ``MOCK_PROVIDERS`` always wins so test and zero-key runs cannot reach the
    Gateway even when a deployment environment carries the live selector.
    """

    return os.environ.get(
        "FLIPBOOK_LIVE_PROVIDER", ""
    ).strip().lower() == "openclaw" and not env_flag("MOCK_PROVIDERS")


def base_url() -> str:
    return os.environ.get("FLIPBOOK_OPENCLAW_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")


def bearer_file() -> str:
    return os.environ.get("FLIPBOOK_OPENCLAW_BEARER_FILE", DEFAULT_BEARER_FILE).strip()


def agent_id() -> str:
    return os.environ.get("FLIPBOOK_OPENCLAW_AGENT", DEFAULT_AGENT).strip() or DEFAULT_AGENT


def gateway_model() -> str:
    return DEFAULT_GATEWAY_MODEL


def text_model() -> str:
    return (
        os.environ.get("FLIPBOOK_OPENCLAW_TEXT_MODEL", DEFAULT_TEXT_MODEL).strip()
        or DEFAULT_TEXT_MODEL
    )


def image_model() -> str:
    return (
        os.environ.get("FLIPBOOK_OPENCLAW_IMAGE_MODEL", DEFAULT_IMAGE_MODEL).strip()
        or DEFAULT_IMAGE_MODEL
    )


def _positive_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def request_timeout_s() -> float:
    return _positive_float("FLIPBOOK_OPENCLAW_REQUEST_TIMEOUT_S", 90.0)


def image_timeout_s() -> float:
    return _positive_float("FLIPBOOK_OPENCLAW_IMAGE_TIMEOUT_S", 180.0)


def max_concurrent() -> int:
    raw = os.environ.get("FLIPBOOK_OPENCLAW_MAX_CONCURRENT", "1").strip()
    try:
        value = int(raw)
    except ValueError:
        return 1
    return max(1, value)


def _semaphore() -> asyncio.Semaphore:
    global _GATEWAY_SEMAPHORE, _GATEWAY_SEMAPHORE_LIMIT
    limit = max_concurrent()
    if _GATEWAY_SEMAPHORE is None or limit != _GATEWAY_SEMAPHORE_LIMIT:
        _GATEWAY_SEMAPHORE = asyncio.Semaphore(limit)
        _GATEWAY_SEMAPHORE_LIMIT = limit
    return _GATEWAY_SEMAPHORE


def _read_bearer() -> str:
    path = Path(bearer_file())
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise OpenClawGatewayError("OpenClaw Gateway bearer secret is unreadable") from exc
    if not value:
        raise OpenClawGatewayError("OpenClaw Gateway bearer secret is empty")
    return value


def _headers() -> dict[str, str]:
    secret = _read_bearer()
    return {
        "Authorization": f"Bearer {secret}",
        "Content-Type": "application/json",
    }


def _decode_image_data_url(data_url: str) -> tuple[str, str]:
    header, separator, encoded = data_url.partition(",")
    if separator != "," or not header.lower().startswith("data:"):
        raise OpenClawGatewayError("alignment input must be a base64 image data URL")
    metadata = header[5:].split(";", 1)
    mime_type = metadata[0].strip().lower()
    if not mime_type.startswith("image/") or "base64" not in header.lower():
        raise OpenClawGatewayError("alignment input must be a base64 image data URL")
    try:
        base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise OpenClawGatewayError("alignment image data URL is not valid base64") from exc
    return mime_type, encoded


def _message(role: str, text: str) -> dict[str, Any]:
    return {
        "type": "message",
        "role": role,
        "content": [{"type": "input_text", "text": text}],
    }


def _image_input(data_url: str) -> dict[str, Any]:
    mime_type, encoded = _decode_image_data_url(data_url)
    return {
        "type": "input_image",
        "source": {"type": "base64", "media_type": mime_type, "data": encoded},
    }


def _response_text(envelope: dict[str, Any]) -> dict[str, Any]:
    status = envelope.get("status")
    if status not in (None, "completed"):
        raise OpenClawGatewayError(f"OpenClaw Responses request ended with status {status!r}")
    try:
        return extract_json_object_from_envelope(envelope)
    except OpenClawContractError as exc:
        raise OpenClawGatewayError("OpenClaw Responses output did not contain JSON") from exc


def _source_candidates(value: Any) -> list[str]:
    """Collect only media path-shaped values from an image tool result."""

    found: list[str] = []

    def walk(node: Any, key: str = "") -> None:
        if isinstance(node, dict):
            for child_key, child in node.items():
                if child_key in {
                    "path",
                    "filePath",
                    "file_path",
                    "source",
                    "mediaUrl",
                    "media_url",
                } and isinstance(child, str):
                    found.append(child)
                elif child_key in {"paths", "mediaUrls", "media_urls"}:
                    if isinstance(child, list):
                        found.extend(item for item in child if isinstance(item, str))
                    elif isinstance(child, str):
                        found.append(child)
                elif child_key in {"attachments", "media", "details", "result", "task"}:
                    walk(child, child_key)
        elif isinstance(node, list):
            for item in node:
                walk(item, key)

    walk(value)
    return [item.strip() for item in found if item.strip()]


def _history_media_candidates(value: Any) -> list[str]:
    """Extract Gateway-managed media paths from a completion transcript."""

    try:
        serialized = json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return []
    return list(dict.fromkeys(match.group(0) for match in _MEDIA_PATH_RE.finditer(serialized)))


def _task_present(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    details = value.get("details")
    if isinstance(details, dict) and isinstance(details.get("task"), dict):
        return True
    return isinstance(value.get("task"), dict)


class OpenClawGatewayClient:
    """Small authenticated HTTP client with injectable transport for tests."""

    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        self._http_client = http_client

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        timeout: float,
    ) -> httpx.Response:
        async with _semaphore():
            headers = _headers()
            if self._http_client is not None:
                return await self._http_client.request(
                    method,
                    f"{base_url()}{path}",
                    headers=headers,
                    json=json_body,
                    params=params,
                    timeout=timeout,
                )
            async with httpx.AsyncClient(timeout=timeout) as client:
                return await client.request(
                    method,
                    f"{base_url()}{path}",
                    headers=headers,
                    json=json_body,
                    params=params,
                    timeout=timeout,
                )

    async def _json_request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any],
        timeout: float,
    ) -> dict[str, Any]:
        try:
            response = await self._request(method, path, json_body=json_body, timeout=timeout)
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPError as exc:
            raise OpenClawGatewayError("OpenClaw Gateway HTTP request failed") from exc
        except ValueError as exc:
            raise OpenClawGatewayError("OpenClaw Gateway returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise OpenClawGatewayError("OpenClaw Gateway returned a non-object JSON payload")
        return payload

    async def responses_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        image_data_url: str | None = None,
        max_output_tokens: int = 1800,
    ) -> dict[str, Any]:
        user_content: list[dict[str, Any]] = [
            {"type": "input_text", "text": user_prompt},
        ]
        if image_data_url is not None:
            user_content.append(_image_input(image_data_url))
        payload = await self._json_request(
            "POST",
            "/v1/responses",
            json_body={
                "model": gateway_model(),
                "input": [
                    _message("system", system_prompt),
                    {
                        "type": "message",
                        "role": "user",
                        "content": user_content,
                    },
                ],
                "tool_choice": "none",
                "max_output_tokens": max_output_tokens,
                "temperature": 0,
            },
            timeout=request_timeout_s(),
        )
        return _response_text(payload)

    async def page_plan(
        self,
        system_prompt: str,
        user_prompt: str,
    ) -> dict[str, Any]:
        raw = await self.responses_json(system_prompt, user_prompt)
        try:
            return validate_page_plan_minimal(raw)
        except OpenClawContractError as exc:
            raise OpenClawGatewayError(f"OpenClaw PagePlan validation failed: {exc}") from exc

    async def align_hotspots(
        self,
        page_plan: dict[str, Any],
        image_data_url: str,
    ) -> list[AlignedBox]:
        hotspot_rows = page_plan.get("hotspots")
        if not isinstance(hotspot_rows, list):
            raise OpenClawGatewayError("PagePlan hotspots are missing before alignment")
        expected_ids = [str(row.get("id")) for row in hotspot_rows if isinstance(row, dict)]
        if len(expected_ids) != len(hotspot_rows) or not expected_ids:
            raise OpenClawGatewayError("PagePlan hotspot ids are malformed before alignment")
        system = (
            "You align planned OpenFlipbook hotspots to the supplied rendered image. "
            "Return exactly one JSON object with key hotspots. Include exactly one row "
            "for every requested id, with id, bbox [x,y,width,height] and confidence. "
            "All bbox values are normalized 0..1, positive, and fully contained. "
            "Do not return prose, markdown, or any other keys."
        )
        user = (
            "Planned PagePlan hotspots:\n"
            f"{_json_for_prompt(hotspot_rows)}\n\n"
            f"Expected ids in this exact set: {_json_for_prompt(expected_ids)}"
        )
        raw = await self.responses_json(
            system,
            user,
            image_data_url=image_data_url,
            max_output_tokens=900,
        )
        try:
            return validate_alignment_minimal(raw, expected_ids)
        except OpenClawContractError as exc:
            raise OpenClawGatewayError(f"OpenClaw hotspot alignment failed: {exc}") from exc

    async def image_generate(self, prompt: str) -> OpenClawImage:
        payload = await self._json_request(
            "POST",
            "/tools/invoke",
            json_body={
                "tool": "image_generate",
                "agentId": agent_id(),
                "args": {
                    "prompt": prompt,
                    "model": image_model(),
                    "size": DEFAULT_IMAGE_SIZE,
                    "quality": "low",
                    "background": "opaque",
                    "count": 1,
                },
            },
            timeout=image_timeout_s(),
        )
        if payload.get("ok") is not True:
            raise OpenClawGatewayError("OpenClaw image_generate tool failed")
        result = payload.get("result")
        source = _source_candidates(result)
        if source:
            return await self._download_media(source[0])
        if not _task_present(result):
            raise OpenClawGatewayError("OpenClaw image_generate returned no media or task")
        return await self._poll_image_task()

    async def _poll_image_task(self) -> OpenClawImage:
        deadline = asyncio.get_running_loop().time() + image_timeout_s()
        while True:
            payload = await self._json_request(
                "POST",
                "/tools/invoke",
                json_body={
                    "tool": "image_generate",
                    "action": "status",
                    "agentId": agent_id(),
                    "args": {"action": "status"},
                },
                timeout=request_timeout_s(),
            )
            if payload.get("ok") is not True:
                raise OpenClawGatewayError("OpenClaw image_generate status failed")
            result = payload.get("result")
            source = _source_candidates(result)
            if source:
                return await self._download_media(source[0])
            details = result.get("details") if isinstance(result, dict) else None
            active = details.get("active") if isinstance(details, dict) else None
            if active is False:
                history = await self._json_request(
                    "POST",
                    "/tools/invoke",
                    json_body={
                        "tool": "sessions_history",
                        "agentId": agent_id(),
                        "args": {
                            "sessionKey": f"agent:{agent_id()}:main",
                            "limit": 20,
                            "includeTools": True,
                        },
                    },
                    timeout=request_timeout_s(),
                )
                if history.get("ok") is True:
                    history_sources = _history_media_candidates(history.get("result"))
                    if history_sources:
                        return await self._download_media(history_sources[-1])
                raise OpenClawGatewayError("OpenClaw image task completed without assistant media")
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise OpenClawGatewayError("OpenClaw image task timed out")
            await asyncio.sleep(min(1.0, remaining))

    async def _download_media(self, source: str) -> OpenClawImage:
        meta = await self._request(
            "GET",
            "/__openclaw__/assistant-media",
            params={"source": source, "meta": "1"},
            timeout=request_timeout_s(),
        )
        try:
            meta.raise_for_status()
            metadata = meta.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise OpenClawGatewayError("OpenClaw assistant-media metadata failed") from exc
        if not isinstance(metadata, dict) or metadata.get("available") is not True:
            raise OpenClawGatewayError("OpenClaw assistant media is unavailable")
        ticket = metadata.get("mediaTicket")
        if not isinstance(ticket, str) or not ticket:
            raise OpenClawGatewayError("OpenClaw assistant media ticket is missing")

        media = await self._request(
            "GET",
            "/__openclaw__/assistant-media",
            params={"source": source, "mediaTicket": ticket},
            timeout=image_timeout_s(),
        )
        try:
            media.raise_for_status()
        except httpx.HTTPError as exc:
            raise OpenClawGatewayError("OpenClaw assistant-media download failed") from exc
        if not media.content:
            raise OpenClawGatewayError("OpenClaw assistant-media download was empty")
        mime_type = (media.headers.get("content-type") or "image/jpeg").split(";", 1)[0]
        if not mime_type.startswith("image/"):
            raise OpenClawGatewayError("OpenClaw assistant-media response is not an image")
        return OpenClawImage(media.content, mime_type, source)


def _json_for_prompt(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def image_dimensions(image_bytes: bytes) -> tuple[int, int]:
    """Read dimensions when Pillow is available; R1 images have a fixed fallback."""

    try:
        from PIL import Image

        with Image.open(io.BytesIO(image_bytes)) as image:
            return int(image.width), int(image.height)
    except Exception:
        return 1536, 1024
