from contracts.mock_page_contract import build_mock_contract_payload


def test_mock_contract_is_complete_and_dom_text_only():
    payload = build_mock_contract_payload("steam engine", "Steam engine")
    plan = payload["page_plan"]
    assert len(plan["hotspots"]) == 4
    assert len(payload["aligned_hotspots"]) == 4
    assert {h["id"] for h in plan["hotspots"]} == {
        h["id"] for h in payload["aligned_hotspots"]
    }
    prompt = plan["scene"]["prompt"].lower()
    assert "no text" in prompt and "no labels" in prompt
    assert plan["text_blocks"][0]["text"] == "Steam engine"


def test_mock_tap_regions_cover_full_width():
    payload = build_mock_contract_payload("steam engine", "Steam engine")
    regions = [h["tap_region"] for h in payload["aligned_hotspots"]]
    assert regions[0][0] == [0.0, 0.0]
    assert regions[-1][1] == [1.0, 0.0]
