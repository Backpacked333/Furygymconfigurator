"""HTTP API of the render server.

    GET  /health          device and queue state
    PUT  /blobs/{sha256}  upload a blob (raw or gzip); stored by the hash of its raw content
    POST /render          render a view; 200 with a linear half-float image (protocol.py),
                          409 {"missing": [...]} when blobs must be uploaded first,
                          409 {"superseded": true} when the same session asked for a newer view

One worker renders at a time. A session's queued requests are dropped once it asks for a newer
view, so an orbiting visitor never waits behind views they have already left.
"""

from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import re
import tempfile
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import worker as worker_module
from .protocol import (
    HASH,
    IMAGE_FORMAT,
    MAX_BLOB_BYTES,
    ProtocolError,
    decompress,
    digest,
    required_blobs,
    validate_request,
)

# The configurator's production and preview deployments, plus local development.
DEFAULT_ORIGINS = (
    r"^https://furygymconfigurator[a-z0-9-]*\.vercel\.app$"
    r"|^http://(localhost|127\.0\.0\.1)(:\d+)?$"
)


@dataclass
class Settings:
    device: str = field(default_factory=lambda: os.environ.get("FURY_DEVICE", "auto"))
    blob_dir: str = field(
        default_factory=lambda: os.environ.get(
            "FURY_BLOB_DIR", os.path.join(tempfile.gettempdir(), "fury-blobs")
        )
    )
    blob_budget: int = field(
        default_factory=lambda: int(os.environ.get("FURY_BLOB_BUDGET_MB", "6000")) << 20
    )
    origins: str = field(
        default_factory=lambda: os.environ.get("FURY_ALLOWED_ORIGINS", DEFAULT_ORIGINS)
    )
    renders_per_minute: float = field(
        default_factory=lambda: float(os.environ.get("FURY_RENDERS_PER_MINUTE", "40"))
    )
    upload_mb_per_hour: float = field(
        default_factory=lambda: float(os.environ.get("FURY_UPLOAD_MB_PER_HOUR", "2000"))
    )
    max_queue: int = field(default_factory=lambda: int(os.environ.get("FURY_MAX_QUEUE", "6")))


class WorkerDied(RuntimeError):
    pass


