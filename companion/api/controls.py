"""Physical controls → every screen (plan.md "Controls", Hackathon Report hardware intents).

``POST /controls`` is the input for whatever reads the buttons on the device: a GPIO or USB
HID bridge script today, the evdev reader once it lands, or the screen's own ``?keys=1``
dev keys. Raw key names go through :class:`KeyMapper` (debounce + volume steps), so every
source behaves the same.

* STOP_ALL also stops the backend: the orchestrator mutes and in-flight speech requests
  are cancelled (``SpeechService.cancel_all``). It always wins and is never debounced.
* Every press is relayed to connected screens as a ``control`` event on ``/ws``. The
  Companion / Care screen records in the browser, so TALK is handled there.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from companion.events import (
    Command,
    ControlAction,
    ControlEvent,
    EndTurn,
    SetVolume,
    StartTurn,
    StopAll,
    dump,
)

router = APIRouter()


class ControlBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str | None = Field(default=None, min_length=1, max_length=16)  # "1", "2", "space", "m", "+", "-"
    action: ControlAction | None = None
    speaker: Literal["resident", "visitor"] | None = None
    value: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def _one_input(self) -> ControlBody:
        if (self.key is None) == (self.action is None):
            raise ValueError("Send either a key or an action")
        if self.action == "SET_VOLUME" and self.value is None:
            raise ValueError("SET_VOLUME needs a value from 0 to 1")
        return self


def control_from_command(cmd: Command) -> ControlEvent | None:
    """Map a turn-engine command (from KeyMapper) to the screen's control intent."""
    if isinstance(cmd, StartTurn):
        return ControlEvent(action="START_TURN", speaker="visitor" if cmd.speaker == "b" else "resident")
    if isinstance(cmd, EndTurn):
        return ControlEvent(action="END_TURN")
    if isinstance(cmd, StopAll):
        return ControlEvent(action="STOP_ALL")
    if isinstance(cmd, SetVolume):
        return ControlEvent(action="SET_VOLUME", value=cmd.value / 100)
    return None


async def dispatch_control(state: Any, event: ControlEvent) -> None:
    """Apply a control to the backend, then relay it to every connected screen."""
    if event.action == "STOP_ALL":
        await state.orch.handle(StopAll())  # mutes + cancels in-flight speech requests
    elif event.action == "SET_VOLUME" and event.value is not None:
        await state.orch.handle(SetVolume(value=round(event.value * 100)))
    await state.hub.publish(event)


@router.post("/controls")
async def post_control(body: ControlBody, request: Request) -> dict[str, Any]:
    state = request.app.state
    if body.key is not None:
        cmd = state.keys.map(body.key)
        event = control_from_command(cmd) if cmd is not None else None
        if event is None:  # key bounce or a key with no meaning
            return {"ok": True, "relayed": None}
    else:
        event = ControlEvent(action=body.action, speaker=body.speaker, value=body.value)
    await dispatch_control(state, event)
    return {"ok": True, "relayed": dump(event)}
