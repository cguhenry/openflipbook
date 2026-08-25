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
from typing import Any, Literal

import httpx

from _env import env_flag
from contracts.image_seed_contract import normalize_image_seed_envelope
from providers import breaker, usage
from providers.openclaw_contract import (
    OPENCLAW_RESPONSES_ALIGNMENT_INVALID,
    OPENCLAW_RESPONSES_JSON_SCHEMA_INVALID,
    OPENCLAW_RESPONSES_PAGEPLAN_INVALID,
    OPENCLAW_RESPONSES_STATUS_ERROR,
    AlignedBox,
    OpenClawContractError,
    classify_response_failure,
    extract_json_object_from_envelope,
    safe_response_diagnostics,
    safe_validation_errors,
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

    def __init__(self, message: str, *, transient: bool = False) -> None:
        self.transient = transient
        super().__init__(message)


class OpenClawCircuitOpenError(OpenClawGatewayError):
    """Stable fail-before-dispatch signal for a cooling OpenClaw stage."""

    code = "OPENCLAW_CIRCUIT_OPEN"

    def __init__(self, stage: str, retry_after_seconds: int) -> None:
        self.stage = stage
        self.retry_after_seconds = retry_after_seconds
        super().__init__(
            f"{self.code}: {stage} unavailable; retry after {retry_after_seconds}s"
        )


@dataclass(frozen=True)
class OpenClawImage:
    jpeg_bytes: bytes
    mime_type: str
    source: str


_GATEWAY_SEMAPHORE: asyncio.Semaphore | None = None
_GATEWAY_SEMAPHORE_LIMIT: int | None = None
_BREAKER_KEYS = {
    "responses": "openclaw:responses",
    "image": "openclaw:image",
}


def breaker_snapshot() -> dict[str, dict[str, int | float | str]]:
    return {stage: breaker.snapshot(key) for stage, key in _BREAKER_KEYS.items()}


def _before_stage(stage: str) -> str:
    key = _BREAKER_KEYS[stage]
    state = breaker.snapshot(key)
    if state["state"] == "open":
        raise OpenClawCircuitOpenError(stage, int(state["retry_after_seconds"]))
    return key


def _record_stage_failure(key: str, exc: OpenClawGatewayError) -> None:
    if exc.transient:
        breaker.record_failure(key)


def _http_failure(message: str, exc: httpx.HTTPError) -> OpenClawGatewayError:
    status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
    transient = isinstance(exc, httpx.RequestError) or status == 429 or bool(status and status >= 500)
    suffix = f" (HTTP {status})" if status is not None else ""
    return OpenClawGatewayError(message + suffix, transient=transient)


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


def _format_response_contract_failure(
    diagnostics: dict[str, Any] | None,
    code: str,
    message: str,
) -> OpenClawGatewayError:
    safe = dict(diagnostics or {})
    safe["code"] = code
    return OpenClawGatewayError(
        f"{message} [{code}] "
        + json.dumps(safe, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        transient=code == OPENCLAW_RESPONSES_STATUS_ERROR,
    )


def _format_validation_contract_failure(
    exc: BaseException,
    code: str,
    message: str,
) -> OpenClawGatewayError:
    """Expose only safe Pydantic locations/types for model contract failures."""

    detail = {"validation_errors": safe_validation_errors(exc)}
    return OpenClawGatewayError(
        f"{message} [{code}] "
        + json.dumps(detail, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )


def _response_text(envelope: dict[str, Any]) -> dict[str, Any]:
    status = envelope.get("status")
    if status not in (None, "completed"):
        diagnostics = safe_response_diagnostics(
            envelope, code=classify_response_failure(envelope)
        )
        raise _format_response_contract_failure(
            diagnostics,
            diagnostics["code"],
            "OpenClaw Responses request ended with a non-completed status",
        )
    try:
        return extract_json_object_from_envelope(envelope)
    except OpenClawContractError as exc:
        diagnostics = safe_response_diagnostics(
            envelope, code=classify_response_failure(envelope)
        )
        raise _format_response_contract_failure(
            diagnostics,
            diagnostics["code"],
            "OpenClaw Responses output contract failed",
        ) from exc


def _image_seed_failure_code(exc: Exception) -> str:
    detail = str(exc).lower()
    if "pageplan" in detail or "schema_version" in detail or "text block" in detail:
        return OPENCLAW_RESPONSES_PAGEPLAN_INVALID
    if any(
        marker in detail
        for marker in ("aligned", "hotspot", "bbox", "confidence", "parity")
    ):
        return OPENCLAW_RESPONSES_ALIGNMENT_INVALID
    return OPENCLAW_RESPONSES_JSON_SCHEMA_INVALID


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
        self._last_response_diagnostics: dict[str, Any] | None = None

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
        stage: Literal["responses", "image"] | None = None,
        usage_kind: usage.ProviderCall | None = None,
        timeout: float,
    ) -> httpx.Response:
        async with _semaphore():
            if stage is not None:
                _before_stage(stage)
            request_headers = headers if headers is not None else _headers()
            if usage_kind is not None:
                usage.record_provider_call(usage_kind)
            if self._http_client is not None:
                return await self._http_client.request(
                    method,
                    f"{base_url()}{path}",
                    headers=request_headers,
                    json=json_body,
                    params=params,
                    timeout=timeout,
                )
            async with httpx.AsyncClient(timeout=timeout) as client:
                return await client.request(
                    method,
                    f"{base_url()}{path}",
                    headers=request_headers,
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
        headers: dict[str, str] | None = None,
        stage: Literal["responses", "image"] | None = None,
        usage_kind: usage.ProviderCall | None = None,
        timeout: float,
    ) -> dict[str, Any]:
        try:
            response = await self._request(
                method,
                path,
                json_body=json_body,
                headers=headers,
                stage=stage,
                usage_kind=usage_kind,
                timeout=timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPError as exc:
            raise _http_failure("OpenClaw Gateway HTTP request failed", exc) from exc
        except ValueError as exc:
            raise OpenClawGatewayError(
                "OpenClaw Gateway returned invalid JSON", transient=True
            ) from exc
        if not isinstance(payload, dict):
            raise OpenClawGatewayError(
                "OpenClaw Gateway returned a non-object JSON payload", transient=True
            )
        return payload

    async def responses_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        image_data_url: str | None = None,
        max_output_tokens: int = 1800,
        usage_kind: usage.ProviderCall = "planner",
    ) -> dict[str, Any]:
        user_content: list[dict[str, Any]] = [
            {"type": "input_text", "text": user_prompt},
        ]
        if image_data_url is not None:
            user_content.append(_image_input(image_data_url))
        key = _BREAKER_KEYS["responses"]
        try:
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
                stage="responses",
                usage_kind=usage_kind,
                timeout=request_timeout_s(),
            )
            # Retain only the safe summary for the immediate contract validator;
            # the raw Responses envelope remains local to this call.
            self._last_response_diagnostics = safe_response_diagnostics(payload)
            result = _response_text(payload)
        except asyncio.CancelledError:
            raise
        except OpenClawGatewayError as exc:
            _record_stage_failure(key, exc)
            raise
        breaker.record_success(key)
        return result

    async def authenticated_health(self) -> dict[str, Any]:
        """Non-generating authenticated Gateway preflight."""

        try:
            response = await self._request(
                "GET", "/health", timeout=request_timeout_s()
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPError as exc:
            raise _http_failure("OpenClaw Gateway health preflight failed", exc) from exc
        except ValueError as exc:
            raise OpenClawGatewayError("OpenClaw Gateway health preflight failed") from exc
        if not isinstance(payload, dict):
            raise OpenClawGatewayError("OpenClaw Gateway health payload was not an object")
        return payload

    async def page_plan(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        grounded_sources: list[Any] | None = None,
    ) -> dict[str, Any]:
        try:
            raw = await self.responses_json(system_prompt, user_prompt)
            if grounded_sources is not None:
                # Source metadata is server-owned.  Inject it before validation so
                # a model that returns only local ids/URLs cannot fail the request
                # by omitting canonical title/snippet fields.
                from providers.grounded_contract import inject_canonical_sources

                raw = inject_canonical_sources(raw, grounded_sources)
            return validate_page_plan_minimal(raw)
        except OpenClawContractError as exc:
            raise _format_validation_contract_failure(
                exc,
                OPENCLAW_RESPONSES_PAGEPLAN_INVALID,
                "OpenClaw PagePlan validation failed",
            ) from exc
        finally:
            self._last_response_diagnostics = None

    async def image_seed(
        self,
        image_data_url: str,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Extract a seed contract and align it in the same vision response.

        B3 deliberately keeps this as one Responses request.  Tap regions are
        derived locally after validation, so a seed never calls the separate
        alignment route or an image-generation tool.
        """

        system = (
            "You are a machine-output vision compiler for OpenFlipbook. Analyze "
            "only the supplied existing source image and return exactly ONE JSON "
            "object. The first character must be { and the last character must "
            "be }. Output JSON only: no markdown, code fence, prose, explanation, "
            "reasoning, comments, or extra top-level keys. Do not call tools and "
            "do not generate or edit an image. Replace every angle-bracket "
            "placeholder in the contract skeleton with an actual value. Use this "
            "exact canonical PagePlan skeleton and field names:\n"
            '{\n'
            '  "page_plan": {\n'
            '    "schema_version": "1.0",\n'
            '    "title": "<non-empty title>",\n'
            '    "summary": "<non-empty summary>",\n'
            '    "scene": {\n'
            '      "prompt": "<visual description that explicitly says no text>",\n'
            '      "style": "clean illustrated textbook",\n'
            '      "aspect_ratio": "16:9"\n'
            "    },\n"
            '    "text_blocks": [\n'
            '      {"id": "t001", "role": "title", "text": "<DOM title>", '
            '"anchor": "top", "source_ids": []},\n'
            '      {"id": "t002", "role": "body", "text": "<DOM body>", '
            '"anchor": "bottom", "source_ids": []}\n'
            "    ],\n"
            '    "hotspots": [\n'
            '      {"id": "h001", "label": "<short label>", '
            '"sub_query": "<next exploration query>", '
            '"visual_target": "<object or region description>", '
            '"desired_bbox": [0.10, 0.10, 0.20, 0.20]},\n'
            '      {"id": "h002", "label": "<short label>", '
            '"sub_query": "<next exploration query>", '
            '"visual_target": "<object or region description>", '
            '"desired_bbox": [0.40, 0.40, 0.20, 0.20]}\n'
            "    ],\n"
            '    "motion_hints": [],\n'
            '    "sources": []\n'
            "  },\n"
            '  "aligned_hotspots": [\n'
            '    {"id": "h001", "actual_bbox": [0.10, 0.10, 0.20, 0.20], '
            '"alignment_confidence": 0.95},\n'
            '    {"id": "h002", "actual_bbox": [0.40, 0.40, 0.20, 0.20], '
            '"alignment_confidence": 0.95}\n'
            "  ]\n"
            "}\n"
            "Use TextBlock IDs t001, t002, ... matching ^t[0-9]{3,}$ and use "
            "anchor for TextBlock placement. Do not emit bbox inside text_blocks. "
            "Use 2 to 8 hotspots with IDs h001, h002, ...; every planned hotspot "
            "must have label, sub_query, visual_target, and desired_bbox. Every "
            "aligned_hotspots row must have id, actual_bbox, and "
            "alignment_confidence, and aligned IDs must exactly equal PagePlan "
            "hotspot IDs. Coordinates are normalized positive bboxes contained in "
            "0..1. For this B3 closure motion_hints must be [] and sources must be "
            "[]. Explicitly forbid MotionHint fields target_id and hint; do not "
            "emit tap_region because the application derives it locally. The scene "
            "prompt must describe the supplied image and explicitly contain the "
            "words 'no text'. The image must not contain empty label boxes, "
            "decorative callout frames, legends, text placeholders, blank "
            "annotation rectangles, or connector-label placeholders because the "
            "DOM owns labels. "
            "Return the single object now."
        )
        user = (
            "Analyze this exact existing image as an OpenFlipbook image seed. "
            "Preserve its subject and visual language in scene.prompt, identify "
            "2 to 8 useful visible regions for later tap exploration, and emit "
            "only the strict JSON object required above."
        )
        try:
            raw = await self.responses_json(
                system,
                user,
                image_data_url=image_data_url,
                max_output_tokens=3000,
            )
            try:
                return normalize_image_seed_envelope(raw)
            except Exception as exc:  # Do not expose model-produced validation details.
                code = _image_seed_failure_code(exc)
                raise _format_validation_contract_failure(
                    exc,
                    code,
                    "OpenClaw image-seed output contract failed",
                ) from exc
        finally:
            self._last_response_diagnostics = None

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
            "Match each row to its own planned id using that row's visual_target and "
            "desired_bbox. Never swap ids, infer meaning from list order, or copy a "
            "neighbor's box. Align the actual depicted subject, not an empty label "
            "box, decorative callout frame, legend, blank annotation rectangle, or "
            "connector-label placeholder. Do not return prose, markdown, or any "
            "other keys."
        )
        user = (
            "Planned PagePlan hotspots:\n"
            f"{_json_for_prompt(hotspot_rows)}\n\n"
            f"Expected ids in this exact set: {_json_for_prompt(expected_ids)}\n\n"
            "For every id, use only its own visual_target and desired_bbox as the "
            "semantic reference. Preserve the id-to-subject mapping exactly."
        )
        try:
            raw = await self.responses_json(
                system,
                user,
                image_data_url=image_data_url,
                max_output_tokens=900,
                usage_kind="alignment",
            )
            return validate_alignment_minimal(raw, expected_ids)
        except OpenClawContractError as exc:
            raise _format_response_contract_failure(
                self._last_response_diagnostics,
                OPENCLAW_RESPONSES_ALIGNMENT_INVALID,
                "OpenClaw hotspot alignment failed",
            ) from exc
        finally:
            self._last_response_diagnostics = None

    async def image_generate(
        self,
        prompt: str,
        *,
        is_cancelled: Any = None,
    ) -> OpenClawImage:
        if is_cancelled is not None and is_cancelled():
            raise asyncio.CancelledError()
        key = _BREAKER_KEYS["image"]
        try:
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
                stage="image",
                usage_kind="image",
                timeout=image_timeout_s(),
            )
            if payload.get("ok") is not True:
                raise OpenClawGatewayError(
                    "OpenClaw image_generate tool failed", transient=True
                )
            result = payload.get("result")
            source = _source_candidates(result)
            if source:
                if is_cancelled is not None and is_cancelled():
                    raise asyncio.CancelledError()
                generated = await self._download_media(source[0])
            elif _task_present(result):
                generated = await self._poll_image_task(is_cancelled=is_cancelled)
            else:
                raise OpenClawGatewayError(
                    "OpenClaw image_generate returned no media or task",
                    transient=True,
                )
        except asyncio.CancelledError:
            raise
        except OpenClawGatewayError as exc:
            _record_stage_failure(key, exc)
            raise
        breaker.record_success(key)
        return generated

    async def _poll_image_task(self, *, is_cancelled: Any = None) -> OpenClawImage:
        deadline = asyncio.get_running_loop().time() + image_timeout_s()
        while True:
            if is_cancelled is not None and is_cancelled():
                # OpenClaw image_generate has no cancel action. Stop polling;
                # any provider-side background task is intentionally ignored.
                raise asyncio.CancelledError()
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
                raise OpenClawGatewayError(
                    "OpenClaw image_generate status failed", transient=True
                )
            result = payload.get("result")
            source = _source_candidates(result)
            if source:
                if is_cancelled is not None and is_cancelled():
                    raise asyncio.CancelledError()
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
                raise OpenClawGatewayError(
                    "OpenClaw image task completed without assistant media",
                    transient=True,
                )
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise OpenClawGatewayError(
                    "OpenClaw image task timed out", transient=True
                )
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
        except httpx.HTTPError as exc:
            raise _http_failure("OpenClaw assistant-media metadata failed", exc) from exc
        except ValueError as exc:
            raise OpenClawGatewayError(
                "OpenClaw assistant-media metadata failed", transient=True
            ) from exc
        if not isinstance(metadata, dict) or metadata.get("available") is not True:
            raise OpenClawGatewayError(
                "OpenClaw assistant media is unavailable", transient=True
            )
        ticket = metadata.get("mediaTicket")
        if not isinstance(ticket, str) or not ticket:
            raise OpenClawGatewayError(
                "OpenClaw assistant media ticket is missing", transient=True
            )

        media = await self._request(
            "GET",
            "/__openclaw__/assistant-media",
            params={"source": source, "mediaTicket": ticket},
            timeout=image_timeout_s(),
        )
        try:
            media.raise_for_status()
        except httpx.HTTPError as exc:
            raise _http_failure("OpenClaw assistant-media download failed", exc) from exc
        if not media.content:
            raise OpenClawGatewayError(
                "OpenClaw assistant-media download was empty", transient=True
            )
        mime_type = (media.headers.get("content-type") or "image/jpeg").split(";", 1)[0]
        if not mime_type.startswith("image/"):
            raise OpenClawGatewayError(
                "OpenClaw assistant-media response is not an image", transient=True
            )
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
