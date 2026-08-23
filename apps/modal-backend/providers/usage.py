"""In-process operational usage counters and zero-default generation caps.

Counts are intentionally provider-call counts, not token or dollar estimates.
They reset with the backend process and never contain session identifiers in
the public snapshot.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Literal

USAGE_CAP_REACHED = "OPENFLIPBOOK_USAGE_CAP_REACHED"

GenerationOutcome = Literal["success", "failed", "cancelled"]
ProviderCall = Literal["planner", "alignment", "image"]

_COUNTER_KEYS = (
    "generation_requests",
    "generation_success",
    "generation_failed",
    "generation_cancelled",
    "planner_calls",
    "alignment_calls",
    "image_calls",
    "searxng_searches",
)
_lock = threading.Lock()
_counters = dict.fromkeys(_COUNTER_KEYS, 0)
_accepted_generations = 0
_session_generations: dict[str, int] = {}


class UsageCapError(RuntimeError):
    """A stable fail-before-dispatch rejection for a configured count cap."""

    code = USAGE_CAP_REACHED

    def __init__(self, scope: Literal["runtime", "session"], cap: int) -> None:
        self.scope = scope
        self.cap = cap
        super().__init__(f"{self.code}: {scope} generation cap {cap} reached")


@dataclass
class GenerationTicket:
    session_id: str
    finished: bool = False


def _cap(name: str) -> int:
    raw = os.environ.get(name, "0").strip()
    try:
        value = int(raw)
    except ValueError:
        return 0
    return max(0, value)


def runtime_cap() -> int:
    return _cap("FLIPBOOK_MAX_RUNTIME_GENERATIONS")


def session_cap() -> int:
    return _cap("FLIPBOOK_MAX_SESSION_GENERATIONS")


def begin_generation(session_id: str) -> GenerationTicket:
    """Count a validated request and reserve cap capacity atomically."""

    global _accepted_generations
    runtime_limit = runtime_cap()
    session_limit = session_cap()
    with _lock:
        _counters["generation_requests"] += 1
        if runtime_limit and _accepted_generations >= runtime_limit:
            _counters["generation_failed"] += 1
            raise UsageCapError("runtime", runtime_limit)
        current_session = _session_generations.get(session_id, 0)
        if session_limit and current_session >= session_limit:
            _counters["generation_failed"] += 1
            raise UsageCapError("session", session_limit)
        _accepted_generations += 1
        _session_generations[session_id] = current_session + 1
    return GenerationTicket(session_id=session_id)


def finish_generation(ticket: GenerationTicket, outcome: GenerationOutcome) -> None:
    """Record exactly one terminal outcome for an accepted request."""

    key = {
        "success": "generation_success",
        "failed": "generation_failed",
        "cancelled": "generation_cancelled",
    }[outcome]
    with _lock:
        if ticket.finished:
            return
        ticket.finished = True
        _counters[key] += 1


def record_provider_call(kind: ProviderCall) -> None:
    key = {
        "planner": "planner_calls",
        "alignment": "alignment_calls",
        "image": "image_calls",
    }[kind]
    with _lock:
        _counters[key] += 1


def record_searxng_search() -> None:
    with _lock:
        _counters["searxng_searches"] += 1


def snapshot() -> dict[str, object]:
    with _lock:
        counters = dict(_counters)
        accepted = _accepted_generations
        tracked_sessions = len(_session_generations)
    return {
        "scope": "since backend start",
        "counters": counters,
        "caps": {
            "runtime_generations": runtime_cap(),
            "session_generations": session_cap(),
        },
        "accepted_generations": accepted,
        "tracked_sessions": tracked_sessions,
    }


def reset_for_tests() -> None:
    global _accepted_generations
    with _lock:
        for key in _COUNTER_KEYS:
            _counters[key] = 0
        _accepted_generations = 0
        _session_generations.clear()
