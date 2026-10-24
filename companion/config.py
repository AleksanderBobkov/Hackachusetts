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
    max_record_s: float = 60.0
    provider_timeout_s: float = 15.0
    db_path: str = "data/runtime/companion.db"
    data_dir: str = "data/runtime"  # people + photos for the setup/companion UI

    def public(self) -> dict[str, Any]:
        """Config safe to expose over REST (no secrets live here anyway)."""
        return asdict(self)


def load_settings() -> Settings:
    s = Settings()
    path = Path(os.environ.get("COMPANION_CONFIG", "config.yaml"))
    if path.is_file():
        raw = yaml.safe_load(path.read_text()) or {}
        for key, value in raw.items():
            if key == "speakers":
                s.speakers = {k: SpeakerConfig(**v) for k, v in value.items()}
            elif hasattr(s, key):
                setattr(s, key, value)
    s.provider = os.environ.get("PROVIDER", s.provider).lower()
    if s.provider not in {"mock", "openai", "aws"}:
        raise ValueError(f"PROVIDER must be mock|openai|aws, got {s.provider!r}")
    if "MAX_RECORD_S" in os.environ:
        s.max_record_s = float(os.environ["MAX_RECORD_S"])
    if "COMPANION_DB" in os.environ:
        s.db_path = os.environ["COMPANION_DB"]
    if "COMPANION_DATA_DIR" in os.environ:
        s.data_dir = os.environ["COMPANION_DATA_DIR"]
    return s
