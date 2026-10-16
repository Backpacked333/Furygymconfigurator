"""Runs one HTTP request through the render API in-process, for the private Modal method."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable

import httpx

# Spawns and cancellations still in flight after their caller has gone: the event loop holds
# only weak references to tasks.
_pending: set[asyncio.Future] = set()


def _keep(task: asyncio.Future) -> asyncio.Future:
    _pending.add(task)
    task.add_done_callback(_pending.discard)
    return task


def _report(task: asyncio.Future):
    if not task.cancelled() and task.exception() is not None:
        logging.getLogger(__name__).warning(
            "Could not cancel an abandoned render: %r", task.exception()
        )


def _cancel(spawning: asyncio.Future):
    """Cancels a spawned call once spawning it has finished."""
    if spawning.cancelled() or spawning.exception() is not None:
        return
    _keep(asyncio.ensure_future(spawning.result().cancel.aio())).add_done_callback(_report)


async def answer_or_cancel(spawn: Awaitable):
    """Spawns a Modal call and waits for its answer, cancelling the call if the wait ends first.

    A `.remote()` call stays queued after its caller stops waiting. While the GPU container is
    still being scheduled, every request the gateway gave up on (the browser asks again after
    each) would then be rendered once the GPU starts, for no one.
    """
    spawning = _keep(asyncio.ensure_future(spawn))
    try:
        # Shielded: a call still being spawned when the wait ends is cancelled once it exists.
        call = await asyncio.shield(spawning)
        return await call.get.aio()
    except BaseException:
        # Not awaited: the cancellation that ended the wait could stop this too.
        spawning.add_done_callback(_cancel)
        raise


async def call_app(app, method: str, path: str, body: bytes, client: str):
    """Returns the status, headers and body exactly as the app sent them.

    Rendered images leave the API gzip-compressed (protocol.py). Reading the body raw keeps them
    that way through the gateway to the browser: inflating it here would send about four times
    the bytes (18 MB instead of under 5 MB for a 1920x1200 view).
    """
    transport = httpx.ASGITransport(app=app, client=(client, 0))
    async with httpx.AsyncClient(transport=transport, base_url="http://renderer") as session:
        async with session.stream(method, path, content=body) as response:
            content = b"".join([chunk async for chunk in response.aiter_raw()])
            # The gateway's response computes its own length.
            headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
            return response.status_code, headers, content
