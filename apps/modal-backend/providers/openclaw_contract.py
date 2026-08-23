from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from contracts.page_contract import PagePlan, RenderedPage


class OpenClawContractError(RuntimeError):
    """Raised when an OpenClaw envelope cannot become the current Page Contract."""


OPENCLAW_RESPONSES_STATUS_ERROR = "OPENCLAW_RESPONSES_STATUS_ERROR"
OPENCLAW_RESPONSES_NO_OUTPUT_TEXT = "OPENCLAW_RESPONSES_NO_OUTPUT_TEXT"
OPENCLAW_RESPONSES_TEXT_NOT_JSON = "OPENCLAW_RESPONSES_TEXT_NOT_JSON"
OPENCLAW_RESPONSES_POSSIBLY_TRUNCATED_JSON = "OPENCLAW_RESPONSES_POSSIBLY_TRUNCATED_JSON"
OPENCLAW_RESPONSES_JSON_SCHEMA_INVALID = "OPENCLAW_RESPONSES_JSON_SCHEMA_INVALID"
OPENCLAW_RESPONSES_PAGEPLAN_INVALID = "OPENCLAW_RESPONSES_PAGEPLAN_INVALID"
OPENCLAW_RESPONSES_ALIGNMENT_INVALID = "OPENCLAW_RESPONSES_ALIGNMENT_INVALID"


_REDACTED_MARKER = "<REDACTED>"
_SENSITIVE_MARKERS = (
    "authorization",
    "bearer ",
    "data:image",
    "password",
    "secret",
    "api_key",
    "api-key",
    "token",
    "base64",
)


def safe_validation_errors(exc: BaseException) -> list[dict[str, Any]]:
    """Return only Pydantic ``loc``/``type`` metadata from an exception chain."""

    current: BaseException | None = exc
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        errors = getattr(current, "errors", None)
        if callable(errors):
            try:
                raw_errors = errors(include_url=False)
            except TypeError:
                raw_errors = errors()
            if isinstance(raw_errors, list):
                safe: list[dict[str, Any]] = []
                for row in raw_errors:
                    if not isinstance(row, dict) or not isinstance(row.get("type"), str):
                        continue
                    loc = row.get("loc", ())
                    if isinstance(loc, (list, tuple)):
                        safe_loc = [
                            item
                            for item in loc
                            if isinstance(item, (str, int)) and not isinstance(item, bool)
                        ]
                    else:
                        safe_loc = []
                    safe.append({"loc": safe_loc, "type": row["type"]})
                return safe
        current = current.__cause__ or current.__context__
    return []


def _safe_response_marker(value: Any) -> str | None:
    """Return a bounded metadata marker without exposing free-form payloads."""
    if not isinstance(value, str):
        return None
    marker = value.strip()
    if not marker or len(marker) > 80 or any(ord(char) < 32 for char in marker):
        return None
    lowered = marker.lower()
    if any(sensitive in lowered for sensitive in _SENSITIVE_MARKERS):
        return _REDACTED_MARKER
    return marker


def _safe_key(value: Any) -> str:
    marker = _safe_response_marker(str(value))
    return marker if marker is not None else _REDACTED_MARKER


def _candidate_output_texts(node: Any) -> list[str]:
    """Collect candidate output text while retaining no text in diagnostics."""
    found: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            if key in {"output_text", "text"} and isinstance(value, str):
                found.append(value)
            elif key in {"content", "output", "message"}:
                found.extend(_candidate_output_texts(value))
    elif isinstance(node, list):
        for item in node:
            found.extend(_candidate_output_texts(item))
    return found


