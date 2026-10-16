"""CPU-only PIN gateway. The GPU has no public HTTP endpoint."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .api import Bucket
from .protocol import HASH, MAX_BLOB_BYTES, ProtocolError, decompress, digest, validate_request

SESSION_SECONDS = 3600
MAX_SCENE_BYTES = 32 << 20


def pin_hash(pin: str) -> str:
    return hashlib.scrypt(pin.encode(), salt=b"fury-render-pin-v1", n=16384, r=8, p=1).hex()


async def read_body(request: Request, limit: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "Request too large")
        body.extend(chunk)
    return bytes(body)


def create_gateway(
    dispatch: Callable[[str, str, bytes, str], Awaitable[tuple[int, dict, bytes]]],
    expected_pin: str | None = None,
    signing_key: str | None = None,
    origins: str | None = None,
) -> FastAPI:
    expected_pin = expected_pin or os.environ["FURY_PIN_HASH"]
    signing_key = signing_key or os.environ["FURY_SESSION_KEY"]
    if len(expected_pin) != 128 or len(signing_key) < 32:
        raise ValueError("PIN hash and strong session key must be configured")
    key = signing_key.encode()
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=origins or os.environ["FURY_ALLOWED_ORIGINS"],
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["content-type", "authorization"],
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
    login_limit = Bucket(10 / 60, 5)
    # Enough for a visitor plus the orbit views pre-rendered around them (one GPU renders them).
    render_limit = Bucket(40 / 60, 8)
    upload_limit = Bucket((1024 << 20) / 3600, MAX_BLOB_BYTES * 4)

    def signature(payload: str) -> str:
        return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()

    def authorize(request: Request) -> str:
        header = request.headers.get("authorization", "")
        if not header.startswith("Bearer ") or len(header) > 256:
            raise HTTPException(401, "Unlock cloud rendering first")
        try:
            expires, nonce, supplied = header[7:].split(".")
            payload = f"{expires}.{nonce}"
            if not hmac.compare_digest(signature(payload), supplied) or int(expires) <= time.time():
                raise ValueError
        except ValueError:
            raise HTTPException(401, "Session expired; enter the PIN again") from None
        return nonce

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    async def health():
        return {"ok": True, "service": "pin-gateway"}

    @app.post("/auth")
    async def unlock(request: Request):
        # Global, not caller-controlled X-Forwarded-For. One gateway container is required.
        if not login_limit.take("all"):
            raise HTTPException(429, "Too many attempts. Wait a minute and try again.")
        try:
            body = json.loads(await read_body(request, 1024))
            pin = body.get("pin") if isinstance(body, dict) else None
            if not isinstance(pin, str) or len(pin) > 128:
                raise ValueError
        except (ValueError, UnicodeError):
            raise HTTPException(400, "Enter a valid PIN") from None
        hashed = await asyncio.to_thread(pin_hash, pin)
        if not hmac.compare_digest(hashed, expected_pin):
            raise HTTPException(401, "Incorrect PIN")
        expires = int(time.time()) + SESSION_SECONDS
        payload = f"{expires}.{secrets.token_hex(16)}"
        return {"token": f"{payload}.{signature(payload)}", "expiresAt": expires * 1000}

    async def forward(request: Request, path: str, limit: int):
        client = authorize(request)
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
                # Namespace supersession per authenticated session, not a caller's chosen ID.
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
