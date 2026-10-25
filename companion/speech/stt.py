"""Speech-to-text adapters: ``transcribe(audio, mime) -> Transcript`` (architecture §3).

Audio arrives from the screen's recorder (WebM/Opus or Ogg/Opus in Chromium) or, later, the
device microphone (16 kHz WAV). It is held in memory for one request and never written to
disk. The container is identified from the bytes, not the filename or declared type.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from companion.providers import provider_error_from_openai
from companion.speech.language import normalize_code

# extension → MIME type the transcription API accepts
AUDIO_TYPES = {
    "webm": "audio/webm",
    "ogg": "audio/ogg",
    "wav": "audio/wav",
    "m4a": "audio/mp4",
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
}


def sniff_audio(data: bytes) -> str | None:
    """Return the file extension for supported audio containers, else None."""
    if data[:4] == b"\x1a\x45\xdf\xa3":  # EBML: WebM / Matroska
        return "webm"
    if data[:4] == b"OggS":
        return "ogg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[4:8] == b"ftyp":
        return "m4a"
    if data[:4] == b"fLaC":
        return "flac"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0):
        return "mp3"
    return None


@dataclass(frozen=True)
class Transcript:
    text: str
    # Languages the provider could reliably detect (normalized, unique). May be empty.
    languages: tuple[str, ...] = ()


class STT(Protocol):
    async def transcribe(
        self, audio: bytes, ext: str, *, keywords: Sequence[str] = ()
    ) -> Transcript: ...


# Scripted lines for PROVIDER=mock: both directions, a third language, then a one-word reply
# that must go to the "Who is this for?" question. Synthetic content only.
MOCK_SCRIPT: tuple[tuple[str, str], ...] = (
    ("es", "Me alegra mucho que estés aquí."),
    ("en", "I'm happy to see you too, Grandma."),
    ("pl", "Cześć kochanie, jak się masz? Tęskniłam za tobą."),
    ("en", "Okay."),
)


class MockSTT:
    """Deterministic stand-in. Ignores the audio content; clips under 1 KB act like silence."""

    MIN_AUDIO_BYTES = 1024

    def __init__(self, delay_s: float = 0.0) -> None:
        self.delay_s = delay_s
        self.calls = 0

    async def transcribe(
        self, audio: bytes, ext: str, *, keywords: Sequence[str] = ()
    ) -> Transcript:
        await asyncio.sleep(self.delay_s)
        if len(audio) < self.MIN_AUDIO_BYTES:
            return Transcript("")
        language, text = MOCK_SCRIPT[self.calls % len(MOCK_SCRIPT)]
        self.calls += 1
        return Transcript(text, (language,))


class OpenAISTT:
    def __init__(self, client: Any, model: str) -> None:
        self.client = client
        self.model = model

    async def transcribe(
        self, audio: bytes, ext: str, *, keywords: Sequence[str] = ()
    ) -> Transcript:
        options: dict[str, Any] = {}
        if self.model.startswith("gpt-transcribe") and keywords:
            options["keywords"] = list(keywords)  # names glossary (architecture §4)
        if self.model.startswith("whisper"):
            options["response_format"] = "verbose_json"  # the only Whisper format with a language
        try:
            result = await self.client.audio.transcriptions.create(
                model=self.model,
                file=(f"turn.{ext}", audio, AUDIO_TYPES[ext]),
                **options,
            )
        except Exception as exc:
            raise provider_error_from_openai(exc) from exc
        return Transcript(_field(result, "text", "").strip(), _languages(result))


def _field(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _languages(result: Any) -> tuple[str, ...]:
    codes: list[str] = []
    # gpt-transcribe: "languages": [{"code": "fr"}], [] when no reliable prediction.
    for item in _field(result, "languages") or []:
        code = normalize_code(_field(item, "code"))
        if code and code not in codes:
            codes.append(code)
    if not codes:  # Whisper verbose_json: "language": "english"
        legacy = normalize_code(_field(result, "language"))
        if legacy:
            codes.append(legacy)
    return tuple(codes)
