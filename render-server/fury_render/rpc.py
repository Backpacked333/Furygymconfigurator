"""Runs one HTTP request through the render API in-process, for the private Modal method."""

from __future__ import annotations

import asyncio
import logging

import httpx

# Cancellations still being sent: the event loop holds only weak references to tasks.
_cancelling: set[asyncio.Future] = set()


def _sent(task: asyncio.Future):
    _cancelling.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logging.getLogger(__name__).warning(
            "Could not cancel an abandoned render: %r", task.exception()
        )


async def answer_or_cancel(call):
    """Waits for a spawned Modal call, and cancels it if the wait ends without its answer.

    A `.remote()` call stays queued after its caller stops waiting. While the GPU container is
    still being scheduled, every request the gateway gave up on (the browser asks again after
    each) would then be rendered once the GPU starts, for no one.
    """
    try:
        return await call.get.aio()
    except BaseException:
        # Not awaited: the cancellation that ended the wait could stop this too.
        task = asyncio.ensure_future(call.cancel.aio())
        _cancelling.add(task)
        task.add_done_callback(_sent)
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
