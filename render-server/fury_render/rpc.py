"""Runs one HTTP request through the render API in-process, for the private Modal method."""

from __future__ import annotations

import httpx


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
