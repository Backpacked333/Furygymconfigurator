"""Deploys the renderer on Modal. From this directory: ``modal deploy modal_app.py``.

Each visitor's render session gets a container with one L40S of its own, switched off after ten
minutes without requests (FURY_IDLE_SECONDS). It renders the path-traced spin the visitor orbits
through: their view and the angles nearest it while the loading screen is up, then the rest.
Compiled GPU kernels, uploaded scene data and finished frames are kept on a volume, so a container
starting cold reuses them.

Starting cold still takes 30 to 90 seconds (importing bpy, the OptiX kernel cache, OIDN warm-up),
most of a visitor's wait, and at a one-minute idle tail most visits were cold. The idle tail is
billed, so it is a trade: ten minutes keeps a visitor who comes back, or reloads, warm. The gateway
also starts a session's container early (GET /warm), and FURY_WARM=1 keeps one more renderer
running at all times (WarmRenderer) to answer a session's first requests while its own starts;
that is one L40S billed around the clock, so it is off by default.

One GPU per container, because Modal places a container's GPUs on one machine: an eight-L40S
container sat "scheduling" for over ten minutes, and a single L40S schedules in seconds. The
gateway runs at most FURY_MAX_SESSIONS sessions at once (gateway.py); FURY_GPU (say L40S:2) gives
each session more GPUs, at that risk.
"""

import os

import modal

GPU = os.environ.get("FURY_GPU", "L40S")
GPU_COUNT = int(GPU.split(":")[1]) if ":" in GPU else 1
IDLE_SECONDS = int(os.environ.get("FURY_IDLE_SECONDS", "600"))
# The gateway outlives the GPUs it admits. A session's place is in the gateway container's memory
# and lasts a minute longer than the GPU's idle tail (gateway.py PLACE_MARGIN); were the gateway to
# scale down sooner, the next one would start with no places taken and admit FURY_MAX_SESSIONS new
# sessions beside GPUs still on. Eleven idle minutes of a quarter CPU cost next to nothing.
GATEWAY_IDLE_SECONDS = IDLE_SECONDS + 60
MAX_SESSIONS = os.environ.get("FURY_MAX_SESSIONS", "3")
WARM = os.environ.get("FURY_WARM", "0") == "1"

cache = modal.Volume.from_name("fury-render-cache", create_if_missing=True)

environment = {
    "FURY_DEVICE": "auto",
    # One renderer per GPU, each rendering its own frames.
    "FURY_WORKERS": str(GPU_COUNT),
    # Scene data (geometry, textures, sky) is content-addressed and shared by every visitor. Kept on
    # the volume, a container starting cold already has what others uploaded before it started,
    # instead of the browser re-uploading some 25 MB before the first view.
    "FURY_BLOB_DIR": "/fury-cache/blobs",
    # Finished spin frames, shared by every visitor who sees the same design from the same angle.
    "FURY_FRAME_DIR": "/fury-cache/frames",
    # OptiX compiles its kernels on first use; keep them between containers.
    "OPTIX_CACHE_PATH": "/fury-cache/optix",
    "XDG_CACHE_HOME": "/fury-cache/xdg",
}

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "libx11-6",
        "libxi6",
        "libxxf86vm1",
        "libxfixes3",
        "libxrender1",
        "libxkbcommon0",
        "libsm6",
        "libgl1",
        "libegl1",
        "libgomp1",
    )
    # Keep in step with requirements.txt.
    .uv_pip_install("bpy==4.5.0", "fastapi[standard]==0.143.2", "numpy==1.26.4", "pillow==11.3.0")
    .add_local_python_source("fury_render")
)

app = modal.App(os.environ.get("FURY_APP_NAME", "fury-render"))

# One renderer container, as both classes below run it.
RENDERER = dict(
    image=image,
    gpu=GPU,
    # A Blender process per GPU, and frames finished and encoded on the CPU while the GPUs render
    # the next ones.
    cpu=max(4, 2 * GPU_COUNT),
    memory=max(16384, 6144 * GPU_COUNT),
    volumes={"/fury-cache": cache},
    scaledown_window=IDLE_SECONDS,
    # One container: per session, as each value of `session` is a function of its own, and for
    # the renderer kept running.
    max_containers=1,
    timeout=900,
    # FURY_DENOISE=cpu at deploy time skips GPU denoising (it falls back by itself if it fails).
    secrets=[modal.Secret.from_dict({"FURY_DENOISE": os.environ.get("FURY_DENOISE", "auto")})],
)