def _parse_json_object(text: str) -> bool:
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\s*```$", "", candidate).strip()
    try:
        return isinstance(json.loads(candidate), dict)
    except json.JSONDecodeError:
        pass
    start, end = candidate.find("{"), candidate.rfind("}")
    if 0 <= start < end:
        try:
            return isinstance(json.loads(candidate[start : end + 1]), dict)
        except json.JSONDecodeError:
            return False
    return False


def _numeric_usage(envelope: dict[str, Any]) -> dict[str, int]:
    usage = envelope.get("usage")
    if not isinstance(usage, dict):
        return {}
    normalized: dict[str, int] = {}
    for source, target in (
        ("input_tokens", "input_tokens"),
        ("prompt_tokens", "input_tokens"),
        ("output_tokens", "output_tokens"),
        ("completion_tokens", "output_tokens"),
    ):
        value = usage.get(source)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            normalized.setdefault(target, value)
    return normalized


def _output_shape(envelope: dict[str, Any]) -> tuple[list[str], list[str], int]:
    output = envelope.get("output")
    if not isinstance(output, list):
        return [], [], 0
    item_types: list[str] = []
    content_types: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        item_type = _safe_response_marker(item.get("type"))
        if item_type is not None:
            item_types.append(item_type)
        content = item.get("content")
        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                content_type = _safe_response_marker(part.get("type"))
                if content_type is not None:
                    content_types.append(content_type)
    return item_types, content_types, len(output)


def _safe_error_metadata(value: Any) -> dict[str, str]:
    if isinstance(value, str):
        reason = _safe_response_marker(value)
        return {"reason": reason} if reason is not None else {}
    if not isinstance(value, dict):
        return {}
    result: dict[str, str] = {}
    for key in ("type", "code", "reason"):
        marker = _safe_response_marker(value.get(key))
        if marker is not None:
            result[key] = marker
    return result


def classify_response_failure(envelope: dict[str, Any]) -> str:
    """Classify a Responses envelope without retaining model-produced text."""
    status = envelope.get("status")
    if status not in (None, "completed"):
        return OPENCLAW_RESPONSES_STATUS_ERROR
    texts = _candidate_output_texts(envelope)
    if not texts:
        return OPENCLAW_RESPONSES_NO_OUTPUT_TEXT
    if any(_parse_json_object(text) for text in texts):
        return OPENCLAW_RESPONSES_JSON_SCHEMA_INVALID
    stripped = [text.strip() for text in texts if text.strip()]
    if any(text.startswith("{") and not text.endswith("}") for text in stripped):
        return OPENCLAW_RESPONSES_POSSIBLY_TRUNCATED_JSON
    return OPENCLAW_RESPONSES_TEXT_NOT_JSON


def safe_response_diagnostics(
    envelope: dict[str, Any], *, code: str | None = None
) -> dict[str, Any]:
    """Return only bounded response metadata and hashes; never raw output text."""
    texts = _candidate_output_texts(envelope)
    item_types, content_types, output_count = _output_shape(envelope)
    candidates = []
    for raw in texts:
        stripped = raw.strip()
        candidates.append(
            {
                "length": len(raw),
                "sha256": hashlib.sha256(
                    raw.encode("utf-8", errors="replace")
                ).hexdigest(),
                "starts_with_object": stripped.startswith("{"),
                "ends_with_object": stripped.endswith("}"),
                "parseable_json_object": _parse_json_object(raw),
            }
        )
    status = _safe_response_marker(envelope.get("status"))
    response_id = _safe_response_marker(envelope.get("id"))
    incomplete = _safe_error_metadata(envelope.get("incomplete_details"))
    error = _safe_error_metadata(envelope.get("error"))
    return {
        "code": code or classify_response_failure(envelope),
        "response_status": status,
        "response_id": response_id,
        "top_level_keys": sorted(_safe_key(key) for key in envelope),
        "output_item_count": output_count,
        "output_item_types": item_types,
        "content_part_types": content_types,
        "candidate_text_count": len(texts),
        "candidate_texts": candidates,
        "usage": _numeric_usage(envelope),
        "incomplete": incomplete,
        "error": error,
        # Keep the reference names available to callers while remaining safe.
        "incomplete_reason": incomplete.get("reason"),
        "error_meta": error,
        "raw_text_saved": False,
        "raw_envelope_saved": False,
    }


def _walk_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, dict):
        for key in ("output_text", "text", "response", "content", "message"):
            if key in value:
                yield from _walk_strings(value[key])
        for key, child in value.items():
            if key not in {"output_text", "text", "response", "content", "message"}:
                yield from _walk_strings(child)
        return
    if isinstance(value, list):
        for item in value:
            yield from _walk_strings(item)


def extract_json_object_from_envelope(envelope: dict[str, Any]) -> dict[str, Any]:
    """Extract a model-produced JSON object from an ``infer --json`` envelope."""
    for raw in _walk_strings(envelope):
        text = raw.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
            text = re.sub(r"\s*```$", "", text)
        try:
            value = json.loads(text)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            pass

        start, end = text.find("{"), text.rfind("}")
        if 0 <= start < end:
            try:
                value = json.loads(text[start : end + 1])
                if isinstance(value, dict):
                    return value
            except json.JSONDecodeError:
                pass
    raise OpenClawContractError("no JSON object found in infer envelope")


