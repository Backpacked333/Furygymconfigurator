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
    "FURY_BLOB_DIR": "/tmp/fury-blobs",
    # OptiX compiles its kernels on first use; keep them between containers.
    "OPTIX_CACHE_PATH": "/cache/optix",
    "XDG_CACHE_HOME": "/cache/xdg",
}
# A custom domain for the configurator can be allowed at deploy time.
if os.environ.get("FURY_ALLOWED_ORIGINS"):
    environment["FURY_ALLOWED_ORIGINS"] = os.environ["FURY_ALLOWED_ORIGINS"]

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
    .env(environment)
    .add_local_python_source("fury_render")
)

app = modal.App("fury-render")


@app.cls(
    image=image,
    gpu=GPU,
    cpu=4,
    memory=16384,
    volumes={"/cache": cache},
    scaledown_window=IDLE_SECONDS,
    max_containers=1,
    timeout=900,
)
@modal.concurrent(max_inputs=16)
class Renderer:
    @modal.enter()
    def start(self):
        from fury_render.api import create_app

        self.web_app = create_app(start=False)
        info = self.web_app.state.service.start()
        print("renderer ready:", info)
        cache.commit()

    @modal.asgi_app()
    def web(self):
        return self.web_app
