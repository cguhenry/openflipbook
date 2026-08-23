"""Small in-process circuit breaker shared by provider and runtime paths.

Three consecutive transient failures open a slug's circuit for a cooldown.
OpenClaw callers fail before dispatch while open; they never select an
alternate provider. Success closes the circuit. In-process by design: per
container, reset on restart — right-sized for a self-hosted stack. Legacy
callers may still use ``available`` as their existing routing signal.
"""
from __future__ import annotations

import math
import threading
import time

FAILURE_THRESHOLD = 3
COOLDOWN_S = 120.0

_lock = threading.Lock()
_failures: dict[str, int] = {}
_open_until: dict[str, float] = {}


def available(slug: str) -> bool:
    with _lock:
        until = _open_until.get(slug, 0.0)
        return not (until and time.monotonic() < until)


def snapshot(slug: str) -> dict[str, int | float | str]:
    """Return secret-free state without mutating cooldown/probe behavior."""

    with _lock:
        now = time.monotonic()
        failures = _failures.get(slug, 0)
        until = _open_until.get(slug, 0.0)
        remaining = max(0.0, until - now)
        if remaining > 0:
            state = "open"
        elif until and failures >= FAILURE_THRESHOLD:
            state = "half_open"
        else:
            state = "closed"
        return {
            "state": state,
            "consecutive_failures": failures,
            "retry_after_seconds": math.ceil(remaining),
            "failure_threshold": FAILURE_THRESHOLD,
            "cooldown_seconds": int(COOLDOWN_S),
        }


def record_success(slug: str) -> None:
    with _lock:
        _failures.pop(slug, None)
        _open_until.pop(slug, None)


def record_failure(slug: str) -> None:
    with _lock:
        count = _failures.get(slug, 0) + 1
        _failures[slug] = count
        if count >= FAILURE_THRESHOLD:
            _open_until[slug] = time.monotonic() + COOLDOWN_S


def reset_for_tests() -> None:
    with _lock:
        _failures.clear()
        _open_until.clear()
