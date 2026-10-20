"""Deploy with FURY_NATIVE_PACKAGE pointing at the registered immutable package."""

import os
from pathlib import Path

import modal

APP_NAME = 'fury-render-library-dispatcher'
app = modal.App(APP_NAME)
runtime_overrides = {key: os.environ[key] for key in ('FURY_SERVICE_ORIGIN', 'FURY_GPU_IMAGE') if key in os.environ}
if runtime_overrides and len(runtime_overrides) != 2:
    raise RuntimeError('service-origin-and-gpu-image-must-be-pinned-together')
runtime_secrets = [modal.Secret.from_name('fury-render-library-dispatcher'),
                   modal.Secret.from_dict(runtime_overrides)]
volume = modal.Volume.from_name('fury-render-library-dispatch-journal', create_if_missing=True)
background_volume = modal.Volume.from_name('fury-render-library-background-journal', create_if_missing=True)
package = Path(os.environ['FURY_NATIVE_PACKAGE']).resolve()
source = Path(__file__).resolve().parent
image = (
    modal.Image.from_registry('node:24.22.0-bookworm-slim', add_python='3.11')
    .apt_install('ca-certificates')
    .add_local_dir(package, '/opt/fury', copy=True, ignore=['node_modules', '**/__pycache__'])
    .run_commands(
        'python -m pip install --require-hashes -r /opt/fury/render-server/on_demand/requirements-cpu.lock',
        'cd /opt/fury && npm ci --no-audit --no-fund',
        'cd /opt/fury && node --import ./scripts/native-render-register.mjs --input-type=module -e '
        '"import { EXECUTION_LIMITS, executionLimitsSchema } from \'./src/render-library/workerProtocol.ts\'; '
        'executionLimitsSchema.parse({ ...EXECUTION_LIMITS, maxActiveJobsPerSession: 2 });"',
    )
    .add_local_file(source / 'hosted_dispatcher.py', '/opt/host/hosted_dispatcher.py', copy=True)
    .add_local_file(source / 'hosted_transfer.py', '/opt/host/hosted_transfer.py', copy=True)
    .env({'PYTHONPATH': '/opt/host:/opt/fury/render-server', 'HOME': '/tmp',
          'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt'})
    .workdir('/opt/fury')
)


@app.function(
    image=image,
    schedule=modal.Period(seconds=15),
    secrets=runtime_secrets,
    volumes={'/state': volume},
    cpu=(2, 2), memory=(4096, 4096),
    timeout=3600, max_containers=1, retries=0, serialized=True, include_source=False,
    scaledown_window=2,
)
def dispatch():
    from hosted_dispatcher import run_dispatch
    return run_dispatch(volume, 'foreground', APP_NAME)


@app.function(
    image=image,
    schedule=modal.Period(seconds=15),
    secrets=runtime_secrets,
    volumes={'/state': background_volume},
    cpu=(2, 2), memory=(4096, 4096),
    timeout=3600, max_containers=1, retries=0, serialized=True, include_source=False,
    scaledown_window=2,
)
def dispatch_background():
    from hosted_dispatcher import run_dispatch
    return run_dispatch(background_volume, 'background', APP_NAME)


@app.function(image=image, volumes={'/state': volume}, timeout=60, serialized=True, include_source=False)
def initialize():
    from hosted_dispatcher import initialize_volume
    return initialize_volume(volume)


@app.function(image=image, volumes={'/state': background_volume}, timeout=60, serialized=True, include_source=False)
def initialize_background():
    from hosted_dispatcher import initialize_volume
    return initialize_volume(background_volume)
