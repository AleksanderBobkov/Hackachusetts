"""Text-to-speech adapters: ``synthesize(text, language) -> SpeechAudio`` (architecture §3).

The screen plays the returned audio itself, so Pause/STOP_ALL can silence it instantly and
the volume control applies. Disclosed AI voice only: no voice cloning or impersonation.
"""

from __future__ import annotations

import asyncio
import io
import math
import struct
import wave
from dataclasses import dataclass
from typing import Any, Protocol

from companion.providers import ProviderError, provider_error_from_openai
from companion.speech.language import english_name


@dataclass(frozen=True)
class SpeechAudio:
    data: bytes
    mime: str


class TTS(Protocol):
    async def synthesize(self, text: str, language: str) -> SpeechAudio: ...


def chime_wav(rate: int = 16000) -> bytes:
    """A short, quiet two-note chime (0.5 s, 16-bit mono) with soft edges."""
    frames = bytearray()
    for freq, seconds in ((523.25, 0.22), (659.25, 0.28)):
        n = int(rate * seconds)
        fade = int(rate * 0.02)
        for i in range(n):
            envelope = min(1.0, i / fade, (n - i) / fade)
            sample = 0.12 * envelope * math.sin(2 * math.pi * freq * i / rate)
            frames += struct.pack("<h", int(sample * 32767))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(bytes(frames))
    return buffer.getvalue()


class MockTTS:
    """PROVIDER=mock: a chime stands in for speech so the playback path can be exercised."""

    def __init__(self) -> None:
        self._audio = chime_wav()

    async def synthesize(self, text: str, language: str) -> SpeechAudio:
        await asyncio.sleep(0)
        return SpeechAudio(self._audio, "audio/wav")


class OpenAITTS:
    def __init__(self, client: Any, model: str, voice: str) -> None:
        self.client = client
        self.model = model
        self.voice = voice

    async def synthesize(self, text: str, language: str) -> SpeechAudio:
        options: dict[str, Any] = {}
        if not self.model.startswith("tts-1"):  # older models don't take instructions
            options["instructions"] = (
                f"Speak {english_name(language)} clearly, warmly, and at a relaxed pace "
                "for an older listener."
            )
        try:
            response = await self.client.audio.speech.create(
                model=self.model,
                voice=self.voice,
                input=text,
                response_format="mp3",
                **options,
            )
            data = response.content
        except Exception as exc:
            raise provider_error_from_openai(exc) from exc
        if not data:
            raise ProviderError("tts_failed", "Audio could not be prepared. You can still read the words on screen.")
        return SpeechAudio(bytes(data), "audio/mpeg")
