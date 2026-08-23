from __future__ import annotations

import copy

import pytest

from contracts.image_seed_contract import (
    ImageSeedContractError,
    derive_tap_region,
    normalize_image_seed_envelope,
)
from contracts.mock_page_contract import build_mock_image_seed_payload


def test_image_seed_normalization_clears_sources_and_derives_local_tap_regions() -> None:
    payload = build_mock_image_seed_payload()
    payload["page_plan"]["sources"] = [
        {"id": "S1", "title": "model URL", "url": "https://model.invalid", "snippet": "ignore"}
    ]
    payload["page_plan"]["text_blocks"][0]["source_ids"] = ["S1"]
    payload["aligned_hotspots"][0]["tap_region"] = [[0.9, 0.9], [1, 1], [0.9, 1]]

    plan, aligned = normalize_image_seed_envelope(payload)

    assert plan["sources"] == []
    assert all(block["source_ids"] == [] for block in plan["text_blocks"])
    assert [row["id"] for row in aligned] == [hotspot["id"] for hotspot in plan["hotspots"]]
    bbox = aligned[0]["actual_bbox"]
    assert aligned[0]["tap_region"] == derive_tap_region(bbox)
    assert aligned[0]["tap_region"] != payload["aligned_hotspots"][0]["tap_region"]


def test_image_seed_requires_exact_planned_and_aligned_ids() -> None:
    payload = copy.deepcopy(build_mock_image_seed_payload())
    payload["aligned_hotspots"] = payload["aligned_hotspots"][:-1]

    with pytest.raises(ImageSeedContractError, match="parity"):
        normalize_image_seed_envelope(payload)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("actual_bbox", [0.9, 0.9, 0.2, 0.1]),
        ("actual_bbox", [0.1, 0.1, -0.1, 0.2]),
        ("alignment_confidence", 1.1),
    ],
)
def test_image_seed_rejects_invalid_alignment(field: str, value: object) -> None:
    payload = copy.deepcopy(build_mock_image_seed_payload())
    payload["aligned_hotspots"][0][field] = value

    with pytest.raises(ImageSeedContractError):
        normalize_image_seed_envelope(payload)
