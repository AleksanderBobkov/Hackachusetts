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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from companion.api.hub import Hub
from companion.api.mock_script import iter_script
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
    yield
    await app.state.orch.stop_all()


app = FastAPI(title="Companion backend", version="0.1.0", lifespan=lifespan)


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
