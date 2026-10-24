#!/usr/bin/env python3
"""Local audio interface with cloud transcription and text translation."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
import wave
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from openai import APIError, OpenAI

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
RECORDINGS = ROOT / "recordings"
INPUT_DEVICE = os.environ.get("AUDIO_INPUT_DEVICE", "plughw:CARD=II,DEV=0")
AUDIO_OUTPUT_DEVICE = os.environ.get("AUDIO_OUTPUT_DEVICE", "plughw:CARD=P10S,DEV=0")
MAX_RECORDING_SECONDS = 90
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
TRANSLATION_MODEL = os.environ.get("TRANSLATION_MODEL", "gpt-6-luna")
TTS_MODEL = os.environ.get("TTS_MODEL", "gpt-4o-mini-tts")
TTS_VOICE = os.environ.get("TTS_VOICE", "marin")
LANGUAGES = {
    "English": "en",
    "Spanish": "es",
    "French": "fr",
    "Portuguese": "pt",
    "Mandarin Chinese": "zh",
    "Hindi": "hi",
    "Arabic": "ar",
    "Korean": "ko",
    "Vietnamese": "vi",
    "Tagalog": "tl",
}
LANGUAGE_NAMES = {code: name for name, code in LANGUAGES.items()}
ROMANIZED_TARGETS = {"ar", "hi", "ko", "vi", "zh"}


class Recorder:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.process: subprocess.Popen[bytes] | None = None
        self.path: Path | None = None
        self.raw_path: Path | None = None
        self.started_at: float | None = None
        self.timer: threading.Timer | None = None
        self.stage = "ready"
        self.target_language = "Spanish"

    def start(self, target_language: str) -> dict:
        with self.lock:
            if target_language not in LANGUAGES:
                raise RuntimeError("Choose an output language and try again")
            if self.process and self.process.poll() is None:
                raise RuntimeError("Already recording")

            RECORDINGS.mkdir(exist_ok=True)
            self.path = RECORDINGS / f"speech-{datetime.now():%Y%m%d-%H%M%S}.wav"
            self.raw_path = self.path.with_suffix(".raw")
            command = [
                "arecord", "-D", INPUT_DEVICE, "-f", "S16_LE", "-r", "16000",
                "-c", "1", "-t", "raw", str(self.raw_path),
            ]
            try:
                self.process = subprocess.Popen(
                    command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
                )
            except FileNotFoundError as exc:
                raise RuntimeError("arecord is not installed on this Pi") from exc

            # Give ALSA a moment to reject an unavailable card before reporting success.
            time.sleep(0.15)
            if self.process.poll() is not None:
                error = (self.process.stderr.read() if self.process.stderr else b"").decode(errors="replace")
                self.process = None
                raise RuntimeError(error.strip() or f"Could not open {INPUT_DEVICE}")

            self.started_at = time.time()
            self.stage = "recording"
            self.target_language = target_language
            self.timer = threading.Timer(MAX_RECORDING_SECONDS, self.stop)
            self.timer.daemon = True
            self.timer.start()
            return {"status": "recording", "input_device": INPUT_DEVICE}

    def stop(self) -> dict:
        with self.lock:
            if not self.process or self.process.poll() is not None:
                self.process = None
                raise RuntimeError("There is no active recording")

            process, path, raw_path, started_at, target_language = self.process, self.path, self.raw_path, self.started_at, self.target_language
            self.process = None
            self.stage = "saving"
            if self.timer:
                self.timer.cancel()
                self.timer = None
            process.send_signal(signal.SIGINT)  # closes the WAV file cleanly

        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)

        seconds = round(max(0, time.time() - (started_at or time.time())), 1)
        if not path or not raw_path or not raw_path.exists():
            raise RuntimeError("The recording file could not be found")
        try:
            with raw_path.open("rb") as source, wave.open(str(path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(source.read())
        finally:
            raw_path.unlink(missing_ok=True)
        try:
            return {
                "status": "complete",
                "recording": path.name if path else None,
                "duration_seconds": seconds,
                **real_result(path, target_language, self.set_stage),
            }
        finally:
            self.set_stage("ready")

    def set_stage(self, stage: str) -> None:
        with self.lock:
            self.stage = stage

    def status(self) -> dict:
        with self.lock:
            return {
                "status": self.stage,
                "input_device": INPUT_DEVICE,
                "max_recording_seconds": MAX_RECORDING_SECONDS,
                "transcription": "live" if OPENAI_API_KEY else "not configured",
            }

    def clear(self) -> dict:
        with self.lock:
            path = self.path
            if path and path.exists():
                path.unlink()
            self.path = None
            self.stage = "ready"
        return {"status": "cleared"}


def api_error(error: Exception) -> RuntimeError:
    return RuntimeError(f"OpenAI request failed: {error}")


def api_client() -> OpenAI:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not configured for the local service")
    return OpenAI(api_key=OPENAI_API_KEY, timeout=60.0, max_retries=1)


def transcribe_audio(path: Path) -> dict:
    try:
        with path.open("rb") as audio:
            result = api_client().audio.transcriptions.create(
                model="gpt-transcribe",
                file=audio,
            )
        return result.model_dump()
    except APIError as exc:
        raise api_error(exc) from exc


def translation_with_pronunciation(
    original: str,
    source_language: str,
    target_language: str,
    target_code: str,
    keep_original: bool = False,
) -> tuple[str, str]:
    needs_pronunciation = target_code in ROMANIZED_TARGETS
    if keep_original:
        task = f"Keep the supplied {target_language} text unchanged."
    else:
        task = f"Translate the supplied text from {source_language} into {target_language}. Preserve meaning and tone."
    if needs_pronunciation:
        format_instruction = (
            "Return exactly two lines: first `SCRIPT: ` followed by the normal text in the target language; "
            "second `LATIN: ` followed by an easy-to-read Latin-alphabet pronunciation. "
            "For Vietnamese, write the second line without diacritics."
        )
    else:
        format_instruction = "Return only the requested text, with no labels or explanation."
    try:
        translated = api_client().responses.create(
            model=TRANSLATION_MODEL,
            reasoning={"effort": "none"},
            instructions=f"{task} {format_instruction}",
            input=original,
        )
    except APIError as exc:
        raise api_error(exc) from exc
    text = translated.output_text.strip()
    if not needs_pronunciation:
        return text, ""

    script, pronunciation = "", ""
    for line in text.splitlines():
        if line.startswith("SCRIPT:"):
            script = line.removeprefix("SCRIPT:").strip()
        elif line.startswith("LATIN:"):
            pronunciation = line.removeprefix("LATIN:").strip()
    return script or text, pronunciation


def speak_text(text: str, language: str) -> None:
    text = text.strip()
    if not text:
        raise RuntimeError("There is no text to speak")
    if len(text) > 4096:
        raise RuntimeError("That text is too long to speak")

    speech_dir = ROOT / "speech"
    speech_dir.mkdir(exist_ok=True)
    speech_path = speech_dir / f"speech-{datetime.now():%Y%m%d-%H%M%S-%f}.wav"
    try:
        with api_client().audio.speech.with_streaming_response.create(
            model=TTS_MODEL,
            voice=TTS_VOICE,
            input=text,
            instructions=(
                f"Speak {language} clearly, warmly, and at a relaxed pace for an older listener."
            ),
            response_format="wav",
        ) as response:
            response.stream_to_file(speech_path)
        playback = subprocess.run(
            ["aplay", "-D", AUDIO_OUTPUT_DEVICE, str(speech_path)],
            capture_output=True,
            text=True,
            timeout=90,
        )
        if playback.returncode:
            detail = playback.stderr.strip() or "The speaker could not play the generated audio"
            raise RuntimeError(detail)
    except APIError as exc:
        raise api_error(exc) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("The speaker took too long to finish") from exc
    finally:
        speech_path.unlink(missing_ok=True)


def real_result(path: Path, target_language: str = "Spanish", progress: Callable[[str], None] | None = None) -> dict:
    target_code = LANGUAGES.get(target_language)
    if not target_code:
        raise RuntimeError("Choose an output language and try again")
    if progress:
        progress("transcribing")
    transcription = transcribe_audio(path)
    original = transcription.get("text", "").strip()
    if not original:
        raise RuntimeError("No speech was detected. Move closer to the microphone and try again.")
    languages = transcription.get("languages") or []
    source_code = languages[0].get("code", "") if languages else transcription.get("language", "")
    source_code = source_code.lower().split("-", 1)[0]
    source_language = LANGUAGE_NAMES.get(source_code, source_code.upper() or "Detected language")

    if source_code == target_code:
        pronunciation = ""
        if target_code in ROMANIZED_TARGETS:
            if progress:
                progress("translating")
            _, pronunciation = translation_with_pronunciation(
                original, source_language, target_language, target_code, keep_original=True
            )
        return {
            "original": original,
            "original_romanization": pronunciation,
            "source_language": source_language,
            "translation": "",
            "translation_romanization": "",
            "target_language": target_language,
            "transcription_only": True,
            "is_mock": False,
        }

    if progress:
        progress("translating")
    translation, pronunciation = translation_with_pronunciation(
        original, source_language, target_language, target_code
    )
    if not translation:
        raise RuntimeError("Translation returned no text. Please try again.")

    return {
        "original": original,
        "original_romanization": "",
        "source_language": source_language,
        "translation": translation,
        "translation_romanization": pronunciation,
        "target_language": target_language,
        "transcription_only": False,
        "is_mock": False,
    }


recorder = Recorder()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} - {format % args}")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, body: dict, code: int = 200) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/api/status":
            self.send_json(recorder.status())
            return
        if self.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        endpoint = urlparse(self.path).path
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(content_length) or b"{}")
            if endpoint == "/api/record":
                self.send_json(recorder.start(body.get("target_language", "Spanish")), HTTPStatus.CREATED)
            elif endpoint == "/api/stop":
                self.send_json(recorder.stop())
            elif endpoint == "/api/clear":
                self.send_json(recorder.clear())
            elif endpoint == "/api/speak":
                speak_text(str(body.get("text", "")), str(body.get("language", "English")))
                self.send_json({"status": "complete"})
            else:
                self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except RuntimeError as exc:
            recorder.set_stage("ready")
            self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)


if __name__ == "__main__":
    address = os.environ.get("INTERFACE_HOST", "127.0.0.1")
    port = int(os.environ.get("INTERFACE_PORT", "8000"))
    print(f"Elder interface: http://{address}:{port}")
    print(f"Input device: {INPUT_DEVICE}")
    ThreadingHTTPServer((address, port), Handler).serve_forever()
