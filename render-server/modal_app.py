"""Deploys the renderer on Modal. From this directory: ``modal deploy modal_app.py``.

One L40S GPU at most, switched off after five idle minutes. The first request after that waits
for a container to start (the browser keeps tracing locally meanwhile). Compiled GPU kernels are
kept on a volume so later cold starts skip compiling them.
"""

import os

import modal

GPU = os.environ.get("FURY_GPU", "L40S")
IDLE_SECONDS = int(os.environ.get("FURY_IDLE_SECONDS", "300"))

cache = modal.Volume.from_name("fury-render-cache", create_if_missing=True)

environment = {
    "FURY_DEVICE": "auto",
    # Scene data (geometry, textures, sky) is content-addressed and shared by every visitor. Kept on
    # the volume, a container starting cold already has it, instead of the browser re-uploading
    # some 25 MB before the first view.
    "FURY_BLOB_DIR": "/fury-cache/blobs",
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
    .uv_pip_install("bpy==4.5.0", "fastapi[standard]==0.143.2", "numpy==1.26.4")
    .add_local_python_source("fury_render")
)

app = modal.App(os.environ.get("FURY_APP_NAME", "fury-render"))


@app.cls(
    image=image,
    gpu=GPU,
    cpu=4,
    memory=16384,
    volumes={"/fury-cache": cache},
    scaledown_window=IDLE_SECONDS,
    max_containers=1,
    timeout=900,
    # FURY_DENOISE=cpu at deploy time skips GPU denoising (it falls back by itself if it fails).
    secrets=[modal.Secret.from_dict({"FURY_DENOISE": os.environ.get("FURY_DENOISE", "auto")})],
)
@modal.concurrent(max_inputs=16)
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
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def gateway():
    from fury_render.gateway import create_gateway

    renderer = Renderer()

    async def dispatch(method, path, body, client):
        return await renderer.request.remote.aio(method, path, body, client)

    return create_gateway(dispatch)
