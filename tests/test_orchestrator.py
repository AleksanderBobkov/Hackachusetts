import asyncio
import time

import pytest

from companion.audio import NullAudio
from companion.events import (
    EndTurn,
    PlaybackEvent,
    SetMode,
    StartTurn,
    StateEvent,
    StopAll,
    TranscriptEvent,
)
from companion.orchestrator import Orchestrator, PipelineError, TurnCancelled, TurnContext


class Recorder:
    def __init__(self) -> None:
        self.events: list = []

    async def __call__(self, event) -> None:
        self.events.append(event)

    def states(self) -> list[str]:
        return [e.state for e in self.events if isinstance(e, StateEvent)]

    def of(self, cls) -> list:
        return [e for e in self.events if isinstance(e, cls)]


class GatedPipeline:
    """Drives the turn into ``target`` state, then blocks until released."""

    def __init__(self, target: str | None = None, fail: bool = False) -> None:
        self.target = target
        self.fail = fail
        self.gate = asyncio.Event()
        self.reached = asyncio.Event()
        self.ctx: TurnContext | None = None
        self.finished_normally = False

    async def __call__(self, ctx: TurnContext) -> None:
        self.ctx = ctx
        if self.fail:
            raise PipelineError("stt_failed", "I didn't catch that.")
        if self.target:
            await ctx.set_state(self.target)
        self.reached.set()
        await self.gate.wait()
        await ctx.emit(TranscriptEvent(turn_id=ctx.turn_id, speaker=ctx.speaker,
                                       language="pl", text="late result"))
        self.finished_normally = True


def make(pipeline=None, mode="translate", **kw):
    rec = Recorder()
    audio = NullAudio()
    pipelines = {m: pipeline for m in ("translate", "companion", "contribute")} if pipeline else {}
    orch = Orchestrator(emit=rec, pipelines=pipelines, audio=audio, mode=mode, **kw)
    return orch, rec, audio


async def drive_to(state: str):
    """Return (orch, rec, audio, pipeline) with the orchestrator sitting in ``state``."""
    if state in {"transcribing", "translating", "thinking", "speaking"}:
        p = GatedPipeline(target=state)
        orch, rec, audio = make(p)
        await orch.handle(StartTurn(speaker="a"))
        await orch.handle(EndTurn())
        await asyncio.wait_for(p.reached.wait(), 1)
        return orch, rec, audio, p
    if state == "error":
        p = GatedPipeline(fail=True)
        orch, rec, audio = make(p)
        await orch.handle(StartTurn(speaker="a"))
        await orch.handle(EndTurn())
        for _ in range(20):
            await asyncio.sleep(0)
        return orch, rec, audio, p
    p = GatedPipeline()
    orch, rec, audio = make(p)
    if state == "listening":
        await orch.handle(StartTurn(speaker="a"))
    elif state == "muted":
        await orch.handle(StopAll())
    return orch, rec, audio, p


ALL_STATES = ["idle", "listening", "transcribing", "translating", "thinking",
              "speaking", "muted", "error"]


@pytest.mark.parametrize("state", ALL_STATES)
async def test_stop_all_from_every_state(state):
    orch, rec, audio, p = await drive_to(state)
    assert orch.state == state
    flushes = audio.playback_flushes
    t0 = time.perf_counter()
    await orch.handle(StopAll())
    assert time.perf_counter() - t0 < 0.5
    assert orch.state == "muted"
    assert rec.states()[-1] == "muted"
    assert orch.turn_id is None
    assert audio.playback_flushes == flushes + 1
    assert audio.capturing is None
    # The in-flight pipeline is cancelled and its late result never reaches the UI.
    n = len(rec.events)
    p.gate.set()
    for _ in range(20):
        await asyncio.sleep(0)
    assert len(rec.events) == n
    assert not p.finished_normally
    # Device is usable again afterwards.
    await orch.handle(StartTurn(speaker="b"))
    assert orch.state == "listening"


async def test_stop_while_speaking_reports_playback_stopped():
    orch, rec, _, p = await drive_to("speaking")
    turn = p.ctx.turn_id
    await orch.handle(StopAll())
    stopped = rec.of(PlaybackEvent)
    assert stopped and stopped[-1].status == "stopped" and stopped[-1].turn_id == turn


