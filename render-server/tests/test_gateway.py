import asyncio
import gzip
import hashlib
import json
import time

import pytest
from fastapi.testclient import TestClient

from fury_render.gateway import create_gateway
from fury_render.protocol import ProtocolError, decompress
from scene_kit import Kit, request


@pytest.fixture
def gateway():
    calls = []

    async def dispatch(method, path, body, client, session):
        calls.append((method, path, body, client, session))
        return 200, {"x-device": "test"}, b"result"

    app = create_gateway(dispatch, r"^https://test\.example$")
    with TestClient(app) as client:
        yield client, calls


def test_forwards_renders_and_uploads_without_a_pin(gateway):
    client, calls = gateway
    assert client.get("/health").json()["ok"]
    assert client.post("/auth", json={"pin": "fury"}).status_code in (404, 405)
    response = client.post("/render", json=request(Kit().scene()))
    assert response.status_code == 200 and response.content == b"result"
    assert response.headers["cache-control"] == "no-store"
    assert len(calls) == 1
    data = b"geometry"
    assert (
        client.put(
            "/blobs/" + hashlib.sha256(data).hexdigest(), content=gzip.compress(data)
        ).status_code
        == 200
    )
    assert calls[-1][2] == data


def test_caps_render_time(gateway):
    client, calls = gateway
    body = request(Kit().scene())
    body["quality"] = {"timeLimit": 60}
    assert client.post("/render", json=body).status_code == 200
    forwarded = json.loads(calls[-1][2])
    assert forwarded["quality"]["timeLimit"] == 15


def test_bad_inputs_and_render_throttle(gateway, monkeypatch):
    import fury_render.api as api

    # A frozen clock: the bucket does not refill while the test sends its requests.
    monkeypatch.setattr(api.time, "monotonic", lambda: 1000.0)
    client, calls = gateway
    assert client.post("/render", content=b"[]").status_code == 400
    assert client.put("/blobs/" + "a" * 64, content=b"wrong").status_code == 400
    # The malformed request above took one of the burst of 240.
    body = request(Kit().scene())
    for _ in range(239):
        assert client.post("/render", json=body).status_code == 200
    assert client.post("/render", json=body).status_code == 429
    assert len(calls) == 239


