"""One-shot private Modal control process. Never imported by the web or GPU runtime."""

from contextlib import contextmanager
import json
from pathlib import Path
import sys

from .validation import CHUNK_BYTES, digest

SDK_VERSION = "1.1.4"
SDK_SOURCE = {
    "sandbox.py": "baa8a10faf6bfe18a7e1710604d5273bc8484e43fce7a1ef88bdd8d7157a07a9",
    "_utils/grpc_utils.py": "d5d4204ef7471bd2927f2553736e8784a8c69c80c9a5d0c4274c590119253ab5",
    "client.py": "932008541dc0cbe5ca262cd0ff5b9f50507ffc46a057430b987269c98c89ec9d",
}


def verify_sdk():
    import modal

    if modal.__version__ != SDK_VERSION:
        raise RuntimeError("unaudited-Modal-SDK")
    root = Path(modal.__file__).parent
    for path, checksum in SDK_SOURCE.items():
        if digest((root / path).read_bytes()) != checksum:
            raise RuntimeError("Modal-SDK-source-drift")


@contextmanager
def one_create_rpc():
    """Only use in a dedicated one-shot process; restore even when acceptance is ambiguous."""
    verify_sdk()
    import modal.sandbox as module
    from modal_proto.api_pb2 import SandboxCreateRequest

    original = module.retry_transient_errors

    async def no_create_retry(fn, *args, **kwargs):
        if args and isinstance(args[0], SandboxCreateRequest):
            kwargs.update(max_retries=0, attempt_timeout=150, total_timeout=150)
        return await original(fn, *args, **kwargs)

    module.retry_transient_errors = no_create_retry
    try:
        yield
    finally:
        module.retry_transient_errors = original


def main(action, control_file):
    verify_sdk()
    import modal

    control = json.loads(Path(control_file).read_text())
    if action == "create":
        # No app creation, image build, secrets, volume or Function execution here.
        app = modal.App.lookup(control["appName"], create_if_missing=False)
        image = modal.Image.from_id(control["imageId"])
        with one_create_rpc():
            sb = modal.Sandbox.create(
                "python",
                "-m",
                "on_demand.sandbox_runner",
                app=app,
                name=control["name"],
                image=image,
                gpu="L40S",
                cpu=(8, 8),
                memory=(32768, 32768),
                timeout=control["timeout"],
                idle_timeout=control["timeout"],
                workdir="/opt/fury",
                block_network=True,
                secrets=[],
                volumes={},
            )
        print(json.dumps({"id": sb.object_id}), flush=True)
        return
    if action == "find":
        try:
            sb = modal.Sandbox.from_name(control["appName"], control["name"])
        except modal.exception.NotFoundError:
            print(json.dumps({"id": None}), flush=True)
            return
    else:
        sb = modal.Sandbox.from_id(control["id"])
    if action == "find":
        print(json.dumps({"id": sb.object_id}), flush=True)
    elif action == "send":
        package = Path(control["package"])
        sb.stdin.write(json.dumps({"bytes": package.stat().st_size}) + "\n")
        sb.stdin.drain()
        with package.open("rb") as source:
            while chunk := source.read(CHUNK_BYTES):
                sb.stdin.write(chunk)
                sb.stdin.drain()
        sb.stdin.write_eof()
        sb.stdin.drain()
        print(json.dumps({"sent": True}), flush=True)
    elif action == "logs":
        for line in sb.stdout:
            if len(line) > 24576:
                raise RuntimeError("provider-frame-cap")
            print(line, end="", flush=True)
    elif action == "poll":
        print(json.dumps({"exitCode": sb.poll()}), flush=True)
    elif action == "terminate":
        sb.terminate()
        print(json.dumps({"requested": True}), flush=True)
    else:
        raise RuntimeError("unknown-provider-action")


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except Exception:
        # SDK errors may contain credential-bearing URLs. Only this safe code leaves the process.
        print('{"error":"provider-control-failed"}', file=sys.stderr)
        sys.exit(1)
