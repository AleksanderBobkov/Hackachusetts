"""People + photos for the setup screen, and the "active person" shown on the companion.

Scope follows the design system (.kiro/steering/design-system.md): a person is a **name**
plus **photos**. Nothing else. This is a small durable JSON + files store so the UI can be
built now; Phase 2's SQLite memory store (architecture §5) can replace it behind the same
routes.

The Companion / Care screen also shows short silent videos (MP4/WebM) in the slideshow. They
live in the same list as photos with ``type: "video"``. ``photos`` in responses stays
images-only so screens that only know photos keep working; ``media`` lists everything.

Guarantees the UI relies on:
* A 2xx response means the change is on disk (fsync + atomic rename) — the UI may say "Saved".
* ``Idempotency-Key`` on create/upload makes double clicks and retries safe (no duplicates).
* Stable IDs, never names, identify people and photos.
* Activating a person stops any turn in progress (via the orchestrator's ``set_mode``).
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from companion.events import LibraryEvent, Mode, SessionEvent, SetMode

MAX_NAME_LEN = 200
MAX_PHOTO_BYTES = 20 * 1024 * 1024  # UI downsizes before upload; this is a safety cap
MAX_VIDEO_BYTES = 50 * 1024 * 1024  # the screen allows 60 s, 1080p, 50 MB
MAX_UPLOAD_BYTES = max(MAX_PHOTO_BYTES, MAX_VIDEO_BYTES)
MAX_ITEMS_PER_PERSON = 50
MAX_IDEMPOTENCY_KEYS = 500
_ID_RE = re.compile(r"^[a-z]+-[0-9a-f]{12}$")
_IMAGE_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
_VIDEO_TYPES = {"mp4": "video/mp4", "webm": "video/webm"}
_MEDIA_TYPES = {**_IMAGE_TYPES, **_VIDEO_TYPES}
# MP4 major brands for video. HEIF/AVIF stills and M4A audio also start with `ftyp`.
_MP4_VIDEO_BRANDS = {b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1",
                     b"M4V ", b"M4VP", b"dash", b"mmp4", b"MSNV"}


def _sniff_image(data: bytes) -> str | None:
    """Return the file extension for JPEG/PNG/WebP content, else None (don't trust headers)."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def _sniff_video(data: bytes) -> str | None:
    """Return the file extension for MP4/WebM video content, else None."""
    if data[4:8] == b"ftyp" and data[8:12] in _MP4_VIDEO_BRANDS:
        return "mp4"
    if data[:4] == b"\x1a\x45\xdf\xa3" and b"webm" in data[:64]:  # EBML header, DocType webm
        return "webm"
    return None


def _kind(ext: str) -> str:
    return "video" if ext in _VIDEO_TYPES else "image"


def _new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(6)}"


def _clean_display_filename(name: str | None) -> str:
    """Original filename is display-only (alt text); never used as a path."""
    name = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    return name[:120] or "Photo"


