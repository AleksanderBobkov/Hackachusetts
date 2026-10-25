"""Same-origin guard for writes and the event socket.

The API has no sign-in (README: it binds to 127.0.0.1). That still leaves one hole: any web
page open in a browser on the device could send it requests. Form posts and ``text/plain``
bodies need no CORS preflight, so another site could upload files, press controls or run
paid speech requests. Browsers always send ``Origin`` on those cross-site requests, so:

* POST/PUT/PATCH/DELETE with an ``Origin`` that isn't this server → 403.
* WebSocket handshakes with a foreign ``Origin`` → rejected (stops cross-site hijacking).

Requests without ``Origin`` (curl, a GPIO bridge script, tests) are unaffected.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def same_origin(origin: str, host: str) -> bool:
    try:
        parts = urlsplit(origin)
    except ValueError:
        return False
    return parts.scheme in {"http", "https"} and bool(host) and parts.netloc.lower() == host.lower()


class SameOriginMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope["type"]
        if kind == "websocket" or (kind == "http" and scope["method"] not in SAFE_METHODS):
            headers = dict(scope.get("headers") or [])
            origin = headers.get(b"origin")
            host = headers.get(b"host", b"").decode("latin-1")
            if origin is not None and not same_origin(origin.decode("latin-1"), host):
                if kind == "websocket":
                    await receive()  # websocket.connect
                    await send({"type": "websocket.close", "code": 1008})
                    return
                response = JSONResponse(
                    {"error": "Only this device's own screens can make changes.",
                     "detail": "Cross-origin request blocked."},
                    status_code=403,
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
