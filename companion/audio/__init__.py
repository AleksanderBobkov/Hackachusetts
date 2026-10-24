"""Audio I/O interface used by the orchestrator.

Capture is bounded per turn; playback must be flushable instantly (STOP_ALL).
No raw audio is persisted. Real ``sounddevice`` backends arrive in Phase 1.
"""

from __future__ import annotations

from typing import Protocol


class AudioIO(Protocol):
    def start_capture(self, turn_id: int) -> None: ...
    def stop_capture(self) -> bytes: ...
    def flush_capture(self) -> None: ...
    def flush_playback(self) -> None: ...
    def set_volume(self, value: int) -> None: ...


class NullAudio:
    """No-hardware stand-in: records nothing, plays nothing, tracks calls for tests."""

    def __init__(self) -> None:
        self.capturing: int | None = None
        self.volume = 70
        self.capture_flushes = 0
        self.playback_flushes = 0

    def start_capture(self, turn_id: int) -> None:
        self.capturing = turn_id

    def stop_capture(self) -> bytes:
        self.capturing = None
        return b""

    def flush_capture(self) -> None:
        self.capturing = None
        self.capture_flushes += 1

    def flush_playback(self) -> None:
        self.playback_flushes += 1

    def set_volume(self, value: int) -> None:
        self.volume = value