class RendererBase:
    """The render API (api.py) in a GPU container, called by the gateway over Modal."""

    @modal.enter()
    def start(self):
        # Set cache paths after volume mounting, not while the image is being built.
        os.environ.update(environment)
        from fury_render.api import create_app

        self.web_app = create_app(start=False)
        info = self.web_app.state.service.start()
        print("renderer ready:", info)
        cache.commit()
        self.reloaded = False

    @modal.method()
    async def request(self, method: str, path: str, body: bytes, client: str):
        from fury_render.rpc import call_app

        if WARM and path != "/health" and not self.reloaded:
            # This container sees the volume as it was when it started (/warm started it while
            # the page was still loading); a session's first render or upload here follows the
            # handover from the renderer kept running, which took the visitor's uploads meanwhile.
            # Reloaded, they are here too, instead of being asked for again (the 409 protocol).
            self.reloaded = True
            await cache.reload.aio()
        # Images stay gzip-compressed all the way to the browser.
        return await call_app(self.web_app, method, path, body, client)


@app.cls(**RENDERER)
# Frame requests wait in the renderer's own priority queue.
@modal.concurrent(max_inputs=64)
class Renderer(RendererBase):
    # The visitor's render session: every session runs in containers of its own.
    session: str = modal.parameter()


# modal 1.1.4's Cls.with_options takes no min_containers, so the renderer kept running is a class
# of its own, with no session: the gateway sends it every session's first requests. Deployed
# either way, so the gateway can always name it, but kept running only with FURY_WARM: without,
# it scales to zero like any other and costs nothing, and only the gateway's routing reaches it
# (a page naming its session is refused, gateway.py).
@app.cls(**RENDERER, min_containers=1 if WARM else None)
@modal.concurrent(max_inputs=64)
class WarmRenderer(RendererBase):
    pass


gateway_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("fastapi[standard]==0.143.2", "numpy==1.26.4")
    .add_local_python_source("fury_render")
)


@app.function(
    image=gateway_image,
    cpu=0.25,
    memory=2048,
    max_containers=1,
    scaledown_window=GATEWAY_IDLE_SECONDS,
    timeout=240,
    secrets=[
        modal.Secret.from_dict(
            {
                "FURY_ALLOWED_ORIGINS": os.environ.get("FURY_ALLOWED_ORIGINS", "(?!)"),
                "FURY_MAX_SESSIONS": MAX_SESSIONS,
                # As deployed: a session's place at the gateway outlives its GPU's idle tail and
                # its readiness ends before it, and the gateway routes through the renderer kept
                # running only when there is one.
                "FURY_IDLE_SECONDS": str(IDLE_SECONDS),
                "FURY_WARM": "1" if WARM else "0",
                # Lets `npm run bake` render export-tier stills (up to a minute each) through the
                # gateway; unset, every view is cut at 15 seconds.
                "FURY_BAKE_TOKEN": os.environ.get("FURY_BAKE_TOKEN", ""),
            }
        ),
    ],
)
# Visitors keep several frame requests open while their spin renders.
@modal.concurrent(max_inputs=64)
@modal.asgi_app()
def gateway():
    from fury_render.gateway import WARM_SESSION, create_gateway
    from fury_render.rpc import answer_or_cancel

    # One per session seen: binding a session to its GPU function happens once, on its first call.
    renderers: dict[str, Renderer] = {}
    warm_renderer = WarmRenderer()

    def renderer_for(session: str):
        if session == WARM_SESSION:
            return warm_renderer
        renderer = renderers.get(session)
        if renderer is None:
            if len(renderers) > 1000:
                renderers.clear()
            renderer = renderers[session] = Renderer(session=session)
        return renderer

    async def dispatch(method, path, body, client, session):
        # Spawned rather than called, so a request the gateway stops waiting for is cancelled
        # instead of left queued for the GPU.
        call = renderer_for(session).request.spawn.aio(method, path, body, client)
        return await answer_or_cancel(call)

    return create_gateway(dispatch)
