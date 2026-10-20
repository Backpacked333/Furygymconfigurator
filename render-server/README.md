# Legacy render modules — dispatch retired

This directory retains Fury's Blender geometry/material conversion, finishing, protocol and queue code for future private reuse. **It is not an operational or qualified P04 service.** The historical browser-to-Modal integration was unauthenticated beyond origin checks and did not participate in durable cost reservations or kill reconciliation.

## Entry points

- `modal_app.py` raises `LEGACY_RENDER_DISABLED` before importing Modal or declaring a GPU, app, volume or image. Do not run a deployment to test this.
- `fury_render.gateway.create_gateway` never invokes its dispatch callback. Work receives typed non-retryable 503, including warm/render/blob and preflight requests. Health reports `ok:false` and `paidExecutionAllowed:false`.
- `python -m fury_render.local` refuses before loading the HTTP server or renderer. There is no bypass flag.
- `npm run bake` and `npm run bake:quick` are retired at the repository level; neither changes retained images/manifests.

Direct `api.create_app()` is also a tombstone, with or without settings or the old `start` option; it never constructs `Service` or its stores. Lower-level queue/worker modules remain internal reuse code, not an approved service. Do not publish them, instantiate a GPU manually, or wrap the old raw-scene protocol in a new public endpoint. Any future adapter must use P04 admission and the reviewed provider contract.

Local retirement does not revoke a previously deployed endpoint, stop a host, confirm a final bill or prove remote deletion. An authorized operational inventory is still required before actual paid/public cutover. The selected UI and original source/capture handoffs are preserved.

## CPU-only boundary tests (no Blender or provider needed)

Use Python 3.11 with FastAPI 0.143.2, HTTPX 0.28.1, pytest 8.3.5, NumPy 1.26.4, Pillow 11.3.0 and Black 25.1.0. Install these in an isolated environment, **not** the full renderer `requirements.txt` for this no-render check.

```sh
cd render-server
python -m pytest -q -p no:cacheprovider tests/test_gateway.py tests/test_modal_app.py tests/test_queue.py tests/test_server.py
python -m black --check fury_render/api.py fury_render/gateway.py fury_render/local.py modal_app.py tests/test_gateway.py tests/test_modal_app.py tests/test_queue.py tests/test_server.py
```

These tests use in-process ASGI calls, fake dispatch and guarded imports. They do not prove real provider behavior. The former raw HTTP render tests are replaced by factory-denial coverage. Remaining low-level rendering tests require Blender and separate execution approval; they are not part of this boundary check. See [P04 retirement](../docs/p04-legacy-retirement.md) and [P04 provider decision](../docs/p04-provider-decision.md).
