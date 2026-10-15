"""The Blender worker: a child process that owns ``bpy`` and renders one request at a time.

Blender is not thread-safe and expects to run on its process's main thread, so it lives in its
own process and the web server talks to it over a pipe. A crash there costs the cached scene, not
the server: the next request starts a fresh worker.
"""

from __future__ import annotations

import os
import tempfile
import traceback
from multiprocessing.connection import Connection


def run(conn: Connection, blob_dir: str, device: str):
    from .blender import Studio, warm_up
    from .protocol import ProtocolError

    def blob_path(digest: str) -> str:
        return os.path.join(blob_dir, digest)

    studio = Studio(blob_path, device)
    warm = os.path.join(tempfile.gettempdir(), f"fury-warm-{os.getpid()}.exr")
    try:
        warm_up(studio, warm)
    finally:
        if os.path.exists(warm):
            os.remove(warm)
    conn.send({"ready": True, **studio.device})
    while True:
        try:
            message = conn.recv()
        except EOFError:
            return
        if message.get("op") == "stop":
            return
        try:
            stats = studio.render(message["request"], message["out"])
            conn.send({"ok": True, "stats": stats})
        except ProtocolError as error:
            conn.send({"ok": False, "status": 400, "error": str(error)})
        except Exception as error:  # noqa: BLE001 - report every failure to the caller
            traceback.print_exc()
            conn.send({"ok": False, "status": 500, "error": f"{type(error).__name__}: {error}"})
