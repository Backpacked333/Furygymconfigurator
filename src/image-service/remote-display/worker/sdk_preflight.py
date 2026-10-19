"""Metadata/AST only. Never import Modal, its config, a client, or any inspected code."""
import ast
import hashlib
import json
from pathlib import Path

AUDIT_VERSION = '1.1.4'
AUDIT_SOURCE_SHA256 = 'baa8a10faf6bfe18a7e1710604d5273bc8484e43fce7a1ef88bdd8d7157a07a9'
SDK = Path('/home/ubuntu/.local/share/uv/tools/modal/lib/python3.11/site-packages')


def inspect_sdk(root=SDK):
    source = (root / 'modal/sandbox.py').read_bytes()
    if len(source) > 1024 * 1024:
        raise ValueError('SDK source bound')
    metadata = (root / ('modal-' + AUDIT_VERSION + '.dist-info/METADATA')).read_text()
    version = next(line[9:] for line in metadata.splitlines() if line.startswith('Version: '))
    digest = hashlib.sha256(source).hexdigest()
    if version != AUDIT_VERSION or digest != AUDIT_SOURCE_SHA256:
        raise ValueError('SDK audit pin changed; no replacement launch pin is approved')
    module = ast.parse(source)
    cls = next(n for n in module.body if isinstance(n, ast.ClassDef) and n.name == '_Sandbox')
    create = next(n for n in cls.body if isinstance(n, ast.AsyncFunctionDef) and n.name == 'create')
    parameters = [n.arg for n in create.args.args + create.args.kwonlyargs]
    required = {'gpu', 'timeout', 'idle_timeout', 'block_network', 'cidr_allowlist', 'cpu', 'memory'}
    if not required <= set(parameters):
        raise ValueError('SDK public resource controls changed')
    return {
        'kind': 'cloud-display-sdk-offline-audit@1',
        'auditPin': 'modal==' + version,
        'sandboxSourceDigest': 'sha256:' + digest,
        'parameters': parameters,
        'explicitRuntimeSupported': 'runtime' in parameters,
        'launchPin': None,
        'dispatchAllowed': False,
        'blocker': 'sdk-runtime-incompatible',
        'firstConstraint': 'Audited Sandbox.create has no explicit runtime parameter; VM runtime cannot be selected through this public API.',
        'providerCalls': 0,
    }


if __name__ == '__main__':
    try:
        print(json.dumps(inspect_sdk(), sort_keys=True))
    except (OSError, ValueError, StopIteration, SyntaxError):
        print(json.dumps({'dispatchAllowed': False, 'blocker': 'sdk-runtime-incompatible', 'audit': 'pin-or-source-mismatch'}))
    # A successful audit of an incompatible SDK remains a failed launch preflight.
    raise SystemExit(2)
