"""CPU-only gateway in front of the GPUs, which have no public HTTP endpoint.

There is no PIN: browsers on the allowed origins render directly. Requests are validated and
rate-limited here, before they can start a GPU. Each visitor's render session (the page's
`session` query parameter) is sent to a GPU of its own, and only so many sessions run at once.

A GPU container starting cold takes 30 to 90 seconds (importing bpy, the OptiX kernel cache, OIDN
warm-up), most of a visitor's wait. GET /warm starts the session's container while the page is
still loading, and with FURY_WARM a renderer kept running answers a session's first requests until
its own container is up.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .api import Bucket
from .protocol import HASH, MAX_BLOB_BYTES, ProtocolError, decompress, digest, validate_request

MAX_SCENE_BYTES = 32 << 20
SESSION = re.compile(r"[A-Za-z0-9_-]{8,64}")
# A page that names no session (one older than sessions) shares this one.
SHARED_SESSION = "shared-session"
# The renderer kept running with FURY_WARM, as the session name `dispatch` is given for it. The
# gateway's to route through, not a page's to name: a request naming it is refused.
WARM_SESSION = "shared-warm"
# How long a request may wait for its GPU, a cold start included, before the gateway gives up.
GPU_WAIT = 180
# A session's place outlives its GPU's idle tail (FURY_IDLE_SECONDS) by this much, and its
# readiness ends this much before the tail does. The gateway container itself stays up this much
# longer than the tail (modal_app.py): the places live in its memory, and a gateway starting
# afresh would admit new sessions beside GPUs still on.
PLACE_MARGIN = 60

log = logging.getLogger(__name__)


class Sessions:
    """The render sessions that have a GPU, at most `limit` at once.

    A session keeps its place while it keeps asking: until PLACE_MARGIN seconds after its GPU
    would have gone idle and off (`idle` seconds, FURY_IDLE_SECONDS, after its last request), so
    no more GPUs than places are ever on. While every place is taken, a new session is turned
    away, and its page traces on the visitor's own device instead. A session is "ready" from an
    answer of its own renderer until that renderer may be about to switch off; while it is not,
    with FURY_WARM, its requests go to the renderer kept running and its own is asked for /health.
    """

    def __init__(self, limit: int, idle: float = 600):
        self.limit = limit
        self.idle = idle
        self.seen: dict[str, float] = {}
        # When each session's own renderer last answered.
        self.ready: dict[str, float] = {}

    def has_room(self, session: str) -> bool:
        """Whether the session has its GPU, or one is free for it."""
        now = time.monotonic()
        for key, last in list(self.seen.items()):
            if now - last > self.idle + PLACE_MARGIN:
                # Its GPU has gone idle and off by now: it starts cold again, like a new session.
                del self.seen[key]
                self.ready.pop(key, None)
        return session in self.seen or len(self.seen) < self.limit

    def admit(self, session: str) -> bool:
        if not self.has_room(session):
            return False
        self.seen[session] = time.monotonic()
        return True

    def touch(self, session: str):
        if session in self.seen:
            self.seen[session] = time.monotonic()

    def is_ready(self, session: str) -> bool:
        answered = self.ready.get(session)
        # Its container's idle tail runs from its last answer, so a minute before the tail ends
        # (half of it, when the tail is shorter) the container may be stopping: better the
        # renderer kept running than a cold start. A place refreshed by /warm alone does not
        # keep a GPU on.
        horizon = max(self.idle - PLACE_MARGIN, self.idle / 2)
        return answered is not None and time.monotonic() - answered < horizon

    def mark_ready(self, session: str):
        # An answer to a session whose place has lapsed says nothing about its next, cold start.
        if session in self.seen:
            self.ready[session] = time.monotonic()


async def read_body(request: Request, limit: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "Request too large")
        body.extend(chunk)
    return bytes(body)


def create_gateway(
    dispatch: Callable[[str, str, bytes, str, str], Awaitable[tuple[int, dict, bytes]]],
    origins: str | None = None,
    max_sessions: int | None = None,
    warm: bool | None = None,
    idle_seconds: float | None = None,
) -> FastAPI:
    """Builds the gateway over `dispatch(method, path, body, client, session)`.

    `dispatch` calls the session's own GPU, or the renderer kept running when `session` is
    WARM_SESSION; `warm` (FURY_WARM) sends a session there until its own renderer has answered.
    `idle_seconds` (FURY_IDLE_SECONDS) is how long a session's GPU stays on without requests; its
    place here outlives that by PLACE_MARGIN.
    """
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=origins or os.environ["FURY_ALLOWED_ORIGINS"],
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["content-type"],
        expose_headers=[
            "x-image-format",
            "x-image-width",
            "x-image-height",
            "x-device",
            "x-denoise",
            "x-cache",
            "x-finish-ms",
            "x-traced-key",
            "x-queue-ms",
            "x-prepare-ms",
            "x-render-ms",
            "x-pack-ms",
            "x-fury-renderer",
        ],
    )
    # Global, not per caller: one gateway container is required. A visitor's spin is a few hundred
    # frame requests in the first minutes, many answered from the frame cache; each session's GPU
    # renders one frame at a time, and the session limit bounds how many GPUs there are.
    render_limit = Bucket(600 / 60, 240)
    upload_limit = Bucket((1024 << 20) / 3600, MAX_BLOB_BYTES * 4)
    # Per client: a page warms its session once or twice, a script would start GPUs for nothing.
    warm_limit = Bucket(6 / 60, 6)
    sessions = Sessions(
        max_sessions if max_sessions is not None else int(os.environ.get("FURY_MAX_SESSIONS", "3")),
        (
            idle_seconds
            if idle_seconds is not None
            else int(os.environ.get("FURY_IDLE_SECONDS", "600"))
        ),
    )
    warm_routing = warm if warm is not None else os.environ.get("FURY_WARM") == "1"
    # The health calls starting sessions' containers, held so the event loop does not drop them.
    warming: dict[str, asyncio.Task] = {}

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    async def health():
        return {"ok": True, "service": "gateway"}

    def client_of(request: Request) -> str:
        return request.client.host if request.client else "unknown"

    def session_of(request: Request) -> str:
        session = request.query_params.get("session", SHARED_SESSION)
        if not SESSION.fullmatch(session) or session == WARM_SESSION:
            raise HTTPException(400, "Bad render session")
        return session

    def full() -> JSONResponse:
        # Not "busy": asking again soon would not help, so the page renders on its own.
        return JSONResponse({"error": "Every cloud GPU is in use", "full": True}, status_code=503)

    def start(session: str, client: str):
        """Starts the session's container by asking its renderer for /health, in the background.

        Its answer marks the session ready. A failure is logged and nothing more: the session's
        requests find out for themselves, and a later request or /warm asks again.
        """
        if sessions.is_ready(session) or session in warming:
            return

        async def warm_up():
            try:
                status, _, _ = await asyncio.wait_for(
                    dispatch("GET", "/health", b"", client, session), timeout=GPU_WAIT
                )
                if status == 200:
                    sessions.mark_ready(session)
            except Exception:
                log.exception("Starting the renderer of session %s failed", session)
            finally:
                # The place is measured from the answer, as the container's idle tail is: from
                # the /warm call, it would lapse up to a cold start before the GPU goes off.
                sessions.touch(session)
                warming.pop(session, None)

        warming[session] = asyncio.create_task(warm_up())

    @app.get("/warm")
    async def warm_session(request: Request):
        """Starts the session's GPU while the page is still loading, without waiting for it."""
        client = client_of(request)
        session = session_of(request)
        if not warm_limit.take(client):
            raise HTTPException(429, "Warm limit reached")
        # The same place a render takes, and refreshed the same way.
        if not sessions.admit(session):
            return full()
        start(session, client)
        return JSONResponse({"warming": True, "renderer": "own"}, status_code=202)

    async def forward(request: Request, path: str, limit: int):
        client = client_of(request)
        session = session_of(request)
        if not sessions.has_room(session):
            return full()
        if request.method == "POST" and not render_limit.take("all"):
            raise HTTPException(429, "Render limit reached; try again shortly")
        raw = await read_body(request, limit)
        try:
            body = await asyncio.to_thread(decompress, raw, limit)
            if path == "/render":
                data = json.loads(body)
                if not isinstance(data, dict):
                    raise ValueError
                validate_request(data)
                # Supersession stays within one caller's own views.
                data["session"] = client + ":" + str(data.get("session", ""))[:24]
                quality = data.get("quality") or {}
                # A 360° panorama has several times a view's pixels.
                cap = 60 if (data.get("camera") or {}).get("panorama") else 15
                quality["timeLimit"] = min(cap, float(quality.get("timeLimit", 15)))
                data["quality"] = quality
                body = json.dumps(data).encode()
            else:
                if digest(body) != path.rsplit("/", 1)[1]:
                    raise ValueError
                if not upload_limit.take("all", len(body)):
                    raise HTTPException(429, "Upload limit reached")
        except (ProtocolError, ValueError, TypeError, AttributeError, OSError, EOFError):
            raise HTTPException(400, "Invalid render request or blob") from None
        # Only a valid request takes a place, so malformed ones cannot keep visitors off the GPUs.
        if not sessions.admit(session):
            return full()
        target, renderer = session, "own"
        if warm_routing and not sessions.is_ready(session):
            # Its own container is starting (asked to here if not by /warm); the renderer kept
            # running answers meanwhile.
            start(session, client)
            target, renderer = WARM_SESSION, "shared"
        try:
            status, headers, content = await asyncio.wait_for(
                dispatch(request.method, path, body, client, target), timeout=GPU_WAIT
            )
        except Exception:
            log.exception("Private GPU dispatch failed")
            raise HTTPException(503, "Cloud renderer unavailable; try again shortly") from None
        finally:
            # A long render keeps its session's place.
            sessions.touch(session)
        if renderer == "own":
            # Any answer at all means its container is up.
            sessions.mark_ready(session)
        return Response(
            content, status_code=status, headers={**headers, "X-Fury-Renderer": renderer}
        )

    @app.post("/render")
    async def render(request: Request):
        return await forward(request, "/render", MAX_SCENE_BYTES)

    @app.put("/blobs/{blob_hash}")
    async def upload(blob_hash: str, request: Request):
        if not HASH.fullmatch(blob_hash):
            raise HTTPException(400, "Bad hash")
        return await forward(request, f"/blobs/{blob_hash}", MAX_BLOB_BYTES)

    return app
