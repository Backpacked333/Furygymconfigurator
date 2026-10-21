# Render library security boundaries [DISCOVERED 2026-10-20]

## Sessions and requests

- **Session cookie.** `__Host-fury-render-session` is HMAC-signed, HttpOnly, Secure, SameSite=Strict, and lasts 24 h.
- **CSRF.** The CSRF token is HMAC-signed and expires after 15 min. Requests must pass same-origin checks on both `Origin` and `Sec-Fetch-Site`.
- **Rate-limit identity.** Rate limits use a fixed network hash. `X-Forwarded-For` is deliberately not trusted. As a result, the per-network limit is effectively global.
- **Kill switches.** `RENDER_LIBRARY_ENABLED`, `DISPATCH_MODE` and the approval ID all gate requests. The approval itself expires and can be halted.

## Worker path

- **Worker auth.** Bearer token of at least 32 characters, compared in constant time. The dispatcher also sends a Vercel OIDC token header.
- **Uploads.** Uploads go to private staging through a signed URL. The server then verifies the SHA, the WebP signature and a full decode (1920×1500 cap) before publishing with put-if-absent.
- **Sandbox.** The GPU sandbox has network blocked by seccomp, which denies inet sockets and io_uring. It drops root and runs as UID 10001/10002.

## Browser

- **Live 360° viewer.** It is client-only and makes no network calls beyond static assets. There is no new attack surface.