async def test_late_result_from_stale_turn_is_dropped():
    orch, rec, _, p = await drive_to("translating")
    stale = p.ctx
    await orch.handle(StopAll())
    await orch.handle(StartTurn(speaker="b"))  # new current turn
    n = len(rec.events)
    assert await stale.emit(TranscriptEvent(turn_id=stale.turn_id, speaker="a",
                                            language="pl", text="late")) is False
    assert await stale.set_state("speaking") is False
    assert len(rec.events) == n
    assert orch.state == "listening"


async def test_provider_result_after_stop_raises_cancelled():
    orch, _, _, p = await drive_to("transcribing")
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    call = asyncio.create_task(p.ctx.run(fut))
    await asyncio.sleep(0)
    await orch.handle(StopAll())
    fut.set_result("transcript that arrived too late")
    with pytest.raises(TurnCancelled):
        await call


async def test_provider_timeout_maps_to_network_error():
    async def slow(ctx):
        await ctx.run(asyncio.sleep(5), timeout=0.01)

    orch, rec, _ = make(slow)
    await orch.handle(StartTurn(speaker="a"))
    await orch.handle(EndTurn())
    await asyncio.sleep(0.1)
    errors = [e for e in rec.events if getattr(e, "type", "") == "error"]
    assert errors and errors[-1].code == "network"
    assert orch.state == "error"


async def test_turn_ids_increase_monotonically():
    async def ok(ctx):
        await ctx.set_state("transcribing")

    orch, rec, _ = make(ok)
    seen = []
    for speaker in ["a", "b", "a"]:
        await orch.handle(StartTurn(speaker=speaker))
        seen.append(orch.turn_id)
        await orch.handle(EndTurn())
        await asyncio.sleep(0.01)
        assert orch.state == "idle"
    await orch.handle(StopAll())
    await orch.handle(StartTurn(speaker="a"))
    seen.append(orch.turn_id)
    assert seen == sorted(set(seen)) and len(seen) == 4


async def test_second_press_by_same_speaker_ends_turn():
    p = GatedPipeline(target="transcribing")
    orch, _, _ = make(p)
    await orch.handle(StartTurn(speaker="a"))
    await orch.handle(StartTurn(speaker="a"))
    await asyncio.wait_for(p.reached.wait(), 1)
    assert orch.state == "transcribing"


async def test_new_press_barges_in_and_cancels_old_turn():
    orch, rec, _, p = await drive_to("speaking")
    old = p.ctx
    await orch.handle(StartTurn(speaker="b"))
    assert orch.state == "listening" and orch.speaker == "b"
    assert not old.current
    assert rec.of(PlaybackEvent)[-1].status == "stopped"


async def test_wrong_speaker_for_mode_is_rejected():
    orch, rec, _ = make(GatedPipeline(), mode="translate")
    await orch.handle(StartTurn(speaker="contributor"))
    assert orch.state == "idle"
    assert rec.events[-1].code == "invalid_command"


async def test_space_key_role_maps_to_mode_role():
    orch, _, _ = make(GatedPipeline(), mode="contribute")
    await orch.handle(StartTurn(speaker="resident"))
    assert orch.state == "listening" and orch.speaker == "contributor"


async def test_mode_change_cancels_turn_and_clears_session():
    cleared = []
    orch, rec, _ = make(GatedPipeline(), on_session_reset=lambda: cleared.append(1))
    await orch.handle(StartTurn(speaker="a"))
    await orch.handle(SetMode(mode="companion"))
    assert orch.state == "idle" and orch.mode == "companion" and cleared == [1]
    assert rec.events[-1].mode == "companion"


async def test_end_turn_without_pipeline_reports_error_not_success():
    orch, rec, _ = make(None)
    await orch.handle(StartTurn(speaker="a"))
    await orch.handle(EndTurn())
    assert orch.state == "error"
    assert rec.of(type(rec.events[-2]))  # error event emitted before state
    assert any(getattr(e, "code", None) == "not_implemented" for e in rec.events)


async def test_stray_end_turn_is_ignored():
    orch, rec, _ = make(GatedPipeline())
    await orch.handle(EndTurn())
    assert orch.state == "idle" and rec.events == []


async def test_max_recording_time_ends_turn():
    p = GatedPipeline(target="transcribing")
    orch, _, _ = make(p, max_record_s=0.05)
    await orch.handle(StartTurn(speaker="a"))
    await asyncio.wait_for(p.reached.wait(), 1)
    assert orch.state == "transcribing"
