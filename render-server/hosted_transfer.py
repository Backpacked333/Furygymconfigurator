"""Bounded stdin transport, separate from the immutable pixel-producing package."""

import json
from pathlib import Path
import sys
import time

from on_demand.dispatcher import Provider
from on_demand.provider import verify_sdk

INPUT_CHUNK_BYTES = 1024 * 1024
MAX_PACKAGE_BYTES = 600 * 1024 * 1024


def send_package(writer, package):
    size = package.stat().st_size
    if not 0 < size <= MAX_PACKAGE_BYTES:
        raise RuntimeError('package-cap')
    writer.write(json.dumps({'bytes': size}) + '\n')
    writer.drain()
    sent = 0
    with package.open('rb') as source:
        while chunk := source.read(INPUT_CHUNK_BYTES):
            sent += len(chunk)
            if sent > size:
                raise RuntimeError('package-changed')
            writer.write(chunk)
            writer.drain()
    if sent != size:
        raise RuntimeError('package-changed')
    writer.write_eof()
    writer.drain()
    return {'sent': True, 'bytes': sent}


class HostedProvider(Provider):
    def command(self, action, control):
        command = super().command(action, control)
        if action == 'send':
            command[2] = 'hosted_transfer'
        return command

    def call(self, action, control, timeout=45):
        if action != 'send':
            return super().call(action, control, timeout)
        start = time.monotonic()
        outcome = 'failed'
        try:
            result = super().call(action, control, timeout)
            outcome = 'sent'
            return result
        finally:
            print(json.dumps({'event': 'render-library.input-transfer', 'outcome': outcome,
                              'sandboxId': control['id'],
                              'bytes': Path(control['package']).stat().st_size,
                              'elapsedSeconds': round(time.monotonic() - start, 3)}), flush=True)


def main(action, control_file):
    if action != 'send':
        raise RuntimeError('send-only')
    verify_sdk()
    import modal
    control = json.loads(Path(control_file).read_text())
    sandbox = modal.Sandbox.from_id(control['id'])
    print(json.dumps(send_package(sandbox.stdin, Path(control['package']))), flush=True)


if __name__ == '__main__':
    try:
        main(*sys.argv[1:])
    except Exception:
        print('{"error":"input-transfer-failed"}', file=sys.stderr)
        sys.exit(1)
