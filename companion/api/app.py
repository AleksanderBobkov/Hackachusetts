"""FastAPI app: ``/ws`` live events + commands, REST for config/session (architecture §6).

Run: ``uvicorn companion.api.app:app --port 8000``
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from companion.api.hub import Hub
from companion.api.mock_script import iter_script
from companion.api.profiles import ProfileStore
from companion.api.profiles import router as profiles_router
from companion.config import Settings, load_settings
from companion.events import ErrorEvent, dump, parse_command
from companion.orchestrator import Orchestrator

log = logging.getLogger(__name__)


def build_orchestrator(settings: Settings, hub: Hub) -> Orchestrator:
    # Mode pipelines are registered here as phases land (translate → Phase 1, …).
    return Orchestrator(
        emit=hub.publish,
        pipelines={},
        mode=settings.default_mode,  # type: ignore[arg-type]
        max_record_s=settings.max_record_s,
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = load_settings()
    hub = Hub()
    app.state.settings = settings
    app.state.hub = hub
    app.state.orch = build_orchestrator(settings, hub)
    app.state.store = ProfileStore(Path(settings.data_dir))
    yield
    await app.state.orch.stop_all()


app = FastAPI(title="Companion backend", version="0.1.0", lifespan=lifespan)
app.include_router(profiles_router)

# ---------------------------------------------------------------------- UI (static, no build step)

REPO_ROOT = Path(__file__).resolve().parents[2]
UI_DIR = REPO_ROOT / "ui"
DESIGN_DIR = REPO_ROOT / "design"
_NO_CACHE = {"Cache-Control": "no-cache"}  # pick up UI edits on the next kiosk reload

app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")
app.mount("/design", StaticFiles(directory=DESIGN_DIR), name="design")


@app.get("/", include_in_schema=False)
async def resident_screen() -> FileResponse:
    """Resident companion screen (what the Pi kiosk opens)."""
    return FileResponse(UI_DIR / "companion.html", headers=_NO_CACHE)


@app.get("/setup", include_in_schema=False)
async def setup_screen() -> FileResponse:
    """Setup screen: person name + photos. Open from a laptop/phone on the same network."""
    return FileResponse(UI_DIR / "setup.html", headers=_NO_CACHE)


# ---------------------------------------------------------------------- REST


@app.get("/health")
async def health() -> dict[str, Any]:
    orch: Orchestrator = app.state.orch
    return {"ok": True, "state": orch.state, "mode": orch.mode, "turn_id": orch.turn_id}


@app.get("/config")
async def get_config() -> dict[str, Any]:
    settings: Settings = app.state.settings
    return settings.public()


@app.post("/session/reset")
async def session_reset() -> dict[str, Any]:
    await app.state.orch.reset_session()
    return {"ok": True}


# ---------------------------------------------------------------------- WebSocket


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, mock: int = 0, loop: int = 0, speed: float = 1.0) -> None:
    await ws.accept()
    if mock:
        await _run_mock(ws, loop=bool(loop), speed=speed)
        return

    hub: Hub = app.state.hub
    orch: Orchestrator = app.state.orch
    queue = hub.subscribe()

    async def sender() -> None:
        while True:
            await ws.send_json(await queue.get())

    send_task = asyncio.create_task(sender())
    try:
        await ws.send_json(dump(orch._state_event()))  # initial snapshot
        while True:
            raw = await ws.receive_text()
            try:
                cmd = parse_command(raw)
            except (ValidationError, ValueError) as exc:
                await ws.send_json(dump(ErrorEvent(code="invalid_command", message=_short(exc))))
                continue
            await orch.handle(cmd)
    except WebSocketDisconnect:
        pass
    finally:
        hub.unsubscribe(queue)
        send_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await send_task


async def _run_mock(ws: WebSocket, loop: bool, speed: float) -> None:
    """Scripted demo stream. Incoming commands are read and ignored (logged)."""

    async def drain() -> None:
        while True:
            log.info("mock ws ignoring command: %s", await ws.receive_text())

    drain_task = asyncio.create_task(drain())
    try:
        for delay, event in iter_script(loop=loop):
            if speed > 0 and delay > 0:
                await asyncio.sleep(delay / speed)
            if drain_task.done():  # client went away
                return
            await ws.send_json(dump(event))
        await ws.close()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        drain_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await drain_task


def _short(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors())[:300]
    return str(exc)[:300]
