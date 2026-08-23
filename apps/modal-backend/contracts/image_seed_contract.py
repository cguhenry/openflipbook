"""B3 contract for turning an existing image into an interactive root page."""

from __future__ import annotations

import math
from typing import Any

from pydantic import ValidationError

from contracts.page_contract import PagePlan


class ImageSeedContractError(ValueError):
    """Raised when the one-call image-seed envelope is not safe to persist."""


def derive_tap_region(
    bbox: list[float] | tuple[float, float, float, float], pad: float = 0.03
) -> list[list[float]]:
    """Derive the local rectangular tap region; the model never supplies it."""

    x, y, width, height = (float(value) for value in bbox)
    x0, y0 = max(0.0, x - pad), max(0.0, y - pad)
    x1, y1 = min(1.0, x + width + pad), min(1.0, y + height + pad)
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


def _bbox(value: Any, label: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ImageSeedContractError(f"{label} bbox must have four values")
    result = [float(item) for item in value]
    if not all(math.isfinite(item) and 0.0 <= item <= 1.0 for item in result):
        raise ImageSeedContractError(f"{label} bbox is not normalized")
    x, y, width, height = result
    if width <= 0.0 or height <= 0.0 or x + width > 1.0 or y + height > 1.0:
        raise ImageSeedContractError(f"{label} bbox is invalid")
    return result


def normalize_image_seed_envelope(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Validate the one-call envelope and derive all client hit polygons."""

    if not isinstance(payload, dict):
        raise ImageSeedContractError("image-seed response must be an object")
    raw_plan = payload.get("page_plan")
    raw_aligned = payload.get("aligned_hotspots")
    if not isinstance(raw_plan, dict) or raw_plan.get("schema_version") != "1.0":
        raise ImageSeedContractError("PagePlan schema_version must be 1.0")
    if not isinstance(raw_aligned, list):
        raise ImageSeedContractError("image seed is missing aligned_hotspots")

    try:
        plan = PagePlan.model_validate(raw_plan)
    except ValidationError as exc:
        raise ImageSeedContractError(f"PagePlan validation failed: {exc}") from exc
    if not 1 <= len(plan.text_blocks) <= 4:
        raise ImageSeedContractError("image seed requires 1..4 text blocks")
    if not 2 <= len(plan.hotspots) <= 8:
        raise ImageSeedContractError("image seed requires 2..8 hotspots")

    planned = plan.model_dump(mode="json")
    planned["sources"] = []
    for block in planned["text_blocks"]:
        # Source URLs and citations are not part of an image seed.  Grounded
        # descendants get their own citations later through the normal route.
        block["source_ids"] = []

    expected_ids = [str(row["id"]) for row in planned["hotspots"]]
    by_id: dict[str, dict[str, Any]] = {}
    for row in raw_aligned:
        if not isinstance(row, dict):
            raise ImageSeedContractError("aligned hotspot row must be an object")
        hotspot_id = str(row.get("id") or "")
        if hotspot_id not in expected_ids or hotspot_id in by_id:
            raise ImageSeedContractError(f"unexpected/duplicate aligned hotspot {hotspot_id!r}")
        bbox = _bbox(row.get("actual_bbox", row.get("bbox")), hotspot_id)
        raw_confidence = row.get("alignment_confidence", row.get("confidence"))
        if isinstance(raw_confidence, bool) or not isinstance(raw_confidence, (int, float)):
            raise ImageSeedContractError(f"{hotspot_id} confidence is invalid")
        confidence = float(raw_confidence)
        if not math.isfinite(confidence) or not 0.0 <= confidence <= 1.0:
            raise ImageSeedContractError(f"{hotspot_id} confidence is invalid")
        by_id[hotspot_id] = {
            "id": hotspot_id,
            "actual_bbox": bbox,
            "tap_region": derive_tap_region(bbox),
            "alignment_confidence": confidence,
        }
    if set(by_id) != set(expected_ids):
        raise ImageSeedContractError("planned/aligned hotspot ID parity mismatch")

    return planned, [by_id[hotspot_id] for hotspot_id in expected_ids]
