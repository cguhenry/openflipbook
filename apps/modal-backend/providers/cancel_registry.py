"""In-process cancellation tokens for the private NAS SSE worker."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass


class GenerationCancelled(asyncio.CancelledError):
    pass


@dataclass
class GenerationCancelToken:
    generation_id: str
    event: asyncio.Event
    task: asyncio.Task | None = None

    def cancelled(self) -> bool:
        return self.event.is_set()

    def raise_if_cancelled(self) -> None:
        if self.event.is_set():
            raise GenerationCancelled(self.generation_id)


class GenerationCancelRegistry:
    """Single-process registry shared by the FastAPI SSE and cancel routes."""

    def __init__(self) -> None:
        self._tokens: dict[str, GenerationCancelToken] = {}
        self._lock = asyncio.Lock()

    async def start(
        self, generation_id: str, *, task: asyncio.Task | None = None
    ) -> GenerationCancelToken:
        if not generation_id:
            raise ValueError("generation_id is required")
        async with self._lock:
            if generation_id in self._tokens:
                raise ValueError(f"duplicate active generation_id {generation_id}")
            token = GenerationCancelToken(generation_id, asyncio.Event(), task)
            self._tokens[generation_id] = token
            return token

    async def cancel(self, generation_id: str) -> bool:
        async with self._lock:
            token = self._tokens.get(generation_id)
            if token is None:
                return False
            token.event.set()
            task = token.task
        current = asyncio.current_task()
        if task is not None and task is not current and not task.done():
            task.cancel()
        return True

    async def finish(self, generation_id: str) -> None:
        async with self._lock:
            self._tokens.pop(generation_id, None)

    async def active(self, generation_id: str) -> bool:
        async with self._lock:
            return generation_id in self._tokens


GENERATION_CANCELS = GenerationCancelRegistry()