def _write_durable(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


class ProfileStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.photo_dir = root / "photos"
        self.photo_dir.mkdir(parents=True, exist_ok=True)
        self._file = root / "profiles.json"
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {"profiles": {}, "active_profile_id": None, "idem": {}}
        if self._file.is_file():
            self._data.update(json.loads(self._file.read_text(encoding="utf-8")))

    # ------------------------------------------------------------- persistence

    def _save(self) -> None:
        payload = json.dumps(self._data, ensure_ascii=False, indent=1).encode("utf-8")
        _write_durable(self._file, payload)

    def _remember(self, key: str | None, value: str) -> None:
        if not key:
            return
        idem: dict[str, str] = self._data["idem"]
        idem[key] = value
        while len(idem) > MAX_IDEMPOTENCY_KEYS:
            idem.pop(next(iter(idem)))

    # ------------------------------------------------------------- views

    def _photo_public(self, photo: dict[str, Any]) -> dict[str, Any]:
        return {
            "photo_id": photo["photo_id"],
            "url": f"/photos/{photo['photo_id']}.{photo['ext']}",
            "name": photo["name"],
            "type": _kind(photo["ext"]),
            "bytes": photo.get("bytes", 0),
        }

    def _profile_public(self, profile: dict[str, Any]) -> dict[str, Any]:
        media = [self._photo_public(p) for p in profile["photos"]]
        return {
            "profile_id": profile["profile_id"],
            "display_name": profile["display_name"],
            "created_at": profile["created_at"],
            "example": bool(profile.get("example", False)),
            "photos": [m for m in media if m["type"] == "image"],
            "media": media,
            "active": profile["profile_id"] == self._data["active_profile_id"],
        }

    def _get(self, profile_id: str) -> dict[str, Any]:
        profile = self._data["profiles"].get(profile_id)
        if profile is None:
            raise HTTPException(404, "This person couldn't be found.")
        return profile

    # ------------------------------------------------------------- operations

    def list(self) -> dict[str, Any]:
        with self._lock:
            profiles = sorted(self._data["profiles"].values(), key=lambda p: p["created_at"])
            return {
                "profiles": [self._profile_public(p) for p in profiles],
                "active_profile_id": self._data["active_profile_id"],
            }

    def active(self) -> dict[str, Any] | None:
        with self._lock:
            pid = self._data["active_profile_id"]
            profile = self._data["profiles"].get(pid) if pid else None
            return self._profile_public(profile) if profile else None

    def glossary(self, profile_id: str) -> list[str]:
        """Names to keep intact in speech recognition and translation (architecture §4)."""
        with self._lock:
            profile = self._data["profiles"].get(profile_id)
            return [profile["display_name"]] if profile else []

    def create(
        self, display_name: str, idem_key: str | None, example: bool = False
    ) -> dict[str, Any]:
        with self._lock:
            existing = self._data["idem"].get(idem_key) if idem_key else None
            if existing and existing in self._data["profiles"]:
                return self._profile_public(self._data["profiles"][existing])
            profile = {
                "profile_id": _new_id("person"),
                "display_name": display_name,
                "created_at": time.time(),
                "photos": [],
            }
            if example:  # fictional sample person the screen shows on first run
                profile["example"] = True
            self._data["profiles"][profile["profile_id"]] = profile
            self._remember(idem_key, profile["profile_id"])
            self._save()
            return self._profile_public(profile)

    def rename(self, profile_id: str, display_name: str) -> dict[str, Any]:
        with self._lock:
            profile = self._get(profile_id)
            profile["display_name"] = display_name
            self._save()
            return self._profile_public(profile)

    def set_active(self, profile_id: str) -> dict[str, Any]:
        with self._lock:
            profile = self._get(profile_id)
            self._data["active_profile_id"] = profile_id
            self._save()
            return self._profile_public(profile)

    def add_photo(
        self, profile_id: str, data: bytes, filename: str | None, idem_key: str | None
    ) -> dict[str, Any]:
        ext = _sniff_image(data) or _sniff_video(data)
        if ext is None:
            raise HTTPException(415, "This file couldn't be added. Try a JPEG, PNG, WebP, MP4 or WebM file.")
        kind = _kind(ext)
        if kind == "image" and len(data) > MAX_PHOTO_BYTES:
            raise HTTPException(413, "This photo is too large. Try a smaller one.")
        if kind == "video" and len(data) > MAX_VIDEO_BYTES:
            raise HTTPException(413, "Videos must be 50 MB or smaller.")
        with self._lock:
            profile = self._get(profile_id)
            existing = self._data["idem"].get(idem_key) if idem_key else None
            if existing:
                for photo in profile["photos"]:
                    if photo["photo_id"] == existing:
                        return self._photo_public(photo)
            if len(profile["photos"]) >= MAX_ITEMS_PER_PERSON:
                raise HTTPException(
                    409, f"This person has {MAX_ITEMS_PER_PERSON} items. Remove an item before adding more."
                )
            photo = {
                "photo_id": _new_id(kind if kind == "video" else "photo"),
                "ext": ext,
                "name": _clean_display_filename(filename),
                "created_at": time.time(),
                "bytes": len(data),
            }
            _write_durable(self.photo_dir / f"{photo['photo_id']}.{ext}", data)
            profile["photos"].append(photo)
            self._remember(idem_key, photo["photo_id"])
            self._save()
            return self._photo_public(photo)

    def remove_photo(self, profile_id: str, photo_id: str) -> None:
        with self._lock:
            profile = self._get(profile_id)
            photo = next((p for p in profile["photos"] if p["photo_id"] == photo_id), None)
            if photo is None:
                raise HTTPException(404, "This photo couldn't be found.")
            profile["photos"].remove(photo)
            self._save()  # unserved first, then delete the file
            (self.photo_dir / f"{photo_id}.{photo['ext']}").unlink(missing_ok=True)

    def photo_path(self, photo_id: str) -> tuple[Path, str]:
        if not _ID_RE.match(photo_id):
            raise HTTPException(404, "Photo not found.")
        with self._lock:
            for profile in self._data["profiles"].values():
                for photo in profile["photos"]:
                    if photo["photo_id"] == photo_id:
                        path = self.photo_dir / f"{photo_id}.{photo['ext']}"
                        if path.is_file():
                            return path, _MEDIA_TYPES[photo["ext"]]
        raise HTTPException(404, "Photo not found.")


# ---------------------------------------------------------------------- routes


class NameBody(BaseModel):
    display_name: str = Field(max_length=MAX_NAME_LEN * 4)

    @field_validator("display_name")
    @classmethod
    def _non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter a name to continue")
        if len(value) > MAX_NAME_LEN:
            raise ValueError(f"Use a name under {MAX_NAME_LEN} characters")
        return value


class CreateBody(NameBody):
    example: bool = False  # fictional sample person; the screen labels it "Example person"


class ActivateBody(BaseModel):
    mode: Mode = "companion"


router = APIRouter()


def _store(request: Request) -> ProfileStore:
    return request.app.state.store


@router.get("/profiles")
async def list_profiles(request: Request) -> dict[str, Any]:
    return _store(request).list()


@router.get("/profiles/active")
async def active_profile(request: Request) -> dict[str, Any]:
    return {"profile": _store(request).active()}


@router.post("/profiles", status_code=201)
async def create_profile(
    body: CreateBody, request: Request, idempotency_key: str | None = Header(default=None)
) -> dict[str, Any]:
    profile = _store(request).create(body.display_name, idempotency_key, example=body.example)
    await request.app.state.hub.publish(LibraryEvent())
    return profile


@router.put("/profiles/{profile_id}")
async def rename_profile(profile_id: str, body: NameBody, request: Request) -> dict[str, Any]:
    profile = _store(request).rename(profile_id, body.display_name)
    await request.app.state.hub.publish(LibraryEvent())
    return profile


@router.post("/profiles/{profile_id}/activate")
async def activate_profile(
    profile_id: str, body: ActivateBody, request: Request
) -> dict[str, Any]:
    profile = _store(request).set_active(profile_id)
    # Switching person/mode is deliberate and stops the current turn (set_mode invalidates it).
    await request.app.state.orch.handle(SetMode(mode=body.mode))
    await request.app.state.hub.publish(SessionEvent(reason="profile"))
    return profile


@router.post("/profiles/{profile_id}/photos", status_code=201)
async def upload_photo(
    profile_id: str,
    request: Request,
    filename: str | None = None,
    idempotency_key: str | None = Header(default=None),
) -> dict[str, Any]:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "This file is too large. Try a smaller one.")
    data = await request.body()
    if not data:
        raise HTTPException(400, "This photo couldn't be added. Try again.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "This file is too large. Try a smaller one.")
    # The store checks the per-type limit (photos 20 MB, videos 50 MB) after sniffing.
    media = _store(request).add_photo(profile_id, data, filename, idempotency_key)
    await request.app.state.hub.publish(LibraryEvent())
    return media


@router.delete("/profiles/{profile_id}/photos/{photo_id}")
async def delete_photo(profile_id: str, photo_id: str, request: Request) -> dict[str, Any]:
    _store(request).remove_photo(profile_id, photo_id)
    await request.app.state.hub.publish(LibraryEvent())
    return {"ok": True}


@router.get("/photos/{filename}")
async def get_photo(filename: str, request: Request) -> FileResponse:
    photo_id = filename.rsplit(".", 1)[0]
    path, media_type = _store(request).photo_path(photo_id)
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "max-age=86400"})
