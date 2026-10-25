"""Speech service behind the screen's HTTP adapter (``/api/turn``, ``/api/speak``).

The Companion / Care screen records in the browser and sends one finished turn at a time:

1. ``detect``    audio (or typed text) → transcript + detected language + certainty
2. ``translate`` the kept transcript → the chosen listener's language

Hard rules carried over from the turn engine (plan.md):

* STOP_ALL always wins. Every provider call is registered here; ``cancel_all`` (called by the
  orchestrator on STOP_ALL, session reset and person/mode switch) cancels them, and the
  request answers ``stopped`` instead of a late result.
* A request whose browser went away (Pause conversation aborts the fetch) cancels its own
  provider call, so nothing keeps running or billing for a turn nobody will see.
* Each request has one time budget (``provider_timeout_s``); running out is a ``network``
  error, never a fabricated result.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, TypeVar

from companion.config import Settings
from companion.providers import ProviderError, Providers
from companion.speech.language import detection_certain, normalize_code, safe_glossary
from companion.speech.tts import SpeechAudio
from companion.translate.translator import Translation

log = logging.getLogger(__name__)

T = TypeVar("T")
Disconnected = Callable[[], Awaitable[bool]]
POLL_S = 0.2


class TurnStopped(Exception):
    """The request was cancelled by STOP_ALL / reset / switch, or its client went away."""


@dataclass(frozen=True)
class Detection:
    transcript: str
    language: str | None
    certain: bool


class SpeechService:
    def __init__(
        self,
        providers: Providers,
        settings: Settings,
        glossary: Callable[[str], Sequence[str]] | None = None,
    ) -> None:
        self.providers = providers
        self.settings = settings
        self._glossary = glossary
        self._tasks: set[asyncio.Task[Any]] = set()

    # ------------------------------------------------------------------ capabilities

    def capabilities(self) -> dict[str, Any]:
        p = self.providers
        ok = p.available
        return {
            "speech": ok and p.stt is not None,
            "translation": ok and p.translator is not None,
            "auto_detect": ok and p.stt is not None and p.langid is not None,
            "tts": ok and p.tts is not None,
            "output_languages": dict(self.settings.output_languages),
            "provider": p.name,
            "simulated": p.simulated,
            "remote": p.remote,
            "machine_translation": True,
        }

    def supports_output(self, language: str) -> bool:
        return language in self.settings.output_languages

    def _require(self, adapter: Any) -> Any:
        if not self.providers.available or adapter is None:
            raise ProviderError("unavailable", "Live translation is not connected. Try an example.", 503)
        return adapter

    def glossary(self, person_id: str | None) -> list[str]:
        if not person_id or self._glossary is None:
            return []
        try:
            return safe_glossary(self._glossary(person_id))
        except Exception:  # a glossary problem must never block a turn
            log.exception("glossary lookup failed")
            return []

    # ------------------------------------------------------------------ stages

    async def detect_audio(
        self, audio: bytes, ext: str, person_id: str | None, disconnected: Disconnected | None = None
    ) -> Detection:
        stt = self._require(self.providers.stt)
        keywords = self.glossary(person_id)
        transcript = await self.run(lambda: stt.transcribe(audio, ext, keywords=keywords), disconnected)
        text = transcript.text.strip()
        if not text:
            raise ProviderError("stt_failed", "I didn't catch that. Please try again.", 422)
        languages = list(transcript.languages)
        langid = self.providers.langid
        if not languages and langid is not None:
            # No reliable language from speech: try the words themselves. If that fails too,
            # keep the transcript and let the person choose who hears it.
            try:
                code = await self.run(lambda: langid.identify(text), disconnected)
            except ProviderError:
                code = None
            languages = [code] if code else []
        language = normalize_code(languages[0]) if len(languages) == 1 else None
        return Detection(text, language, detection_certain(text, languages))

    async def detect_text(self, text: str, disconnected: Disconnected | None = None) -> Detection:
        langid = self._require(self.providers.langid)
        code = await self.run(lambda: langid.identify(text), disconnected)
        languages = [code] if code else []
        return Detection(text, normalize_code(code), detection_certain(text, languages))

    async def translate(
        self, text: str, target: str, person_id: str | None, disconnected: Disconnected | None = None
    ) -> Translation:
        translator = self._require(self.providers.translator)
        keep = self.glossary(person_id)
        result = await self.run(lambda: translator.translate(text, target, keep=keep), disconnected)
        if not result.text.strip():
            raise ProviderError("translate_failed", "No translation was returned. Please try again.")
        return result

    async def speak(
        self, text: str, language: str, disconnected: Disconnected | None = None
    ) -> SpeechAudio:
        tts = self._require(self.providers.tts)
        audio = await self.run(lambda: tts.synthesize(text, language), disconnected)
        if not audio.data:
            raise ProviderError("tts_failed", "Audio could not be prepared. You can still read the words on screen.")
        return audio

    # ------------------------------------------------------------------ cancellation

    async def run(self, call: Callable[[], Awaitable[T]], disconnected: Disconnected | None = None) -> T:
        """Run one provider call under the budget; stop it on STOP_ALL or client disconnect."""
        task: asyncio.Task[T] = asyncio.ensure_future(self._bounded(call))
        self._tasks.add(task)
        try:
            while not task.done():
                try:
                    await asyncio.wait({task}, timeout=POLL_S)
                except asyncio.CancelledError:  # the request itself is being torn down
                    task.cancel()
                    raise
                if not task.done() and disconnected is not None and await disconnected():
                    task.cancel()
                    raise TurnStopped("client disconnected")
            if task.cancelled():
                raise TurnStopped("stopped")
            return task.result()
        finally:
            self._tasks.discard(task)

    async def _bounded(self, call: Callable[[], Awaitable[T]]) -> T:
        try:
            return await asyncio.wait_for(call(), self.settings.provider_timeout_s)
        except TimeoutError as exc:
            raise ProviderError(
                "network", "The service took too long to respond. Please try again.", 504
            ) from exc

    @property
    def in_flight(self) -> int:
        return sum(1 for t in self._tasks if not t.done())

    def cancel_all(self) -> int:
        """STOP_ALL hook: cancel every in-flight provider call. Returns how many."""
        cancelled = 0
        for task in list(self._tasks):
            if not task.done():
                task.cancel()
                cancelled += 1
        if cancelled:
            log.info("STOP_ALL cancelled %d speech request(s)", cancelled)
        return cancelled
