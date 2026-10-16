"""Runs the render server locally: ``python -m fury_render.local [--port 8787] [--device cpu]``."""

from __future__ import annotations

import argparse
import os

import uvicorn


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--device", default="auto", help="auto (GPU if present) or cpu")
    args = parser.parse_args()
    os.environ["FURY_DEVICE"] = args.device
    from .api import create_app

    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
