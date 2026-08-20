# ruff: noqa: RUF001

"""Deterministic Page Contract payload for MOCK_PROVIDERS only.

This keeps the complete DOM text + hitmap runtime testable without any
provider, OAuth, or live planner/alignment call. B0 owns live contract
generation and image alignment.
"""
from __future__ import annotations

from typing import Literal, cast

from contracts.page_contract import (
    AlignedHotspot,
    MotionHint,
    PagePlan,
    PlannedHotspot,
    SceneSpec,
    TextBlock,
)


def _steam_hotspots() -> list[tuple[str, str, str, tuple[float, float, float, float]]]:
    return [
        ("鍋爐", "鍋爐如何產生並控制蒸汽？", "boiler on the left", (0.04, 0.16, 0.28, 0.68)),
        ("汽缸與活塞", "活塞如何把蒸汽壓力轉成往復運動？", "central piston and cylinder", (0.34, 0.2, 0.26, 0.58)),
        ("連桿與曲柄", "連桿與曲柄如何把往復運動轉成旋轉？", "connecting rod and crank", (0.58, 0.25, 0.18, 0.48)),
        ("飛輪", "飛輪為什麼能讓蒸汽機運轉更平順？", "large flywheel on the right", (0.76, 0.16, 0.2, 0.68)),
    ]


def _generic_hotspots(query: str) -> list[tuple[str, str, str, tuple[float, float, float, float]]]:
    topic = (query or "這個主題").strip()[:80]
    return [
        ("核心結構", f"{topic}有哪些核心結構？", "main structure in the upper-left", (0.05, 0.08, 0.4, 0.38)),
        ("運作流程", f"{topic}是如何運作的？", "main process in the upper-right", (0.55, 0.08, 0.4, 0.38)),
        ("關鍵細節", f"{topic}有哪些值得深入看的細節？", "detail in the lower-left", (0.05, 0.54, 0.4, 0.38)),
        ("延伸背景", f"理解{topic}還需要哪些背景知識？", "context in the lower-right", (0.55, 0.54, 0.4, 0.38)),
    ]


def build_mock_contract_payload(query: str, page_title: str, aspect_ratio: str = "16:9") -> dict:
    contract_aspect_ratio = (
        cast(
            Literal["1:1", "4:3", "3:4", "16:9", "9:16"],
            aspect_ratio,
        )
        if aspect_ratio in {"1:1", "4:3", "3:4", "16:9", "9:16"}
        else "16:9"
    )
    rows = _steam_hotspots() if "steam" in query.lower() or "蒸汽" in query else _generic_hotspots(query)
    planned = [
        PlannedHotspot(
            id=f"h{i:03d}",
            label=label,
            sub_query=sub_query,
            visual_target=visual_target,
            desired_bbox=bbox,
        )
        for i, (label, sub_query, visual_target, bbox) in enumerate(rows, start=1)
    ]
    plan = PagePlan(
        title=page_title,
        summary=f"以互動圖解探索「{query.strip()[:80] or page_title}」。文字由 DOM 顯示。",
        scene=SceneSpec(
            prompt=f"Educational illustration of {query}, no text, no labels, no typography.",
            style="clean illustrated textbook",
            aspect_ratio=contract_aspect_ratio,
        ),
        text_blocks=[
            TextBlock(id="t001", role="title", text=page_title, anchor="top-left"),
            TextBlock(
                id="t002",
                role="body",
                text="點選圖中的知識區域可繼續深入探索。",
                anchor="bottom-left",
            ),
        ],
        hotspots=planned,
        motion_hints=[MotionHint(target_hotspot_id=None, effect="none", intensity=0.0)],
        sources=[],
    )

    # Vertical Voronoi-like bands cover the entire image, so every in-image
    # point has a deterministic hit and no click VLM is needed.
    aligned: list[AlignedHotspot] = []
    n = len(planned)
    for i, hotspot in enumerate(planned):
        x0 = i / n
        x1 = (i + 1) / n
        aligned.append(
            AlignedHotspot(
                id=hotspot.id,
                actual_bbox=hotspot.desired_bbox,
                tap_region=[(x0, 0.0), (x1, 0.0), (x1, 1.0), (x0, 1.0)],
                alignment_confidence=1.0,
            )
        )
    return {
        "page_plan": plan.model_dump(mode="json"),
        "aligned_hotspots": [hotspot.model_dump(mode="json") for hotspot in aligned],
    }
