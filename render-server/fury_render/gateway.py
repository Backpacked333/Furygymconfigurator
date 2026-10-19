"""Non-dispatching tombstone for the retired unauthenticated raw-scene gateway."""

from collections.abc import Awaitable, Callable

from fastapi import FastAPI
from fastapi.responses import JSONResponse


def create_gateway(
    dispatch: (
        Callable[[str, str, bytes, str, str], Awaitable[tuple[int, dict, bytes]]] | None
    ) = None,
    origins: str | None = None,
    max_sessions: int | None = None,
    warm: bool | None = None,
    idle_seconds: float | None = None,
    bake_token: str | None = None,
) -> FastAPI:
    """Keep old callers fail-closed; no argument or environment variable enables dispatch."""
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def disabled(request, call_next):
        if request.method == "GET" and request.url.path == "/health":
            return JSONResponse(
                {"ok": False, "service": "retired-gateway", "paidExecutionAllowed": False},
                headers={"Cache-Control": "no-store"},
            )
        return JSONResponse(
            {
                "error": {
                    "code": "LEGACY_RENDER_DISABLED",
                    "message": "Legacy rendering is retired; private P04 admission is required.",
                    "retryable": False,
                }
            },
            status_code=503,
            headers={"Cache-Control": "no-store"},
        )

    return app
