"""Deploy with FURY_NATIVE_PACKAGE pointing at the registered immutable package."""

import os
from pathlib import Path

import modal

APP_NAME = 'fury-render-library-dispatcher'
app = modal.App(APP_NAME)
volume = modal.Volume.from_name('fury-render-library-dispatch-journal', create_if_missing=True)
package = Path(os.environ['FURY_NATIVE_PACKAGE']).resolve()
source = Path(__file__).resolve().parent
image = (
    modal.Image.from_registry('node:24.22.0-bookworm-slim', add_python='3.11')
    .apt_install('ca-certificates')
    .add_local_dir(package, '/opt/fury', copy=True, ignore=['node_modules', '**/__pycache__'])
    .run_commands(
        'python -m pip install --require-hashes -r /opt/fury/render-server/on_demand/requirements-cpu.lock',
        'cd /opt/fury && npm ci --no-audit --no-fund',
    )
    .add_local_file(source / 'hosted_dispatcher.py', '/opt/host/hosted_dispatcher.py', copy=True)
    .env({'PYTHONPATH': '/opt/host:/opt/fury/render-server', 'HOME': '/tmp',
          'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt'})
    .workdir('/opt/fury')
)


@app.function(
    image=image,
    schedule=modal.Period(minutes=1),
    secrets=[modal.Secret.from_name('fury-render-library-dispatcher')],
    volumes={'/state': volume},
    cpu=(2, 2), memory=(4096, 4096),
    timeout=3600, max_containers=1, retries=0, serialized=True, include_source=False,
    scaledown_window=2,
)
def dispatch():
    from hosted_dispatcher import drain
    try:
        result = drain(volume)
        print(result)
        if result['status'] == 'budget-exhausted':
            import subprocess
            import sys
            # Stop paid coordination at the cap, not the Vercel app or its cached images.
            app_id = modal.App.lookup(APP_NAME, create_if_missing=False).app_id
            subprocess.run([sys.executable, '-m', 'modal', 'app', 'stop', app_id],
                           check=True, timeout=30, capture_output=True)
        return result
    except Exception as error:
        # Provider and HTTP exceptions can contain sensitive URLs/headers.
        import traceback
        locations = [(frame.name, frame.lineno) for frame in traceback.extract_tb(error.__traceback__)]
        print('dispatcher-recovery-pending', type(error).__name__, locations)
        return {'status': 'recovery-pending', 'error': type(error).__name__}


@app.function(image=image, volumes={'/state': volume}, timeout=60, serialized=True, include_source=False)
def initialize():
    from pathlib import Path
    from on_demand.journal import Journal
    volume.reload()
    Journal.initialize(Path('/state/dispatch.sqlite3'))
    volume.commit()
    return {'initialized': True}