class Worker:
    """The Blender child process and the pipe to it. Calls are serialized by the caller."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.process = None
        self.conn = None
        self.info: dict = {}
        self.lock = threading.Lock()

    def start(self) -> dict:
        with self.lock:
            if self.process is not None and self.process.is_alive():
                return self.info
            context = multiprocessing.get_context("spawn")
            parent, child = context.Pipe()
            process = context.Process(
                target=worker_module.run,
                args=(child, self.settings.blob_dir, self.settings.device),
                daemon=True,
            )
            process.start()
            child.close()
            if not parent.poll(600):
                process.kill()
                raise WorkerDied("the renderer did not start")
            try:
                self.info = parent.recv()
            except EOFError as error:
                raise WorkerDied("the renderer failed to start") from error
            self.process, self.conn = process, parent
            return self.info

    def call(self, message: dict) -> dict:
        try:
            self.conn.send(message)
            return self.conn.recv()
        except (EOFError, BrokenPipeError, OSError) as error:
            self.process = None
            raise WorkerDied("the renderer stopped") from error


class BlobStore:
    """Blobs as files named by their hash, pruned oldest first beyond a byte budget."""

    def __init__(self, directory: str, budget: int):
        self.directory = directory
        self.budget = budget
        os.makedirs(directory, exist_ok=True)

    def path(self, key: str) -> str:
        return os.path.join(self.directory, key)

    def has(self, key: str) -> bool:
        path = self.path(key)
        if os.path.exists(path):
            os.utime(path)
            return True
        return False

    def put(self, key: str, data: bytes):
        temp = self.path(f".{key}.{uuid.uuid4().hex}")
        with open(temp, "wb") as f:
            f.write(data)
        os.replace(temp, self.path(key))
        self.prune()

    def prune(self):
        entries = []
        total = 0
        for name in os.listdir(self.directory):
            if not HASH.match(name):
                continue
            stat = os.stat(self.path(name))
            entries.append((stat.st_mtime, stat.st_size, name))
            total += stat.st_size
        for _, size, name in sorted(entries):
            if total <= self.budget:
                break
            os.remove(self.path(name))
            total -= size


class Bucket:
    """Per-client token buckets."""

    def __init__(self, rate_per_second: float, capacity: float):
        self.rate = rate_per_second
        self.capacity = capacity
        self.state: dict[str, tuple[float, float]] = {}

    def take(self, key: str, amount: float = 1) -> bool:
        now = time.monotonic()
        tokens, last = self.state.get(key, (self.capacity, now))
        tokens = min(self.capacity, tokens + (now - last) * self.rate)
        if len(self.state) > 10000:
            self.state.clear()
        if tokens < amount:
            self.state[key] = (tokens, now)
            return False
        self.state[key] = (tokens - amount, now)
        return True


def client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class Service:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings()
        self.store = BlobStore(self.settings.blob_dir, self.settings.blob_budget)
        self.worker = Worker(self.settings)
        self.origins = re.compile(self.settings.origins)
        self.lock = asyncio.Lock()
        self.waiting = 0
        self.latest: dict[str, int] = {}
        self.renders = Bucket(
            self.settings.renders_per_minute / 60, self.settings.renders_per_minute / 2
        )
        upload_rate = self.settings.upload_mb_per_hour * (1 << 20) / 3600
        self.uploads = Bucket(upload_rate, MAX_BLOB_BYTES * 4)

    def start(self) -> dict:
        return self.worker.start()

    def fetchable(self, url: str) -> bool:
        match = re.match(r"^(https?://[^/]+)/", url)
        return bool(match and self.origins.match(match.group(1)))

    async def fetch(self, client: httpx.AsyncClient, key: str, url: str) -> bool:
        """Fetches a texture from the site that serves it, instead of asking for an upload."""
        try:
            response = await client.get(url)
            if response.status_code != 200 or len(response.content) > MAX_BLOB_BYTES:
                return False
            data = response.content
            if digest(data) != key:
                return False
            await asyncio.to_thread(self.store.put, key, data)
            return True
        except httpx.HTTPError:
            return False

    async def missing(self, scene: dict) -> list[str]:
        absent = [(key, url) for key, url in required_blobs(scene) if not self.store.has(key)]
        if not absent:
            return []
        remote = [(key, url) for key, url in absent if url and self.fetchable(url)]
        fetched: set[str] = set()
        if remote:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                results = await asyncio.gather(*(self.fetch(client, k, u) for k, u in remote))
            fetched = {key for (key, _), ok in zip(remote, results) if ok}
        return [key for key, _ in absent if key not in fetched]

    async def render(self, body: dict) -> Response:
        request = validate_request(body)
        session = str(body.get("session", ""))[:64]
        seq = int(body.get("seq", 0))
        if session:
            if len(self.latest) > 10000:
                self.latest.clear()
            self.latest[session] = max(seq, self.latest.get(session, seq))
        missing = await self.missing(request["scene"])
        if missing:
            return JSONResponse({"missing": missing}, status_code=409)
        if self.waiting >= self.settings.max_queue:
            return JSONResponse({"error": "busy"}, status_code=503)
        queued = time.perf_counter()
        self.waiting += 1
        try:
            async with self.lock:
                if session and self.latest.get(session, seq) > seq:
                    return JSONResponse({"superseded": True}, status_code=409)
                waited = time.perf_counter() - queued
                out = os.path.join(tempfile.gettempdir(), f"fury-{uuid.uuid4().hex}.bin")
                try:
                    try:
                        result = await asyncio.to_thread(
                            self.worker.call, {"op": "render", "request": request, "out": out}
                        )
                    except WorkerDied:
                        await asyncio.to_thread(self.worker.start)
                        return JSONResponse({"error": "renderer restarted"}, status_code=503)
                    if not result.get("ok"):
                        return JSONResponse(
                            {"error": result.get("error", "render failed")},
                            status_code=int(result.get("status", 500)),
                        )
                    with open(out, "rb") as f:
                        image = f.read()
                finally:
                    if os.path.exists(out):
                        os.remove(out)
        finally:
            self.waiting -= 1
        stats = result["stats"]
        return Response(
            image,
            media_type="application/octet-stream",
            headers={
                "Content-Encoding": "gzip",
                "X-Image-Format": IMAGE_FORMAT,
                "X-Image-Width": str(stats["width"]),
                "X-Image-Height": str(stats["height"]),
                "X-Queue-Ms": str(round(waited * 1000)),
                "X-Prepare-Ms": str(stats["prepareMs"]),
                "X-Render-Ms": str(stats["renderMs"]),
                "X-Pack-Ms": str(stats["packMs"]),
                "X-Device": str(stats["device"]),
                "Cache-Control": "no-store",
            },
        )


def create_app(settings: Settings | None = None, start: bool = True) -> FastAPI:
    service = Service(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if start:
            await asyncio.to_thread(service.start)
        yield

    app = FastAPI(title="Fury Studio renderer", lifespan=lifespan)
    app.state.service = service
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=service.settings.origins,
        allow_methods=["GET", "PUT", "POST"],
        allow_headers=["content-type"],
        expose_headers=[
            "x-image-format",
            "x-image-width",
            "x-image-height",
            "x-queue-ms",
            "x-prepare-ms",
            "x-render-ms",
            "x-pack-ms",
            "x-device",
        ],
        max_age=3600,
    )

    @app.get("/health")
    async def health():
        info = service.worker.info
        return {
            "ok": True,
            "device": info.get("device"),
            "gpus": info.get("gpus", []),
            "queue": service.waiting,
        }

    @app.put("/blobs/{key}")
    async def put_blob(key: str, request: Request):
        if not HASH.match(key):
            return JSONResponse({"error": "bad hash"}, status_code=400)
        body = await request.body()
        if len(body) > MAX_BLOB_BYTES:
            return JSONResponse({"error": "too large"}, status_code=413)
        if not service.uploads.take(client_key(request), len(body)):
            return JSONResponse({"error": "upload rate exceeded"}, status_code=429)
        try:
            data = await asyncio.to_thread(decompress, body)
        except OSError:
            return JSONResponse({"error": "bad gzip"}, status_code=400)
        if len(data) > MAX_BLOB_BYTES or digest(data) != key:
            return JSONResponse({"error": "hash mismatch"}, status_code=400)
        await asyncio.to_thread(service.store.put, key, data)
        return Response(status_code=204)

    @app.post("/render")
    async def render(request: Request):
        if not service.renders.take(client_key(request)):
            return JSONResponse({"error": "render rate exceeded"}, status_code=429)
        raw = await request.body()
        if len(raw) > 32 << 20:
            return JSONResponse({"error": "too large"}, status_code=413)
        try:
            body = json.loads(decompress(raw))
            return await service.render(body)
        except (ProtocolError, json.JSONDecodeError, OSError) as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    return app