def test_bounded_gzip_and_concatenated_members():
    assert decompress(gzip.compress(b"abc"), 3) == b"abc"
    with pytest.raises(ProtocolError):
        decompress(gzip.compress(b"x" * 10000), 100)
    with pytest.raises(ProtocolError):
        decompress(gzip.compress(b"ab") + gzip.compress(b"cd"), 3)
    with pytest.raises(ProtocolError):
        decompress(b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff\xff\xff", 100)


def test_gzip_bomb_never_dispatches(gateway, monkeypatch):
    import fury_render.gateway as module

    client, calls = gateway
    monkeypatch.setattr(module, "MAX_SCENE_BYTES", 100)
    assert client.post("/render", content=gzip.compress(b"x" * 1000)).status_code == 400
    assert calls == []


def test_texture_urls_are_never_fetched(tmp_path):
    import asyncio
    from fury_render.api import Service, Settings

    kit = Kit()
    scene = kit.scene()
    assert scene["textures"]
    for texture in scene["textures"].values():
        texture["url"] = "http://127.0.0.1:8787/private"
    service = Service(Settings(blob_dir=str(tmp_path)))
    missing = asyncio.run(service.missing(scene))
    assert all(texture["blob"] in missing for texture in scene["textures"].values())


def test_cors(gateway):
    client, calls = gateway
    for origin, expected in [("https://test.example", 200), ("https://evil.example", 400)]:
        response = client.options(
            "/render",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert response.status_code == expected
    assert calls == []


def test_images_stay_compressed_through_the_private_call():
    import asyncio

    from fastapi import FastAPI
    from fastapi.responses import Response

    from fury_render.rpc import call_app

    image = bytes(range(256)) * 4096
    packed = gzip.compress(image, mtime=0)
    renderer = FastAPI()

    @renderer.post("/render")
    async def render():
        return Response(packed, headers={"Content-Encoding": "gzip", "X-Image-Width": "2"})

    status, headers, content = asyncio.run(call_app(renderer, "POST", "/render", b"{}", "s"))
    assert status == 200 and content == packed
    assert headers["content-encoding"] == "gzip" and "content-length" not in headers

    async def dispatch(method, path, body, client, session):
        return await call_app(renderer, method, path, body, client)

    app = create_gateway(dispatch, r"^https://test\.example$")
    with TestClient(app) as client:
        response = client.post("/render", json=request(Kit().scene()))
    # The browser receives the compressed bytes and inflates them itself.
    assert response.headers["content-encoding"] == "gzip"
    assert int(response.headers["content-length"]) == len(packed)
    assert response.content == image and response.headers["x-image-width"] == "2"


def test_a_call_the_gateway_stops_waiting_for_is_cancelled():
    import asyncio
    from types import SimpleNamespace

    from fury_render.rpc import answer_or_cancel

    class Call:
        def __init__(self, answer=None):
            self.answer, self.cancelled = answer, False

            async def get():
                if self.answer is None:
                    await asyncio.Event().wait()  # Still waiting for a GPU to be placed.
                return self.answer

            async def cancel():
                self.cancelled = True

            self.get, self.cancel = SimpleNamespace(aio=get), SimpleNamespace(aio=cancel)

    async def spawn(call, accepted=None):
        if accepted:
            await accepted.wait()
        return call

    async def scenario():
        answered, stuck, late = Call((200, {}, b"frame")), Call(), Call()
        assert await answer_or_cancel(spawn(answered)) == (200, {}, b"frame")
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(answer_or_cancel(spawn(stuck)), 0.01)
        # The wait ends while Modal is still accepting the call: it is cancelled once it exists.
        accepted = asyncio.Event()
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(answer_or_cancel(spawn(late, accepted)), 0.01)
        assert not late.cancelled
        accepted.set()
        for _ in range(3):
            await asyncio.sleep(0)
        return answered.cancelled, stuck.cancelled, late.cancelled

    # Left queued, these calls would be rendered for no one once the GPU starts.
    assert asyncio.run(scenario()) == (False, True, True)


def test_each_render_session_has_a_gpu_of_its_own(gateway):
    client, calls = gateway
    body = request(Kit().scene())
    for session in ("visitor-one", "visitor-two"):
        assert client.post("/render", json=body, params={"session": session}).status_code == 200
    data = b"geometry"
    key = hashlib.sha256(data).hexdigest()
    client.put(f"/blobs/{key}", content=data, params={"session": "visitor-two"})
    assert [call[4] for call in calls] == ["visitor-one", "visitor-two", "visitor-two"]
    # A page from before sessions shares one; a malformed session is refused.
    client.post("/render", json=body)
    assert calls[-1][4] == "shared-session"
    count = len(calls)
    assert client.post("/render", json=body, params={"session": "a/b"}).status_code == 400
    # The renderer kept running is the gateway's to route through, not a page's to name.
    assert client.post("/render", json=body, params={"session": "shared-warm"}).status_code == 400
    assert len(calls) == count


def test_sessions_beyond_the_limit_render_on_their_own(monkeypatch):
    import fury_render.gateway as gateway_module

    calls = []

    async def dispatch(method, path, body, client, session):
        calls.append(session)
        return 200, {}, b"frame"

    clock = [1000.0]
    monkeypatch.setattr(gateway_module.time, "monotonic", lambda: clock[0])
    # A GPU's minute of idle tail, and a session's place for a minute longer.
    app = create_gateway(dispatch, r"^https://test\.example$", max_sessions=2, idle_seconds=60)
    body = request(Kit().scene())

    def post(session):
        return client.post("/render", json=body, params={"session": session})

    with TestClient(app) as client:
        # A malformed request takes no place.
        bad = client.post("/render", content=b"[]", params={"session": "session-zz"})
        assert bad.status_code == 400
        assert post("session-aa").status_code == 200
        assert post("session-bb").status_code == 200
        # Both GPUs are taken: a third session is told so, without starting a GPU.
        full = post("session-cc")
        assert full.status_code == 503 and full.json()["full"] is True
        assert calls == ["session-aa", "session-bb"]
        # A session that has its GPU keeps it.
        clock[0] += 100
        assert post("session-aa").status_code == 200
        # Once the other has been idle for two minutes, its place goes to the waiting session.
        clock[0] += 30
        assert post("session-cc").status_code == 200
        assert post("session-bb").json()["full"] is True
    assert calls == ["session-aa", "session-bb", "session-aa", "session-cc"]


def settled(calls, count):
    """Waits for dispatches made in the background, after a response, on the test client's loop."""
    for _ in range(400):
        if len(calls) >= count:
            break
        time.sleep(0.005)
    return len(calls)


def test_warm_starts_the_session_s_gpu_without_waiting_for_it(gateway):
    client, calls = gateway
    response = client.get("/warm", params={"session": "visitor-one"})
    assert response.status_code == 202
    assert response.json() == {"warming": True, "renderer": "own"}
    assert response.headers["cache-control"] == "no-store"
    assert settled(calls, 1) == 1
    assert calls[0] == ("GET", "/health", b"", "testclient", "visitor-one")
    # Once its renderer has answered, asking again starts nothing more.
    assert client.get("/warm", params={"session": "visitor-one"}).status_code == 202
    # A malformed or reserved session never reaches a GPU, and the gateway's own health check never
    # starts one.
    assert client.get("/warm", params={"session": "a/b"}).status_code == 400
    assert client.get("/warm", params={"session": "shared-warm"}).status_code == 400
    assert client.get("/health").json() == {"ok": True, "service": "gateway"}
    time.sleep(0.02)
    assert len(calls) == 1
    # The page asks from its own origin.
    preflight = client.options(
        "/warm",
        headers={"Origin": "https://test.example", "Access-Control-Request-Method": "GET"},
    )
    assert preflight.status_code == 200
    assert "GET" in preflight.headers["access-control-allow-methods"]


def test_warm_is_rate_limited_and_takes_a_place_like_a_render(monkeypatch):
    import fury_render.api as api
    import fury_render.gateway as gateway_module

    clock = [1000.0]
    monkeypatch.setattr(api.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(gateway_module.time, "monotonic", lambda: clock[0])
    calls = []

    async def dispatch(method, path, body, client, session):
        calls.append((method, path, session))
        return 200, {}, b"{}"

    app = create_gateway(dispatch, r"^https://test\.example$", max_sessions=1, idle_seconds=60)
    body = request(Kit().scene())
    with TestClient(app) as client:

        def warm(session):
            return client.get("/warm", params={"session": session})

        def post(session):
            return client.post("/render", json=body, params={"session": session})

        assert warm("session-aa").status_code == 202
        # The only place is taken: a second session is told so, and no GPU starts for it.
        full = warm("session-bb")
        assert full.status_code == 503 and full.json()["full"] is True
        assert post("session-bb").json()["full"] is True
        assert settled(calls, 1) == 1 and calls == [("GET", "/health", "session-aa")]
        # Six a minute per client, whatever they were answered (the clock stands still).
        for _ in range(4):
            assert warm("session-aa").status_code == 202
        assert warm("session-aa").status_code == 429
        assert warm("session-cc").status_code == 429
        # Warming refreshes the place, as a render would, and once the GPU's idle tail has
        # passed it starts the container again.
        clock[0] += 100
        assert warm("session-aa").status_code == 202
        assert settled(calls, 2) == 2
        clock[0] += 30
        assert post("session-bb").json()["full"] is True
        assert post("session-aa").status_code == 200
        # Once the place has been idle, it goes to the waiting session.
        clock[0] += 130
        assert post("session-bb").status_code == 200
    assert calls == [
        ("GET", "/health", "session-aa"),
        ("GET", "/health", "session-aa"),
        ("POST", "/render", "session-aa"),
        ("POST", "/render", "session-bb"),
    ]


def test_a_warming_session_s_place_runs_from_its_renderer_s_answer(monkeypatch):
    """The GPU's idle tail starts when its container is up, a cold start after the /warm call."""
    import fury_render.gateway as gateway_module

    clock = [1000.0]
    monkeypatch.setattr(gateway_module.time, "monotonic", lambda: clock[0])
    calls, booted = [], [False]

    async def dispatch(method, path, body, client, session):
        while not booted[0]:
            await asyncio.sleep(0.005)
        calls.append((method, path, session))
        return 200, {}, b"{}"

    app = create_gateway(dispatch, r"^https://test\.example$", max_sessions=1, idle_seconds=60)
    body = request(Kit().scene())
    with TestClient(app) as client:
        assert client.get("/warm", params={"session": "session-aa"}).status_code == 202
        # A slow cold start: the container answers 100 s after the call.
        clock[0] += 100
        booted[0] = True
        assert settled(calls, 1) == 1
        time.sleep(0.02)
        # 130 s after the call, 30 s after the answer: the GPU is on, so the place is held.
        clock[0] += 30
        full = client.post("/render", json=body, params={"session": "session-bb"})
        assert full.status_code == 503 and full.json()["full"] is True
        clock[0] += 100
        assert (
            client.post("/render", json=body, params={"session": "session-bb"}).status_code == 200
        )
    assert calls == [("GET", "/health", "session-aa"), ("POST", "/render", "session-bb")]


def test_a_renderer_kept_running_answers_until_the_session_s_own_is_up():
    calls, booted = [], [False]

    async def dispatch(method, path, body, client, session):
        if path == "/health":
            # The session's own container is still starting.
            while not booted[0]:
                await asyncio.sleep(0.005)
        calls.append((method, path, session))
        return 200, {"x-cache": "miss"}, b"frame"

    app = create_gateway(dispatch, r"^https://test\.example$", warm=True)
    body = request(Kit().scene())
    data = b"geometry"
    key = hashlib.sha256(data).hexdigest()
    with TestClient(app) as client:
        first = client.post(
            "/render",
            json=body,
            params={"session": "visitor-one"},
            headers={"Origin": "https://test.example"},
        )
        assert first.status_code == 200 and first.content == b"frame"
        assert first.headers["x-fury-renderer"] == "shared" and first.headers["x-cache"] == "miss"
        # The browser's bench panel may read which renderer answered.
        assert "x-fury-renderer" in first.headers["access-control-expose-headers"]
        upload = client.put(f"/blobs/{key}", content=data, params={"session": "visitor-one"})
        assert upload.headers["x-fury-renderer"] == "shared"
        assert [call[2] for call in calls] == ["shared-warm", "shared-warm"]
        booted[0] = True
        assert settled(calls, 3) == 3 and calls[-1] == ("GET", "/health", "visitor-one")
        later = client.post("/render", json=body, params={"session": "visitor-one"})
        assert later.headers["x-fury-renderer"] == "own"
        assert calls[-1] == ("POST", "/render", "visitor-one")
        # Another session starts the same way.
        other = client.post("/render", json=body, params={"session": "visitor-two"})
        assert other.headers["x-fury-renderer"] == "shared"
        assert ("POST", "/render", "shared-warm") in calls[-2:]


def test_a_session_s_readiness_ends_before_its_gpu_s_idle_tail(monkeypatch):
    """Its own renderer answers until it may be stopping; then the one kept running does again."""
    import fury_render.gateway as gateway_module

    clock = [1000.0]
    monkeypatch.setattr(gateway_module.time, "monotonic", lambda: clock[0])
    calls = []

    async def dispatch(method, path, body, client, session):
        calls.append((method, path, session))
        return 200, {}, b"frame"

    # A minute of idle tail: ready for half of it, as that is more than a minute less.
    app = create_gateway(dispatch, r"^https://test\.example$", warm=True, idle_seconds=60)
    body = request(Kit().scene())
    with TestClient(app) as client:

        def post():
            return client.post("/render", json=body, params={"session": "visitor-one"})

        def warm():
            return client.get("/warm", params={"session": "visitor-one"})

        assert post().headers["x-fury-renderer"] == "shared"
        assert settled(calls, 2) == 2 and ("GET", "/health", "visitor-one") in calls
        assert post().headers["x-fury-renderer"] == "own"
        clock[0] += 29
        # Each answer of its own renderer renews its readiness.
        assert post().headers["x-fury-renderer"] == "own"
        clock[0] += 31
        # The container may be switching off: the renderer kept running answers, and its own is
        # asked for /health again.
        assert post().headers["x-fury-renderer"] == "shared"
        assert settled(calls, 6) == 6 and calls[-2:].count(("GET", "/health", "visitor-one")) == 1
        assert post().headers["x-fury-renderer"] == "own"
        # /warm after a break starts it again too, instead of trusting a stale readiness.
        clock[0] += 31
        assert warm().status_code == 202
        assert settled(calls, 8) == 8 and calls[-1] == ("GET", "/health", "visitor-one")
        assert post().headers["x-fury-renderer"] == "own"


def test_without_a_renderer_kept_running_every_request_goes_to_the_session_s_own():
    calls = []

    async def dispatch(method, path, body, client, session):
        calls.append((method, path, session))
        return 200, {}, b"frame"

    app = create_gateway(dispatch, r"^https://test\.example$", warm=False)
    body = request(Kit().scene())
    with TestClient(app) as client:
        for _ in range(2):
            response = client.post("/render", json=body, params={"session": "visitor-one"})
            assert response.headers["x-fury-renderer"] == "own"
        time.sleep(0.02)
    assert calls == [("POST", "/render", "visitor-one")] * 2
