"""Actual pinned Modal SDK path, fake transport only. Never contacts the provider."""

import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from on_demand.provider import one_create_rpc, verify_sdk


class SdkNoRetry(unittest.TestCase):
    def test_actual_sdk_accepted_then_disconnected_does_not_resend(self):
        import modal.sandbox as module
        from modal.image import _Image
        from grpclib import GRPCError, Status

        calls = []

        async def accepted_then_disconnect(request, **kwargs):
            calls.append(request)
            raise GRPCError(
                Status.UNAVAILABLE, "TEST DOUBLE: accepted then transport lost"
            )

        accepted_then_disconnect.name = "/modal.client.ModalClient/SandboxCreate"
        client = SimpleNamespace(
            stub=SimpleNamespace(SandboxCreate=accepted_then_disconnect)
        )
        app = SimpleNamespace(app_id="ap-offline-test", _client=client)
        image = _Image._new_hydrated("im-offline-test", client, None)
        image._is_another_app = True
        original = module.retry_transient_errors
        verify_sdk()
        with self.assertRaises(GRPCError):
            with one_create_rpc():
                asyncio.run(
                    module._Sandbox.create(
                        "python",
                        "-m",
                        "on_demand.sandbox_runner",
                        app=app,
                        image=image,
                        name="fury-offline-test",
                        gpu="L40S",
                        timeout=2100,
                        idle_timeout=2100,
                        block_network=True,
                    )
                )
        self.assertIs(module.retry_transient_errors, original)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].definition.name, "fury-offline-test")
        self.assertEqual(calls[0].definition.timeout_secs, 2100)
        self.assertFalse(calls[0].definition.secret_ids)
        self.assertFalse(calls[0].definition.volume_mounts)


if __name__ == "__main__":
    unittest.main()
