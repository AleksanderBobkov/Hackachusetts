"""Speech/translation provider adapters, selected by ``PROVIDER`` (plan.md "Providers").

* ``mock``   deterministic and offline, for dev, tests and demos without keys. Every result
             is labelled ``simulated`` so no screen can present it as a real translation.
* ``openai`` hosted models through the official SDK (``pip install -e ".[openai]"``). The
             API key is read from ``OPENAI_API_KEY`` here and never stored in Settings, logged
             or sent to the UI.
* ``aws``    reserved (architecture §3); not implemented yet, reported as unavailable.

This module is a leaf (no imports of the adapters at import time) so the adapters can
import :class:`ProviderError` from it.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from companion.config import Settings
    from companion.speech.language import LanguageID
    from companion.speech.stt import STT
    from companion.speech.tts import TTS
    from companion.translate.translator import Translator

log = logging.getLogger(__name__)


class ProviderError(Exception):
    """A provider stage failed in a way the user should see. Never fabricate success.

    ``message`` is user-facing copy (design system "Voice copy"): plain words, no codes.
    """

    def __init__(self, code: str, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass
class Providers:
    name: str
    stt: STT | None = None
    langid: LanguageID | None = None
    translator: Translator | None = None
    tts: TTS | None = None
    simulated: bool = False  # results are scripted, not real speech recognition/translation
    remote: bool = False  # audio and text leave the device
    unavailable_reason: str | None = None  # for logs only; never shown verbatim to residents

    @property
    def available(self) -> bool:
        return self.unavailable_reason is None


def build_providers(settings: Settings, openai_client: Any | None = None) -> Providers:
    """Build the adapters for ``settings.provider``. ``openai_client`` is for tests."""
    if settings.provider == "mock":
        from companion.speech.language import MockLanguageID
        from companion.speech.stt import MockSTT
        from companion.speech.tts import MockTTS
        from companion.translate.translator import MockTranslator

        delay = max(0.0, settings.mock_delay_s)
        return Providers(
            name="mock",
            stt=MockSTT(delay_s=delay),
            langid=MockLanguageID(),
            translator=MockTranslator(delay_s=delay),
            tts=MockTTS(),
            simulated=True,
        )

    if settings.provider == "openai":
        client = openai_client
        if client is None:
            key = os.environ.get("OPENAI_API_KEY", "").strip()
            if not key:
                return Providers(name="openai", remote=True,
                                 unavailable_reason="OPENAI_API_KEY is not set")
            try:
                from openai import AsyncOpenAI
            except ImportError:
                return Providers(name="openai", remote=True,
                                 unavailable_reason='the openai package is not installed '
                                                    '(pip install -e ".[openai]")')
            # Retries stay inside the per-request budget enforced by SpeechService.
            client = AsyncOpenAI(api_key=key, timeout=settings.provider_timeout_s, max_retries=1)

        from companion.speech.language import OpenAILanguageID
        from companion.speech.stt import OpenAISTT
        from companion.speech.tts import OpenAITTS
        from companion.translate.translator import OpenAITranslator

        return Providers(
            name="openai",
            stt=OpenAISTT(client, settings.stt_model),
            langid=OpenAILanguageID(client, settings.translation_model),
            translator=OpenAITranslator(client, settings.translation_model),
            tts=OpenAITTS(client, settings.tts_model, settings.tts_voice),
            remote=True,
        )

    return Providers(name=settings.provider, remote=True,
                     unavailable_reason=f"PROVIDER={settings.provider} is not implemented yet")


def provider_error_from_openai(exc: Exception) -> ProviderError:
    """Map an OpenAI SDK exception to user-facing copy. Logs the type/status, never content."""
    import openai

    status = getattr(exc, "status_code", None)
    log.warning("OpenAI request failed: %s (status %s)", type(exc).__name__, status)
    if isinstance(exc, openai.APITimeoutError):
        return ProviderError("network", "The service took too long to respond. Please try again.", 504)
    if isinstance(exc, openai.APIConnectionError):
        return ProviderError("network", "Cannot connect right now. Please try again.", 502)
    if isinstance(exc, (openai.AuthenticationError, openai.PermissionDeniedError)):
        return ProviderError(
            "unavailable",
            "The speech service isn't set up correctly. Ask the person who set up this device to check it.",
            503,
        )
    if isinstance(exc, openai.RateLimitError):
        return ProviderError("busy", "The speech service is busy. Please try again in a moment.", 503)
    if isinstance(exc, openai.BadRequestError):
        return ProviderError("bad_request", "The service couldn't use this recording. Please try again.", 422)
    if isinstance(exc, openai.APIError):
        return ProviderError("network", "The speech service had a problem. Please try again.", 502)
    return ProviderError("internal", "Something went wrong. Please try again.", 500)
