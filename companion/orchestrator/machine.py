"""Turn state machine + cancellation (docs/architecture.md §3, plan.md hard rules).

* One turn at a time, identified by a monotonically increasing ``turn_id`` assigned on
  START_TURN.
* A mode-specific *pipeline* coroutine runs after END_TURN. It may only talk to the outside
  world through its :class:`TurnContext`, which drops every state change / event once the
  turn is no longer current (STOP_ALL, mode change, barge-in by a new turn).
* STOP_ALL always wins: flush capture + playback, cancel the in-flight pipeline task,
  invalidate the turn, go to ``muted``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel

from companion.audio import AudioIO, NullAudio
from companion.events import (
    Command,
    EndTurn,
    ErrorEvent,
    Mode,
    PlaybackEvent,
    SetMode,
    SetPhoto,
    SetVolume,
    Speaker,
    StartTurn,
    StateEvent,
    StateName,
    StopAll,
)

log = logging.getLogger(__name__)

Emit = Callable[[BaseModel], Awaitable[None]]
Pipeline = Callable[["TurnContext"], Awaitable[None]]

BUSY_STATES: frozenset[str] = frozenset(
    {"transcribing", "thinking", "translating", "speaking"}
)
MODE_SPEAKERS: dict[str, frozenset[str]] = {
    "translate": frozenset({"a", "b"}),
    "companion": frozenset({"resident"}),
    "contribute": frozenset({"contributor"}),
}


class TurnCancelled(Exception):
    """Raised inside a pipeline when its turn is no longer current."""


class PipelineError(Exception):
    """A stage failed in a way the user should see (never fabricate success)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class TurnContext:
    """Handle a pipeline uses to emit; every call is a no-op once the turn is stale."""

    def __init__(self, orch: Orchestrator, turn_id: int, mode: Mode, speaker: Speaker) -> None:
        self._orch = orch
        self.turn_id = turn_id
        self.mode = mode
        self.speaker = speaker
        self.audio: bytes = b""
        self.cancelled = asyncio.Event()
        self.data: dict[str, Any] = {}  # scratch space for pipeline stages

    @property
    def current(self) -> bool:
        return not self.cancelled.is_set() and self._orch.is_current(self.turn_id)

    def check(self) -> None:
        if not self.current:
            raise TurnCancelled(self.turn_id)

    async def emit(self, event: BaseModel) -> bool:
        """Emit ``event`` if this turn is still current. Returns False if dropped."""
        if not self.current:
            log.info("dropped late %s for stale turn %s", type(event).__name__, self.turn_id)
            return False
        await self._orch._emit(event)
        return True

    async def set_state(self, state: StateName) -> bool:
        if not self.current:
            return False
        self._orch.state = state
        return await self.emit(self._orch._state_event())

    async def run(self, awaitable: Awaitable[Any], timeout: float | None = None) -> Any:
        """Await a provider call; abort on cancellation; map timeouts to ``network``."""
        self.check()
        try:
            result = await asyncio.wait_for(awaitable, timeout)
        except asyncio.TimeoutError as exc:
            raise PipelineError("network", "The service took too long to respond.") from exc
        self.check()  # result arrived after STOP_ALL → drop it
        return result


