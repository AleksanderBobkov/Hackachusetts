"""Runtime configuration: languages, speakers, provider, timeouts.

Sources (later wins): defaults → optional YAML file (``COMPANION_CONFIG``, default
``config.yaml`` if present) → environment variables. API keys are read by provider
adapters from the environment only and are never part of this object / sent to the UI.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import yaml

# Listening languages the screen offers (code → the language's own name). The Hear & Read
# prototype's list plus the seed pair (pl ↔ en). Input languages are not limited by this.
DEFAULT_OUTPUT_LANGUAGES: dict[str, str] = {
    "en": "English",
    "es": "Español",
    "pl": "Polski",
    "fr": "Français",
    "pt": "Português",
    "zh": "中文",
    "hi": "हिन्दी",
    "ar": "العربية",
    "ko": "한국어",
    "vi": "Tiếng Việt",
    "tl": "Tagalog",
}


@dataclass
class SpeakerConfig:
    label: str
    lang: str


@dataclass
class Settings:
    provider: str = "mock"  # mock | openai | aws
    default_mode: str = "translate"
    speakers: dict[str, SpeakerConfig] = field(
        default_factory=lambda: {
            "a": SpeakerConfig(label="Babcia", lang="pl"),
            "b": SpeakerConfig(label="Me", lang="en"),
        }
    )
    resident_lang: str = "pl"
    output_languages: dict[str, str] = field(
        default_factory=lambda: dict(DEFAULT_OUTPUT_LANGUAGES)
    )
    max_record_s: float = 60.0
    # Budget for one speech request (STT, translation or TTS). The screen gives up at 30 s,
    # so the backend answers with a readable `network` error first.
    provider_timeout_s: float = 25.0
    # Hosted models (PROVIDER=openai). Same defaults as the Hear & Read prototype.
    stt_model: str = "gpt-transcribe"
    translation_model: str = "gpt-6-luna"
    tts_model: str = "gpt-4o-mini-tts"
    tts_voice: str = "marin"
    mock_delay_s: float = 0.4  # PROVIDER=mock: simulated latency so UI states are visible
    db_path: str = "data/runtime/companion.db"
    data_dir: str = "data/runtime"  # people + photos for the setup/companion UI

    def public(self) -> dict[str, Any]:
        """Config safe to expose over REST (no secrets live here anyway)."""
        return asdict(self)


_ENV_OVERRIDES: dict[str, tuple[str, type]] = {
    "MAX_RECORD_S": ("max_record_s", float),
    "PROVIDER_TIMEOUT_S": ("provider_timeout_s", float),
    "MOCK_DELAY_S": ("mock_delay_s", float),
    "TRANSCRIBE_MODEL": ("stt_model", str),
    "TRANSLATION_MODEL": ("translation_model", str),
    "TTS_MODEL": ("tts_model", str),
    "TTS_VOICE": ("tts_voice", str),
    "COMPANION_DB": ("db_path", str),
    "COMPANION_DATA_DIR": ("data_dir", str),
}


def load_settings() -> Settings:
    s = Settings()
    path = Path(os.environ.get("COMPANION_CONFIG", "config.yaml"))
    if path.is_file():
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for key, value in raw.items():
            if key == "speakers":
                s.speakers = {k: SpeakerConfig(**v) for k, v in value.items()}
            elif key == "output_languages":
                s.output_languages = {str(k).lower(): str(v) for k, v in value.items()}
            elif hasattr(s, key):
                setattr(s, key, value)
    s.provider = os.environ.get("PROVIDER", s.provider).lower()
    if s.provider not in {"mock", "openai", "aws"}:
        raise ValueError(f"PROVIDER must be mock|openai|aws, got {s.provider!r}")
    for env, (attr, kind) in _ENV_OVERRIDES.items():
        if env in os.environ:
            setattr(s, attr, kind(os.environ[env]))
    return s
