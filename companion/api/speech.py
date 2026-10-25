"""HTTP speech adapter for the Companion / Care screen (architecture §6, "Speech adapter").

``GET /api/capabilities`` · ``POST /api/turn`` (multipart: ``metadata`` JSON + ``audio`` or
``text``) · ``POST /api/speak`` (JSON → audio). Every turn response echoes ``turn_id`` and
``person_id`` so the screen can drop anything that isn't for the current turn and person.
Errors are ``{"error": <plain words>}`` plus the IDs, and the ``transcript`` when valid
original words exist, so the screen keeps them and never shows an invented translation.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException

from companion.providers import ProviderError
from companion.speech.language import normalize_code
from companion.speech.service import SpeechService, TurnStopped
from companion.speech.stt import sniff_audio

router = APIRouter()

MAX_AUDIO_BYTES = 16 * 1024 * 1024  # ~60 s of Opus is well under 1 MB; WAV fits too
MAX_TURN_BYTES = MAX_AUDIO_BYTES + 256 * 1024  # multipart overhead + metadata
MAX_TEXT_CHARS = 2000  # the screen's "Type instead" box allows 2000
MAX_SPEAK_CHARS = 4096  # TTS input limit
NO_STORE = {"Cache-Control": "no-store"}

UNREADABLE = "This request couldn't be read. Please try again."
STOPPED = "Stopped. Tap Start conversation when you're ready."


class TurnMeta(BaseModel):
    model_config = ConfigDict(extra="ignore")  # the screen may add fields later

    turn_id: str = Field(min_length=1, max_length=128)
    person_id: str = Field(min_length=1, max_length=128)
    stage: Literal["detect", "translate"]
    source_language: str = Field(default="auto", max_length=35)
    recipient: Literal["resident", "visitor"] | None = None
    target_language: str | None = Field(default=None, max_length=35)


class SpeakBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    text: str = Field(max_length=MAX_SPEAK_CHARS * 4)
    language: str = Field(max_length=35)


def _service(request: Request) -> SpeechService:
    return request.app.state.speech


def _error(
    status: int, message: str, meta: TurnMeta | None = None, transcript: str | None = None
) -> JSONResponse:
    body: dict[str, Any] = {"error": message}
    if meta is not None:
        body["turn_id"] = meta.turn_id
        body["person_id"] = meta.person_id
    if transcript:
        body["transcript"] = transcript
    return JSONResponse(body, status_code=status, headers=NO_STORE)


@router.get("/api/capabilities")
async def capabilities(request: Request) -> JSONResponse:
    return JSONResponse(_service(request).capabilities(), headers=NO_STORE)


@router.post("/api/turn")
async def turn(request: Request) -> JSONResponse:
    length = request.headers.get("content-length", "")
    if not length.isdigit():
        return _error(411, UNREADABLE)
    if int(length) > MAX_TURN_BYTES:
        return _error(413, "This recording is too large. Try a shorter message.")
    if not request.headers.get("content-type", "").startswith("multipart/form-data"):
        return _error(415, UNREADABLE)
    try:
        async with request.form(max_files=1, max_fields=4, max_part_size=64 * 1024) as form:
            try:
                meta = TurnMeta.model_validate_json(str(form.get("metadata") or ""))
            except ValidationError:
                return _error(400, UNREADABLE)
            audio = form.get("audio")
            text = form.get("text")
            data = await audio.read(MAX_AUDIO_BYTES + 1) if isinstance(audio, UploadFile) else None
    except (HTTPException, MultiPartException):
        return _error(400, UNREADABLE)
    text = text.strip() if isinstance(text, str) else None
    if data is not None:
        return await _detect_audio(request, meta, data)
    return await _with_text(request, meta, text)


async def _detect_audio(request: Request, meta: TurnMeta, data: bytes) -> JSONResponse:
    if meta.stage != "detect":
        return _error(400, "Send the words to translate as text.", meta)
    if len(data) > MAX_AUDIO_BYTES:
        return _error(413, "This recording is too large. Try a shorter message.", meta)
    ext = sniff_audio(data)
    if ext is None:
        return _error(415, "This recording couldn't be used. Please try again.", meta)
    service = _service(request)
    try:
        found = await service.detect_audio(data, ext, meta.person_id, request.is_disconnected)
    except ProviderError as exc:
        return _error(exc.status, exc.message, meta)
    except TurnStopped:
        return _error(409, STOPPED, meta)
    return _detection(service, meta, found.transcript, found.language, found.certain)


async def _with_text(request: Request, meta: TurnMeta, text: str | None) -> JSONResponse:
    if not text:
        return _error(400, "Send a recording or typed words.", meta)
    if len(text) > MAX_TEXT_CHARS:
        return _error(413, "This message is too long. Try a shorter message.", meta)
    service = _service(request)
    try:
        if meta.stage == "detect":
            found = await service.detect_text(text, request.is_disconnected)
            return _detection(service, meta, found.transcript, found.language, found.certain)
        target = normalize_code(meta.target_language)
        if target is None or not service.supports_output(target):
            return _error(422, "Translation isn't available for this language yet.", meta, text)
        result = await service.translate(text, target, meta.person_id, request.is_disconnected)
    except ProviderError as exc:
        return _error(exc.status, exc.message, meta, text if meta.stage == "translate" else None)
    except TurnStopped:
        return _error(409, STOPPED, meta, text if meta.stage == "translate" else None)
    return JSONResponse(
        {
            "turn_id": meta.turn_id,
            "person_id": meta.person_id,
            "target_language": meta.target_language,  # echoed exactly as sent
            "transcript": text,
            "translation": result.text,
            "pronunciation": result.pronunciation,
            "machine_translation": True,
            "simulated": service.providers.simulated,
        },
        headers=NO_STORE,
    )


def _detection(
    service: SpeechService, meta: TurnMeta, transcript: str, language: str | None, certain: bool
) -> JSONResponse:
    return JSONResponse(
        {
            "turn_id": meta.turn_id,
            "person_id": meta.person_id,
            "transcript": transcript,
            "detected_language": language,
            "detection_certain": bool(certain and language),
            "simulated": service.providers.simulated,
        },
        headers=NO_STORE,
    )


@router.post("/api/speak")
async def speak(body: SpeakBody, request: Request) -> Response:
    text = body.text.strip()
    if not text:
        return _error(422, "There are no words to read aloud.")
    if len(text) > MAX_SPEAK_CHARS:
        return _error(413, "These words are too long to read aloud. You can still read them on screen.")
    language = normalize_code(body.language)
    if language is None:
        return _error(422, "Reading aloud isn't available for this language yet.")
    service = _service(request)
    try:
        audio = await service.speak(text, language, request.is_disconnected)
    except ProviderError as exc:
        return _error(exc.status, exc.message)
    except TurnStopped:
        return _error(409, STOPPED)
    headers = dict(NO_STORE)
    if service.providers.simulated:
        headers["X-Simulated"] = "1"
    return Response(audio.data, media_type=audio.mime, headers=headers)
