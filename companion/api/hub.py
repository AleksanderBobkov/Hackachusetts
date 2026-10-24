"""Fan-out of server events to every connected UI socket.

Each client gets its own bounded queue + sender task so a slow UI can never block the
orchestrator (and therefore never delay STOP_ALL).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from pydantic import BaseModel

from companion.events import dump

log = logging.getLogger(__name__)


class Hub:
    def __init__(self, maxsize: int = 256) -> None:
        self._queues: set[asyncio.Queue[dict[str, Any]]] = set()
        self._maxsize = maxsize
        self.history: list[dict[str, Any]] = []  # last events, for tests/debug only
        self._history_max = 200

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(self._maxsize)
        self._queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._queues.discard(q)

    async def publish(self, event: BaseModel) -> None:
        payload = dump(event)
        self.history.append(payload)
        del self.history[: -self._history_max]
        for q in list(self._queues):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                log.warning("UI client queue full; dropping oldest event")
                q.get_nowait()
                q.put_nowait(payload)
