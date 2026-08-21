from __future__ import annotations

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
    if plan.get("schema_version") != "1.0":
        raise OpenClawContractError("PagePlan schema_version must be 1.0")
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
