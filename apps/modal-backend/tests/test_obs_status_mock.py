"""Regression tests for zero-network /status behavior in mock mode."""

import pytest

import obs


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
