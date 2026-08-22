import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from contracts.page_contract import RenderedPage
from providers.openclaw_contract import (
    OpenClawContractError,
    assert_provider_model,
    build_rendered_page,
    check_center_resolver,
    extract_json_object_from_envelope,
    image_output_path,
    validate_alignment_minimal,
    validate_page_plan_minimal,
)

PLAN = {
    "schema_version": "1.0",
    "title": "蒸汽機如何運作",
    "summary": "fixture",
    "scene": {
        "prompt": "Educational steam engine cutaway, no text, no labels",
        "style": "textbook",
        "aspect_ratio": "16:9",
    },
    "text_blocks": [
        {"id": "t001", "role": "title", "text": "蒸汽機如何運作", "anchor": "top-left"},
        {"id": "t002", "role": "body", "text": "蒸汽推動活塞。", "anchor": "bottom-left"},
    ],
    "hotspots": [
        {
            "id": "h001",
            "label": "鍋爐",
            "sub_query": "鍋爐構造",
            "visual_target": "boiler",
            "desired_bbox": [0.05, 0.2, 0.25, 0.5],
        },
        {
            "id": "h002",
            "label": "汽缸",
            "sub_query": "汽缸結構",
            "visual_target": "cylinder",
            "desired_bbox": [0.35, 0.2, 0.25, 0.5],
        },
        {
            "id": "h003",
            "label": "飛輪",
            "sub_query": "飛輪結構",
            "visual_target": "flywheel",
            "desired_bbox": [0.68, 0.2, 0.25, 0.5],
        },
    ],
    "motion_hints": [],
    "sources": [],
}


def test_extracts_json_from_nested_envelope() -> None:
    envelope = {
        "ok": True,
        "outputs": [{"text": "```json\n" + json.dumps(PLAN, ensure_ascii=False) + "\n```"}],
    }
    assert extract_json_object_from_envelope(envelope)["title"] == "蒸汽機如何運作"


def test_provider_model_guard() -> None:
    assert_provider_model(
        {"ok": True, "provider": "openai", "model": "gpt-5.4-mini"},
        provider="openai",
        model_contains="gpt-5.4-mini",
    )
    with pytest.raises(OpenClawContractError):
        assert_provider_model(
            {"ok": True, "provider": "other", "model": "gpt-5.4-mini"},
            provider="openai",
            model_contains="gpt-5.4-mini",
        )


def test_image_path() -> None:
    assert image_output_path({"outputs": [{"path": "/tmp/page.png"}]}) == Path("/tmp/page.png")


def test_plan_alignment_and_current_rendered_page_contract() -> None:
    plan = validate_page_plan_minimal(PLAN)
    alignment = {
        "hotspots": [
            {"id": "h003", "bbox": [0.68, 0.2, 0.25, 0.5], "confidence": 0.8},
            {"id": "h001", "bbox": [0.05, 0.2, 0.25, 0.5], "confidence": 0.9},
            {"id": "h002", "bbox": [0.35, 0.2, 0.25, 0.5], "confidence": 0.85},
        ]
    }
    rows = validate_alignment_minimal(alignment, ["h001", "h002", "h003"])
    rendered = build_rendered_page(
        plan,
        rows,
        image_path="/tmp/page.png",
        image_width=1536,
        image_height=1024,
        image_provider="openai",
        image_model="openai/gpt-image-2",
        planner_model="openai/gpt-5.4-mini",
        aligner_model="openai/gpt-5.4-mini",
    )
    RenderedPage.model_validate(rendered)
    assert [hotspot["id"] for hotspot in rendered["hotspots"]] == ["h001", "h002", "h003"]
    resolver = check_center_resolver(rendered)
    assert resolver["ok"] is True
    assert all(row["resolved_id"] for row in resolver["centers"].values())


def test_normalizes_flipbook_text_block_aliases() -> None:
    aliased = json.loads(json.dumps(PLAN))
    aliased["text_blocks"] = [
        {"id": "t001", "role": "headline", "content": "蒸汽機如何運作", "position": "top_left"},
        {"id": "t002", "role": "caption", "content": "蒸汽推動活塞。", "position": "bottom_center"},
    ]
    normalized = validate_page_plan_minimal(aliased)
    assert normalized["text_blocks"] == [
        {
            "id": "t001",
            "role": "title",
            "text": "蒸汽機如何運作",
            "anchor": "top-left",
            "source_ids": [],
        },
        {
            "id": "t002",
            "role": "caption",
            "text": "蒸汽推動活塞。",
            "anchor": "bottom",
            "source_ids": [],
        },
    ]


def test_normalizes_page_plan_wrapper_before_strict_validation() -> None:
    wrapped = {"page_plan": json.loads(json.dumps(PLAN))}
    normalized = validate_page_plan_minimal(wrapped)
    assert normalized["schema_version"] == "1.0"
    assert normalized["title"] == PLAN["title"]


def test_rejects_out_of_range_bbox() -> None:
    bad = json.loads(json.dumps(PLAN))
    bad["hotspots"][0]["desired_bbox"][0] = 1.2
    with pytest.raises((OpenClawContractError, ValidationError)):
        validate_page_plan_minimal(bad)
