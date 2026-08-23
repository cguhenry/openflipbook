"""Regression tests for zero-network /status behavior in mock mode."""

import json

import pytest

import obs
from providers import breaker, openclaw_runtime, usage


@pytest.mark.asyncio
async def test_status_payload_mock_mode_never_pings_provider(monkeypatch):
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    obs._provider_health_cache.clear()

    async def forbidden_ping(url: str) -> bool:
        raise AssertionError(f"mock /status attempted provider network: {url}")

    monkeypatch.setattr(obs, "_ping", forbidden_ping)
    payload = await obs.status_payload("test")

    assert payload["ok"] is True
    assert payload["provider_mode"] == "mock"
    assert payload["providers"] == {"fal": True, "openrouter": True}
    assert payload["planner_vision_model"] == "openai/gpt-5.6-luna"
    assert payload["image_model"] == "openai/gpt-image-2"
    assert payload["openclaw_connected"] is False
    assert payload["searxng_connected"] is False


@pytest.mark.asyncio
async def test_status_payload_is_safe_when_secret_like_env_values_exist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MOCK_PROVIDERS", "1")
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_BEARER_FILE", "/run/secrets/pw.txt")
    monkeypatch.setenv("OAUTH_TOKEN", "must-not-appear")
    payload = await obs.status_payload("test")
    serialized = json.dumps(payload)
    assert "pw.txt" not in serialized
    assert "must-not-appear" not in serialized
    assert "Authorization" not in serialized


@pytest.mark.asyncio
async def test_status_payload_live_mode_preserves_provider_checks(monkeypatch):
    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)
    obs._provider_health_cache.clear()
    calls: list[tuple[str, str]] = []

    async def fake_check(name: str, url: str) -> bool:
        calls.append((name, url))
        return True

    monkeypatch.setattr(obs, "_check_provider", fake_check)
    payload = await obs.status_payload("test")

    assert payload["provider_mode"] == "live"
    assert payload["providers"] == {"fal": True, "openrouter": True}
    assert {name for name, _ in calls} == {"fal", "openrouter"}


@pytest.mark.asyncio
async def test_status_payload_openclaw_is_read_only_and_never_probes_alternates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MOCK_PROVIDERS", raising=False)
    monkeypatch.setenv("FLIPBOOK_LIVE_PROVIDER", "openclaw")
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_TEXT_MODEL", "openai/gpt-5.6-luna")
    monkeypatch.setenv("FLIPBOOK_OPENCLAW_IMAGE_MODEL", "openai/gpt-image-2")
    usage.reset_for_tests()
    breaker.reset_for_tests()
    usage.record_provider_call("planner")
    breaker.record_failure("openclaw:responses")

    async def fake_health(_self: object) -> dict[str, bool]:
        return {"ok": True}

    async def forbidden_check(name: str, url: str) -> bool:
        raise AssertionError(f"OpenClaw status probed alternate {name}: {url}")

    monkeypatch.setattr(
        openclaw_runtime.OpenClawGatewayClient,
        "authenticated_health",
        fake_health,
    )
    monkeypatch.setattr(obs, "_check_provider", forbidden_check)

    payload = await obs.status_payload("test")

    assert payload["providers"] == {"openclaw": True}
    assert payload["provider_control"] == "read_only"
    assert payload["model_control"] == "read_only"
    assert payload["alternate_provider_fallback"] is False
    assert payload["breakers"]["responses"]["consecutive_failures"] == 1
    assert payload["usage"]["scope"] == "since backend start"
    assert payload["usage"]["counters"]["planner_calls"] == 1
    serialized = json.dumps(payload)
    for forbidden in ("flipbook_openclaw_base_url", "bearer", "password", "token"):
        assert forbidden not in serialized.lower()

    usage.reset_for_tests()
    breaker.reset_for_tests()
