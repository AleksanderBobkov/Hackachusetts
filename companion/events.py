"""WebSocket event/command models — the UI contract (docs/architecture.md §6).

Server → UI events carry a ``type`` discriminator; UI → server commands carry ``cmd``.
Hardware buttons produce the same commands as the UI.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

Mode = Literal["companion", "translate", "contribute"]
Speaker = Literal["a", "b", "resident", "contributor"]
StateName = Literal[
    "idle", "listening", "transcribing", "thinking", "translating", "speaking", "muted", "error"
]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- events (server → UI)


class StateEvent(_Model):
    type: Literal["state"] = "state"
    state: StateName
    mode: Mode
    speaker: Speaker | None = None
    turn_id: int | None = None


class TranscriptEvent(_Model):
    type: Literal["transcript"] = "transcript"
    turn_id: int
    speaker: Speaker
    language: str
    text: str


class TranslationEvent(_Model):
    type: Literal["translation"] = "translation"
    turn_id: int
    source: str
    target: str
    text: str
    machine_translation: bool = True


class AnswerEvent(_Model):
    type: Literal["answer"] = "answer"
    turn_id: int
    language: str
    text: str
    claim_ids: list[str] = Field(default_factory=list)


class PlaybackEvent(_Model):
    type: Literal["playback"] = "playback"
    turn_id: int
    status: Literal["started", "finished", "stopped"]


class ProposalEvent(_Model):
    type: Literal["proposal"] = "proposal"
    proposal_id: str
    claims: list[dict[str, Any]] = Field(default_factory=list)
    unknowns: list[dict[str, Any]] = Field(default_factory=list)


class ErrorEvent(_Model):
    type: Literal["error"] = "error"
    turn_id: int | None = None
    code: str  # stt_failed | network | mic | invalid_command | internal | ...
    message: str


class PhotoEvent(_Model):
    type: Literal["photo"] = "photo"
    photo_id: str
    url: str


Event = Annotated[
    Union[
        StateEvent,
        TranscriptEvent,
        TranslationEvent,
        AnswerEvent,
        PlaybackEvent,
        ProposalEvent,
        ErrorEvent,
        PhotoEvent,
    ],
    Field(discriminator="type"),
]

# ---------------------------------------------------------------- commands (UI → server)


class StartTurn(_Model):
    cmd: Literal["start_turn"] = "start_turn"
    speaker: Speaker


class EndTurn(_Model):
    cmd: Literal["end_turn"] = "end_turn"


class StopAll(_Model):
    cmd: Literal["stop_all"] = "stop_all"


class SetVolume(_Model):
    cmd: Literal["set_volume"] = "set_volume"
    value: int = Field(ge=0, le=100)


class SetMode(_Model):
    cmd: Literal["set_mode"] = "set_mode"
    mode: Mode


class SetPhoto(_Model):
    cmd: Literal["set_photo"] = "set_photo"
    photo_id: str


Command = Annotated[
    Union[StartTurn, EndTurn, StopAll, SetVolume, SetMode, SetPhoto],
    Field(discriminator="cmd"),
]

_event_adapter: TypeAdapter[Event] = TypeAdapter(Event)
_command_adapter: TypeAdapter[Command] = TypeAdapter(Command)


def parse_event(data: dict[str, Any] | str) -> Event:
    if isinstance(data, str):
        return _event_adapter.validate_json(data)
    return _event_adapter.validate_python(data)


def parse_command(data: dict[str, Any] | str) -> Command:
    if isinstance(data, str):
        return _command_adapter.validate_json(data)
    return _command_adapter.validate_python(data)


def dump(event: BaseModel) -> dict[str, Any]:
    """Serialize an event for the wire (keeps explicit nulls so shapes are stable)."""
    return event.model_dump(mode="json")
