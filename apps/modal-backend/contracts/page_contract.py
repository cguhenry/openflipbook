from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

NormBBox = tuple[float, float, float, float]
NormPoint = tuple[float, float]


def _unit(v: float) -> float:
    if not 0.0 <= v <= 1.0:
        raise ValueError("normalized coordinates must be within 0..1")
    return v


class SourceRef(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=2000)
    snippet: str = Field(default="", max_length=1200)


class SceneSpec(BaseModel):
    prompt: str = Field(min_length=10, max_length=8000)
    style: str = Field(default="clean illustrated textbook", max_length=300)
    aspect_ratio: Literal["1:1", "4:3", "3:4", "16:9", "9:16"] = "4:3"

    @field_validator("prompt")
    @classmethod
    def forbid_text_rendering_request(cls, v: str) -> str:
        low = v.lower()
        if not any(token in low for token in ("no text", "without text", "no labels", "no typography")):
            raise ValueError("scene prompt must explicitly forbid rendered text/labels")
        return v


class TextBlock(BaseModel):
    id: str = Field(pattern=r"^t[0-9]{3,}$")
    role: Literal["title", "subtitle", "body", "callout", "caption", "source"] = "body"
    text: str = Field(min_length=1, max_length=3000)
    anchor: Literal[
        "top-left", "top", "top-right", "left", "center", "right",
        "bottom-left", "bottom", "bottom-right",
    ] = "top-left"


class PlannedHotspot(BaseModel):
    id: str = Field(pattern=r"^h[0-9]{3,}$")
    label: str = Field(min_length=1, max_length=80)
    sub_query: str = Field(min_length=3, max_length=500)
    visual_target: str = Field(min_length=3, max_length=500)
    desired_bbox: NormBBox

    @field_validator("desired_bbox")
    @classmethod
    def validate_bbox(cls, v: NormBBox) -> NormBBox:
        x, y, w, h = map(_unit, v)
        if w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
            raise ValueError("bbox must be positive and fully contained in 0..1 canvas")
        return (x, y, w, h)


class MotionHint(BaseModel):
    target_hotspot_id: str | None = Field(default=None, pattern=r"^h[0-9]{3,}$")
    effect: Literal["none", "pulse", "drift-up", "rotate", "parallax", "ken-burns", "glow"] = "none"
    intensity: float = Field(default=0.3, ge=0.0, le=1.0)


class PagePlan(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=2000)
    scene: SceneSpec
    text_blocks: list[TextBlock] = Field(default_factory=list, max_length=12)
    hotspots: list[PlannedHotspot] = Field(min_length=2, max_length=8)
    motion_hints: list[MotionHint] = Field(default_factory=list, max_length=12)
    sources: list[SourceRef] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def unique_ids(self) -> PagePlan:
        text_ids = [x.id for x in self.text_blocks]
        hot_ids = [x.id for x in self.hotspots]
        if len(text_ids) != len(set(text_ids)):
            raise ValueError("duplicate text block id")
        if len(hot_ids) != len(set(hot_ids)):
            raise ValueError("duplicate hotspot id")
        known = set(hot_ids)
        for motion in self.motion_hints:
            if motion.target_hotspot_id and motion.target_hotspot_id not in known:
                raise ValueError(f"motion target {motion.target_hotspot_id} does not exist")
        return self


class ImageAsset(BaseModel):
    asset_key: str = Field(min_length=1, max_length=1000)
    width: int = Field(gt=0, le=16384)
    height: int = Field(gt=0, le=16384)
    provider: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=160)


class AlignedHotspot(BaseModel):
    id: str = Field(pattern=r"^h[0-9]{3,}$")
    actual_bbox: NormBBox
    tap_region: list[NormPoint] = Field(min_length=3, max_length=64)
    alignment_confidence: float = Field(ge=0.0, le=1.0)

    @field_validator("actual_bbox")
    @classmethod
    def validate_bbox(cls, v: NormBBox) -> NormBBox:
        x, y, w, h = map(_unit, v)
        if w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
            raise ValueError("actual_bbox must be contained in 0..1 canvas")
        return (x, y, w, h)

    @field_validator("tap_region")
    @classmethod
    def validate_polygon(cls, v: list[NormPoint]) -> list[NormPoint]:
        return [(_unit(float(x)), _unit(float(y))) for x, y in v]


class RenderedPage(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    node_id: str = Field(min_length=1, max_length=200)
    page_plan: PagePlan
    image: ImageAsset
    hotspots: list[AlignedHotspot] = Field(min_length=2, max_length=8)

    @model_validator(mode="after")
    def aligned_hotspots_match_plan(self) -> RenderedPage:
        planned = {h.id for h in self.page_plan.hotspots}
        aligned = {h.id for h in self.hotspots}
        if planned != aligned:
            raise ValueError(
                f"aligned hotspot ids must exactly match plan: planned={planned}, aligned={aligned}"
            )
        return self
