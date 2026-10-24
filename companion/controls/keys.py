"""Key → command mapping with debounce (plan.md Defaults → Controls).

``1`` TALK speaker A · ``2`` TALK speaker B · ``space`` TALK resident/contributor ·
``m`` STOP_ALL · ``+``/``-`` volume. Tap to start, tap again to finish: the orchestrator
treats a second START_TURN from the listening speaker as END_TURN.
"""

from __future__ import annotations

import time
from collections.abc import Callable

from companion.events import Command, SetVolume, StartTurn, StopAll

VOLUME_STEP = 10


class KeyMapper:
    def __init__(
        self,
        debounce_s: float = 0.15,
        volume: int = 70,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.debounce_s = debounce_s
        self.volume = volume
        self._clock = clock
        self._last: dict[str, float] = {}

    def map(self, key: str) -> Command | None:
        key = " " if key in {"space", " "} else key.lower()
        now = self._clock()
        if key != "m" and now - self._last.get(key, -1e9) < self.debounce_s:
            return None  # bounce; STOP_ALL is never debounced away
        self._last[key] = now
        if key == "1":
            return StartTurn(speaker="a")
        if key == "2":
            return StartTurn(speaker="b")
        if key == " ":
            return StartTurn(speaker="resident")  # orchestrator maps to the mode's role
        if key == "m":
            return StopAll()
        if key in {"+", "="}:
            self.volume = min(100, self.volume + VOLUME_STEP)
            return SetVolume(value=self.volume)
        if key in {"-", "_"}:
            self.volume = max(0, self.volume - VOLUME_STEP)
            return SetVolume(value=self.volume)
        return None
