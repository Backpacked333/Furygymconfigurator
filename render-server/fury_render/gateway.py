"""CPU-only gateway in front of the GPU, which has no public HTTP endpoint.

There is no PIN: browsers on the allowed origins render directly. Requests are validated and
rate-limited here, before they can start the GPU.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .api import Bucket
from .protocol import HASH, MAX_BLOB_BYTES, ProtocolError, decompress, digest, validate_request

MAX_SCENE_BYTES = 32 << 20


async def read_body(request: Request, limit: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "Request too large")
        body.extend(chunk)
    return bytes(body)


def create_gateway(
    dispatch: Callable[[str, str, bytes, str], Awaitable[tuple[int, dict, bytes]]],
    origins: str | None = None,
) -> FastAPI:
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
            "x-queue-ms",
            "x-prepare-ms",
            "x-render-ms",
            "x-pack-ms",
        ],
    )
    # Global, not per caller: one gateway container is required.
    # Enough for a visitor plus the orbit views pre-rendered around them (one GPU renders them).
    render_limit = Bucket(40 / 60, 8)
    upload_limit = Bucket((1024 << 20) / 3600, MAX_BLOB_BYTES * 4)

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    async def health():
        return {"ok": True, "service": "gateway"}

    async def forward(request: Request, path: str, limit: int):
        client = request.client.host if request.client else "unknown"
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
                quality["timeLimit"] = min(15, float(quality.get("timeLimit", 15)))
                data["quality"] = quality
                body = json.dumps(data).encode()
            else:
                if digest(body) != path.rsplit("/", 1)[1]:
                    raise ValueError
                if not upload_limit.take("all", len(body)):
                    raise HTTPException(429, "Upload limit reached")
        except (ProtocolError, ValueError, TypeError, AttributeError, OSError, EOFError):
            raise HTTPException(400, "Invalid render request or blob") from None
        try:
            status, headers, content = await asyncio.wait_for(
                dispatch(request.method, path, body, client), timeout=180
            )
        except Exception:
            logging.getLogger(__name__).exception("Private GPU dispatch failed")
            raise HTTPException(503, "Cloud renderer unavailable; try again shortly") from None
        return Response(content, status_code=status, headers=headers)

    @app.post("/render")
    async def render(request: Request):
        return await forward(request, "/render", MAX_SCENE_BYTES)

    @app.put("/blobs/{blob_hash}")
    async def upload(blob_hash: str, request: Request):
        if not HASH.fullmatch(blob_hash):
            raise HTTPException(400, "Bad hash")
        return await forward(request, f"/blobs/{blob_hash}", MAX_BLOB_BYTES)

    return app
