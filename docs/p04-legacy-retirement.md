# P04 legacy dispatch retirement — local candidate only

## Decision and scope

Roy approved continuing the agreed plan after the legacy bypass was identified. This change closes the **local source-level cloud entry points**, not a live deployment. It does not approve a provider, funding, new image capture, production exposure or the final renderer. The original P04, P03, real-image source and all prior handoffs remain preserved separately.

The selected B UI, default v3 route, controls, styles, saved data, fixed-layout proposals and image bytes are not edited. Default local rendering remains available. Old cloud-configured operation is intentionally no longer supported. We do not forge old renderer identities to keep an incompatible baked manifest current: source changes may invalidate legacy cache identities. No image is deleted, relabelled or regenerated.

## Closed entry points

| Surface                         | Behavior in this candidate                                                                                             | Proof                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Public frontend cloud selection | Production `cloudUrl` always returns null, ignoring build configuration and query overrides                            | Compiled-production test plus normal production build                                                   |
| Direct browser client / warm-up | Rejects remote URLs in every mode; rejects even loopback in production                                                 | Client construction and warm-call tests with a fetch spy                                                |
| Development transport           | Loopback-only protocol diagnostics retained; no production permission                                                  | Existing mocked transport tests now use loopback                                                        |
| Python gateway                  | Every work route returns typed, non-retryable `503 LEGACY_RENDER_DISABLED`; health reports `ok:false` without dispatch | In-process ASGI tests, both warm settings, configured origins, bake token, session spoofing and OPTIONS |
| Modal deployment entry          | Raises before importing Modal or declaring any app, volume, image or GPU class                                         | Import guard tests; no Modal CLI/provider call                                                          |
| Raw-scene local CLI             | Refuses before importing the HTTP server or workers                                                                    | Import guard test                                                                                       |
| Legacy bake command             | Nonzero refusal before networking, build, proxy, storage, pruning or manifest writes; help explains retirement         | Child-process tests, including prior override flags and unchanged manifest bytes                        |

The raw `api.create_app()` ASGI factory is also retired, including calls with `start=False`: it returns the same denial app without constructing a Service, worker or backing store. Factory-denial regressions cover default and configured settings.

There is **no environment flag, token, query parameter or operator switch** to re-enable the retired cloud gateway, deployment or bake command. Future real workers require a separately reviewed P04 adapter, not restoration of these unauthenticated interfaces. Lower-level geometry, serialization, protocol, CPU queue and renderer modules are retained for future private reuse; they are not a newly qualified service.

Development loopback diagnostics are not a sandbox against an operator running their own external proxy or arbitrary code. The production build cannot use them. The preserved private local real-image service remains separately gated and is not silently migrated to P04 or granted fresh render attempts.

## Verification and reproduction

Use Node 24.22.0 and the existing npm dependencies. The isolated verifier sanitizes child environments, does not load cloud credentials or `.env` files, and writes each run into a fresh handoff directory:

```sh
node scripts/p04-gate-verify.ts full
node scripts/p04-gate-verify.ts focused
node scripts/p04-gate-verify.ts checks
node scripts/p04-gate-verify.ts audit
```

This verifier is deliberately pinned to the session's isolated gate lane; the earlier `p04-verify.ts` still describes the preserved earlier lane. Test-source paths are rebased to the gate lane so watchdog child-process and boundary checks cannot accidentally test the old source. The handoff contains the authorized source-change list and exact results.

Python 3.11 gateway/queue tests need FastAPI 0.143.2, HTTPX 0.28.1, pytest 8.3.5, NumPy 1.26.4 and Pillow 11.3.0; Black 25.1.0 checks formatting. No Blender or Modal SDK is needed for these tests:

```sh
cd render-server
python -m pytest -q -p no:cacheprovider tests/test_gateway.py tests/test_modal_app.py tests/test_queue.py tests/test_server.py
python -m black --check fury_render/api.py fury_render/gateway.py fury_render/local.py modal_app.py tests/test_gateway.py tests/test_modal_app.py tests/test_queue.py tests/test_server.py
```

Historical gateway and raw HTTP server tests that required successful unauthenticated forwarding/warm allocation are replaced by denial tests; private protocol decompression, texture handling, RPC compression and cancellation coverage remain. No old unsafe behavior is retained just to keep those expectations green. Full Python rendering tests require Blender and are not run in this no-render phase.

## Still not proved

- No inspection, shutdown or replacement of any previously deployed endpoint. A local patch does not revoke a URL or stop a running host. Inventory and disable old deployments with separately authorized operational access before actual paid/public cutover.
- No real-provider stop/final-metering, independent deployed watchdog, cloud database durability, object/CDN authorization, signed private export URL, deletion or cost qualification.
- No new render, visual approval, measured GPU speed, physical-device benchmark or provider selection.
- P03 rights, product arrangements, fonts, strict Cycles conversion and actual completed-sample verification remain open.

Any future renderer comparison requires a separately approved experiment. Do not interpret test counts or historical planning budgets as permission to allocate resources.
