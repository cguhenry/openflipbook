import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from contracts.page_contract import PagePlan, RenderedPage

FIXTURE = Path(__file__).parent / "fixtures" / "page_contract_v1.json"


def _payload() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_page_contract_fixture_validates() -> None:
    payload = _payload()
    PagePlan.model_validate(payload["page_plan"])
    RenderedPage.model_validate(payload["rendered_page"])


def test_scene_requires_no_text_instruction() -> None:
    payload = _payload()["page_plan"]
    payload["scene"]["prompt"] = "Educational cutaway illustration of a steam engine"
    with pytest.raises(ValidationError):
        PagePlan.model_validate(payload)


def test_planned_bbox_cannot_escape_canvas() -> None:
    payload = _payload()["page_plan"]
    payload["hotspots"][0]["desired_bbox"] = [0.9, 0.2, 0.2, 0.2]
    with pytest.raises(ValidationError):
        PagePlan.model_validate(payload)


def test_rendered_hotspot_ids_must_match_plan() -> None:
    payload = _payload()["rendered_page"]
    payload["hotspots"][1]["id"] = "h999"
    with pytest.raises(ValidationError):
        RenderedPage.model_validate(payload)
