"""Deploys the renderer on Modal. From this directory: ``modal deploy modal_app.py``.

One container with two L40S GPUs, switched off after a minute without requests. It renders the
path-traced spin a visitor orbits through: a few hundred frames per design, most of them while the
loading screen is up. Each GPU has a Blender process of its own and renders whole frames, side by
side. Compiled GPU kernels, uploaded scene data and finished frames are kept on a volume, so a
container starting cold reuses them.

Two GPUs, because Modal places a container on one machine and says more than two GPUs per container
usually means longer waits: an eight-L40S container sat "scheduling" for over ten minutes. More
GPUs can be asked for with FURY_GPU (say L40S:4), at that risk.
"""

import os

import modal

GPU = os.environ.get("FURY_GPU", "L40S:2")
GPU_COUNT = int(GPU.split(":")[1]) if ":" in GPU else 1
IDLE_SECONDS = int(os.environ.get("FURY_IDLE_SECONDS", "60"))

cache = modal.Volume.from_name("fury-render-cache", create_if_missing=True)

environment = {
    "FURY_DEVICE": "auto",
    # One renderer per GPU, each rendering its own frames.
    "FURY_WORKERS": str(GPU_COUNT),
    # Scene data (geometry, textures, sky) is content-addressed and shared by every visitor. Kept on
    # the volume, a container starting cold already has it, instead of the browser re-uploading
    # some 25 MB before the first view.
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


@app.cls(
    image=image,
    gpu=GPU,
    # A Blender process per GPU, and frames finished and encoded on the CPU while the GPUs render
    # the next ones.
    cpu=max(4, 2 * GPU_COUNT),
    memory=max(16384, 6144 * GPU_COUNT),
    volumes={"/fury-cache": cache},
    scaledown_window=IDLE_SECONDS,
    max_containers=1,
    timeout=900,
    # FURY_DENOISE=cpu at deploy time skips GPU denoising (it falls back by itself if it fails).
    secrets=[modal.Secret.from_dict({"FURY_DENOISE": os.environ.get("FURY_DENOISE", "auto")})],
)
# Frame requests wait in the renderer's own priority queue.
@modal.concurrent(max_inputs=64)
class Renderer:
    @modal.enter()
    def start(self):
        # Set cache paths after volume mounting, not while the image is being built.
        os.environ.update(environment)
        from fury_render.api import create_app

        self.web_app = create_app(start=False)
        info = self.web_app.state.service.start()
        print("renderer ready:", info)
        cache.commit()

    @modal.method()
    async def request(self, method: str, path: str, body: bytes, client: str):
        from fury_render.rpc import call_app

        # Images stay gzip-compressed all the way to the browser.
        return await call_app(self.web_app, method, path, body, client)


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
    scaledown_window=60,
    timeout=240,
    secrets=[
        modal.Secret.from_dict(
            {"FURY_ALLOWED_ORIGINS": os.environ.get("FURY_ALLOWED_ORIGINS", "(?!)")}
        ),
    ],
)
# Visitors keep several frame requests open while their spin renders.
@modal.concurrent(max_inputs=64)
@modal.asgi_app()
def gateway():
    from fury_render.gateway import create_gateway
    from fury_render.rpc import answer_or_cancel

    renderer = Renderer()

    async def dispatch(method, path, body, client):
        # Spawned rather than called, so a request the gateway stops waiting for is cancelled
        # instead of left queued for the GPU.
        call = await renderer.request.spawn.aio(method, path, body, client)
        return await answer_or_cancel(call)

    return create_gateway(dispatch)