def image_output_path(envelope: dict[str, Any]) -> Path:
    outputs = envelope.get("outputs")
    if not isinstance(outputs, list):
        raise OpenClawContractError("infer image envelope has no outputs list")
    for item in outputs:
        if isinstance(item, dict):
            raw = item.get("path") or item.get("filePath") or item.get("file_path")
            if isinstance(raw, str) and raw.strip():
                return Path(raw)
    raise OpenClawContractError("infer image envelope has no output path")


def assert_provider_model(
    envelope: dict[str, Any], *, provider: str, model_contains: str
) -> None:
    if envelope.get("ok") is not True:
        raise OpenClawContractError(f"infer call not ok: {envelope.get('error')!r}")
    actual_provider = str(envelope.get("provider") or "").lower()
    actual_model = str(envelope.get("model") or "").lower()
    if actual_provider != provider.lower():
        raise OpenClawContractError(
            f"provider mismatch: expected {provider!r}, got {actual_provider!r}"
        )
    if model_contains.lower() not in actual_model:
        raise OpenClawContractError(
            f"model mismatch: expected containing {model_contains!r}, got {actual_model!r}"
        )


def _num(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise OpenClawContractError(f"{name} must be numeric")
    result = float(value)
    if not math.isfinite(result) or not 0.0 <= result <= 1.0:
        raise OpenClawContractError(f"{name} must be within 0..1")
    return result


def _bbox(value: Any, name: str) -> tuple[float, float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise OpenClawContractError(f"{name} must contain four normalized values")
    x, y, width, height = (
        _num(item, f"{name}[{index}]") for index, item in enumerate(value)
    )
    result = (x, y, width, height)
    if width <= 0 or height <= 0 or x + width > 1.0 or y + height > 1.0:
        raise OpenClawContractError(f"{name} must be positive and contained in 0..1")
    return result


def validate_page_plan_minimal(plan: dict[str, Any]) -> dict[str, Any]:
    """Apply B0 cardinality rules and then validate the repo's PagePlan model."""
    # The prepared flipbook route may wrap the PagePlan object once under its
    # protocol key.  Unwrap only that known equivalent shape; core PagePlan
    # validation remains strict below.
    wrapped = plan.get("page_plan")
    if "schema_version" not in plan and isinstance(wrapped, dict):
        plan = wrapped
    if plan.get("schema_version") != "1.0":
        raise OpenClawContractError("PagePlan schema_version must be 1.0")
    # The prepared flipbook agent sometimes emits the same text-block data
    # with its native aliases (content/position/headline). Normalize only
    # those observed aliases, then keep the strict PagePlan validation below.
    text_blocks = plan.get("text_blocks")
    if isinstance(text_blocks, list):
        normalized_blocks: list[Any] = []
        for row in text_blocks:
            if not isinstance(row, dict):
                normalized_blocks.append(row)
                continue
            normalized = dict(row)
            if "text" not in normalized and isinstance(normalized.get("content"), str):
                normalized["text"] = normalized["content"]
            if normalized.get("role") == "headline":
                normalized["role"] = "title"
            if "anchor" not in normalized and isinstance(normalized.get("position"), str):
                anchor = normalized["position"].strip().lower().replace("_", "-")
                normalized["anchor"] = {
                    "top-center": "top",
                    "bottom-center": "bottom",
                }.get(anchor, anchor)
            normalized_blocks.append(normalized)
        plan = {**plan, "text_blocks": normalized_blocks}
    # Motion hints are optional presentation metadata.  The prepared flipbook
    # agent has emitted native ``type/target/description`` flow hints in this
    # slot; discard rows that are not PagePlan v1 hints so they cannot block a
    # usable grounded page before image generation.
    motion_hints = plan.get("motion_hints")
    if isinstance(motion_hints, list):
        valid_effects = {
            "none",
            "pulse",
            "drift-up",
            "rotate",
            "parallax",
            "ken-burns",
            "glow",
        }
        normalized_hints = [
            row
            for row in motion_hints
            if isinstance(row, dict) and row.get("effect") in valid_effects
        ]
        if len(normalized_hints) != len(motion_hints):
            plan = {**plan, "motion_hints": normalized_hints}
    try:
        validated = PagePlan.model_validate(plan)
    except ValidationError as exc:
        raise OpenClawContractError(f"PagePlan contract validation failed: {exc}") from exc

    if validated.scene.aspect_ratio != "16:9":
        raise OpenClawContractError("PagePlan scene/aspect_ratio must be 16:9")
    if "no text" not in validated.scene.prompt.lower():
        raise OpenClawContractError("scene prompt must explicitly contain 'no text'")
    if len(validated.text_blocks) != 2:
        raise OpenClawContractError("B0 PagePlan must contain exactly 2 text blocks")
    if len(validated.hotspots) != 3:
        raise OpenClawContractError("B0 PagePlan must contain exactly 3 hotspots")
    return validated.model_dump(mode="json")


@dataclass(frozen=True)
class AlignedBox:
    id: str
    bbox: tuple[float, float, float, float]
    confidence: float


def validate_alignment_minimal(
    payload: dict[str, Any], expected_ids: list[str]
) -> list[AlignedBox]:
    rows = payload.get("hotspots")
    if not isinstance(rows, list) or len(rows) != len(expected_ids):
        raise OpenClawContractError("alignment hotspot count mismatch")

    seen: set[str] = set()
    result: list[AlignedBox] = []
    for row in rows:
        if not isinstance(row, dict):
            raise OpenClawContractError("alignment row must be object")
        hotspot_id = str(row.get("id") or "")
        if hotspot_id not in expected_ids or hotspot_id in seen:
            raise OpenClawContractError(f"unexpected/duplicate alignment id {hotspot_id!r}")
        seen.add(hotspot_id)
        bbox = _bbox(row.get("bbox"), f"{hotspot_id}.bbox")
        confidence = _num(row.get("confidence"), f"{hotspot_id}.confidence")
        result.append(AlignedBox(hotspot_id, bbox, confidence))

    if seen != set(expected_ids):
        raise OpenClawContractError("alignment ids do not match PagePlan")
    by_id = {row.id: row for row in result}
    return [by_id[hotspot_id] for hotspot_id in expected_ids]


def _expanded_rect_polygon(
    bbox: tuple[float, float, float, float], pad: float = 0.035
) -> list[list[float]]:
    x, y, width, height = bbox
    x0 = max(0.0, x - pad)
    y0 = max(0.0, y - pad)
    x1 = min(1.0, x + width + pad)
    y1 = min(1.0, y + height + pad)
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def build_rendered_page(
    page_plan: dict[str, Any],
    aligned: list[AlignedBox],
    *,
    image_path: str,
    image_width: int,
    image_height: int,
    image_provider: str,
    image_model: str,
    planner_model: str,
    aligner_model: str,
    node_id: str = "b0_openclaw_steam_engine",
) -> dict[str, Any]:
    """Normalize B0 outputs into the current repo RenderedPage shape."""
    try:
        validated_plan = PagePlan.model_validate(page_plan)
    except ValidationError as exc:
        raise OpenClawContractError(f"PagePlan contract validation failed: {exc}") from exc

    planned = validated_plan.model_dump(mode="json")
    expected_ids = [hotspot["id"] for hotspot in planned["hotspots"]]
    by_id = {row.id: row for row in aligned}
    if set(by_id) != set(expected_ids):
        raise OpenClawContractError("aligned hotspot ids do not match PagePlan")

    rendered_hotspots: list[dict[str, Any]] = []
    for hotspot in planned["hotspots"]:
        row = by_id[hotspot["id"]]
        rendered_hotspots.append(
            {
                "id": row.id,
                "actual_bbox": list(row.bbox),
                "tap_region": _expanded_rect_polygon(row.bbox),
                "alignment_confidence": row.confidence,
            }
        )

    candidate = {
        "schema_version": "1.0",
        "node_id": node_id,
        "page_plan": planned,
        "image": {
            "asset_key": image_path,
            "width": image_width,
            "height": image_height,
            "provider": image_provider,
            "model": image_model,
        },
        "hotspots": rendered_hotspots,
        "planner_model": planner_model,
        "aligner_model": aligner_model,
    }
    try:
        validated = RenderedPage.model_validate(candidate)
    except ValidationError as exc:
        raise OpenClawContractError(f"RenderedPage contract validation failed: {exc}") from exc
    payload = validated.model_dump(mode="json")
    payload["planner_model"] = planner_model
    payload["aligner_model"] = aligner_model
    return payload


def _point_on_segment(
    x: float,
    y: float,
    ax: float,
    ay: float,
    bx: float,
    by: float,
) -> bool:
    epsilon = 1e-9
    cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax)
    if abs(cross) > epsilon:
        return False
    dot = (x - ax) * (bx - ax) + (y - ay) * (by - ay)
    if dot < -epsilon:
        return False
    length_squared = (bx - ax) ** 2 + (by - ay) ** 2
    return dot <= length_squared + epsilon


def _point_in_polygon(x: float, y: float, polygon: list[list[float]]) -> bool:
    if len(polygon) < 3:
        return False
    inside = False
    for index, (xi, yi) in enumerate(polygon):
        xj, yj = polygon[index - 1]
        if _point_on_segment(x, y, xi, yi, xj, yj):
            return True
        crosses = (yi > y) != (yj > y)
        if crosses:
            x_at_y = ((xj - xi) * (y - yi)) / (yj - yi) + xi
            if x < x_at_y:
                inside = not inside
    return inside


def _bbox_contains(bbox: list[float], x: float, y: float) -> bool:
    bx, by, width, height = bbox
    epsilon = 1e-9
    return (
        x + epsilon >= bx
        and y + epsilon >= by
        and x <= bx + width + epsilon
        and y <= by + height + epsilon
    )


def resolve_hotspot_center(rendered_page: dict[str, Any], x: float, y: float) -> tuple[str, str]:
    """Mirror the existing deterministic tap resolver's region/bbox fallback."""
    rows = rendered_page["hotspots"]
    regions = [row for row in rows if _point_in_polygon(x, y, row["tap_region"])]
    if regions:
        row = sorted(regions, key=lambda item: (-item["alignment_confidence"], item["id"]))[0]
        return row["id"], "tap_region"

    bboxes = [row for row in rows if _bbox_contains(row["actual_bbox"], x, y)]
    if bboxes:
        row = sorted(bboxes, key=lambda item: (-item["alignment_confidence"], item["id"]))[0]
        return row["id"], "bbox"

    if not rows:
        raise OpenClawContractError("RenderedPage has no hotspots to resolve")
    row = min(
        rows,
        key=lambda item: (
            (x - (item["actual_bbox"][0] + item["actual_bbox"][2] / 2)) ** 2
            + (y - (item["actual_bbox"][1] + item["actual_bbox"][3] / 2)) ** 2,
            -item["alignment_confidence"],
            item["id"],
        ),
    )
    return row["id"], "nearest"


def check_center_resolver(rendered_page: dict[str, Any]) -> dict[str, Any]:
    """Confirm that every aligned bbox center resolves without another model call."""
    centers: dict[str, dict[str, Any]] = {}
    for row in rendered_page["hotspots"]:
        x, y, width, height = row["actual_bbox"]
        resolved_id, method = resolve_hotspot_center(
            rendered_page, x + width / 2, y + height / 2
        )
        centers[row["id"]] = {"resolved_id": resolved_id, "method": method}
    return {"ok": True, "centers": centers}