class Orchestrator:
    def __init__(
        self,
        emit: Emit,
        pipelines: dict[str, Pipeline] | None = None,
        audio: AudioIO | None = None,
        mode: Mode = "translate",
        max_record_s: float = 60.0,
        on_session_reset: Callable[[], None] | None = None,
    ) -> None:
        self._emit = emit
        self.pipelines: dict[str, Pipeline] = dict(pipelines or {})
        self.audio: AudioIO = audio or NullAudio()
        self.mode: Mode = mode
        self.state: StateName = "idle"
        self.speaker: Speaker | None = None
        self.volume = 70
        self.photo_id: str | None = None
        self.max_record_s = max_record_s
        self.on_session_reset = on_session_reset
        self._turn_counter = 0
        self._current: TurnContext | None = None
        self._task: asyncio.Task[None] | None = None
        self._record_timer: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ queries

    @property
    def turn_id(self) -> int | None:
        return self._current.turn_id if self._current else None

    def is_current(self, turn_id: int) -> bool:
        return self._current is not None and self._current.turn_id == turn_id

    def _state_event(self) -> StateEvent:
        return StateEvent(
            state=self.state, mode=self.mode, speaker=self.speaker, turn_id=self.turn_id
        )

    async def _set_state(self, state: StateName) -> None:
        self.state = state
        await self._emit(self._state_event())

    # ------------------------------------------------------------------ commands

    async def handle(self, cmd: Command) -> None:
        if isinstance(cmd, StopAll):
            await self.stop_all()  # never queued behind anything else
            return
        async with self._lock:
            if isinstance(cmd, StartTurn):
                await self._start_turn(cmd.speaker)
            elif isinstance(cmd, EndTurn):
                await self._end_turn()
            elif isinstance(cmd, SetMode):
                await self._set_mode(cmd.mode)
            elif isinstance(cmd, SetVolume):
                self.volume = cmd.value
                self.audio.set_volume(cmd.value)
            elif isinstance(cmd, SetPhoto):
                self.photo_id = cmd.photo_id

    async def stop_all(self) -> None:
        """STOP_ALL / MUTE: always wins, from any state."""
        was_speaking = self.state == "speaking"
        old = self._invalidate()
        self.audio.flush_capture()
        self.audio.flush_playback()
        if old is not None and was_speaking:
            await self._emit(PlaybackEvent(turn_id=old.turn_id, status="stopped"))
        self.speaker = None
        await self._set_state("muted")

    async def reset_session(self) -> None:
        """POST /session/reset: stop everything and clear ephemeral session context."""
        self._invalidate()
        self.audio.flush_capture()
        self.audio.flush_playback()
        if self.on_session_reset:
            self.on_session_reset()
        self.speaker = None
        await self._set_state("idle")

    # ------------------------------------------------------------------ internals

    def _invalidate(self) -> TurnContext | None:
        old, self._current = self._current, None
        if old is not None:
            old.cancelled.set()
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self._task = None
        self._cancel_record_timer()
        return old

    def _cancel_record_timer(self) -> None:
        if self._record_timer is not None and not self._record_timer.done():
            if self._record_timer is not asyncio.current_task():
                self._record_timer.cancel()
        self._record_timer = None

    def _normalize_speaker(self, speaker: Speaker) -> Speaker | None:
        allowed = MODE_SPEAKERS[self.mode]
        if speaker in allowed:
            return speaker
        # The shared space-bar TALK key maps to whichever single role this mode uses.
        if self.mode != "translate" and speaker in {"resident", "contributor"}:
            return next(iter(allowed))  # type: ignore[return-value]
        return None

    async def _start_turn(self, speaker: Speaker) -> None:
        if self.state == "listening" and self._current is not None:
            if self._current.speaker == speaker or self.mode != "translate":
                await self._end_turn()  # tap-to-toggle: second press finishes the turn
                return
        normalized = self._normalize_speaker(speaker)
        if normalized is None:
            await self._emit(
                ErrorEvent(
                    turn_id=None,
                    code="invalid_command",
                    message=f"Speaker {speaker!r} is not valid in {self.mode} mode.",
                )
            )
            return
        if self._current is not None:  # barge-in: a new press interrupts the old turn
            was_speaking = self.state == "speaking"
            old = self._invalidate()
            self.audio.flush_capture()
            self.audio.flush_playback()
            if old is not None and was_speaking:
                await self._emit(PlaybackEvent(turn_id=old.turn_id, status="stopped"))

        self._turn_counter += 1
        ctx = TurnContext(self, self._turn_counter, self.mode, normalized)
        self._current = ctx
        self.speaker = normalized
        self.audio.start_capture(ctx.turn_id)
        await self._set_state("listening")
        if self.max_record_s > 0:
            self._record_timer = asyncio.create_task(self._record_timeout(ctx.turn_id))

    async def _record_timeout(self, turn_id: int) -> None:
        await asyncio.sleep(self.max_record_s)
        async with self._lock:
            if self.is_current(turn_id) and self.state == "listening":
                log.info("turn %s hit max recording time; ending turn", turn_id)
                await self._end_turn()

    async def _end_turn(self) -> None:
        ctx = self._current
        if ctx is None or self.state != "listening":
            return  # nothing to finish; ignore stray END_TURN
        self._cancel_record_timer()
        ctx.audio = self.audio.stop_capture()
        pipeline = self.pipelines.get(ctx.mode)
        if pipeline is None:
            await self._fail(ctx, "not_implemented", f"{ctx.mode} mode is not available yet.")
            return
        self._task = asyncio.create_task(self._run_pipeline(ctx, pipeline))

    async def _run_pipeline(self, ctx: TurnContext, pipeline: Pipeline) -> None:
        try:
            await pipeline(ctx)
        except (TurnCancelled, asyncio.CancelledError):
            return
        except PipelineError as exc:
            await self._fail(ctx, exc.code, exc.message)
            return
        except Exception:  # never fabricate success; surface a readable error
            log.exception("pipeline crashed (turn %s)", ctx.turn_id)
            await self._fail(ctx, "internal", "Something went wrong. Press TALK to try again.")
            return
        if ctx.current:
            self._current = None
            self._task = None
            self.speaker = None
            await self._set_state("idle")

    async def _fail(self, ctx: TurnContext, code: str, message: str) -> None:
        if not ctx.current:
            return
        self.audio.flush_playback()
        await self._emit(ErrorEvent(turn_id=ctx.turn_id, code=code, message=message))
        self._current = None
        self._task = None
        self.speaker = None
        await self._set_state("error")

    async def _set_mode(self, mode: Mode) -> None:
        self._invalidate()
        self.audio.flush_capture()
        self.audio.flush_playback()
        if self.on_session_reset:
            self.on_session_reset()  # mode change clears session context
        self.mode = mode
        self.speaker = None
        await self._set_state("idle")
