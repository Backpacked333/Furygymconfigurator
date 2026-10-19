"""Offline transfer tests; no Sandbox creation or provider requests."""

import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from hosted_transfer import HostedProvider, INPUT_CHUNK_BYTES, MAX_PACKAGE_BYTES, send_package
from on_demand.sandbox_runner import extract


class Writer:
    def __init__(self):
        self.output = bytearray()
        self.sizes = []
        self.eof = False

    def write(self, value):
        value = value.encode() if isinstance(value, str) else value
        self.sizes.append(len(value))
        self.output.extend(value)

    def drain(self):
        pass

    def write_eof(self):
        self.eof = True


class TransferTests(unittest.TestCase):
    def test_outdoor_sized_package_uses_40_data_flushes_not_2538(self):
        size = 41574400  # Observed failed Courtyard package size, not a production limit.
        with tempfile.TemporaryDirectory() as folder:
            package = Path(folder) / 'input.tar'
            package.write_bytes(b'x' * size)
            writer = Writer()
            writer.drain = Mock()
            self.assertEqual(send_package(writer, package), {'sent': True, 'bytes': size})
            header, payload = writer.output.split(b'\n', 1)
            self.assertEqual(json.loads(header), {'bytes': size})
            self.assertEqual(hashlib.sha256(payload).digest(), hashlib.sha256(package.read_bytes()).digest())
            self.assertEqual(writer.drain.call_count, 42)
            self.assertLessEqual(max(writer.sizes), INPUT_CHUNK_BYTES)
            self.assertTrue(writer.eof)

    def test_actual_pinned_sdk_writer_sends_bounded_indexed_messages(self):
        from modal.io_streams import StreamWriter
        requests = []

        async def capture(request, **_):
            requests.append(request)

        client = SimpleNamespace(stub=SimpleNamespace(SandboxStdinWrite=capture))
        writer = StreamWriter('sb-test', 'sandbox', client)
        with tempfile.TemporaryDirectory() as folder:
            package = Path(folder) / 'input.tar'
            package.write_bytes(b'a' * (INPUT_CHUNK_BYTES * 2 + 3))
            send_package(writer, package)
        self.assertEqual([r.index for r in requests], [1, 2, 3, 4, 5])
        self.assertEqual([len(r.input) for r in requests[1:-1]], [INPUT_CHUNK_BYTES, INPUT_CHUNK_BYTES, 3])
        self.assertTrue(requests[-1].eof)

    def test_receiver_accepts_identical_tar_bytes_despite_larger_write_batches(self):
        import tarfile
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            package = root / 'input.tar'
            body = b'{"views":[]}'
            with tarfile.open(package, 'w') as archive:
                entry = tarfile.TarInfo('job.json')
                entry.size = len(body)
                archive.addfile(entry, io.BytesIO(body))
            writer = Writer()
            send_package(writer, package)
            header, payload = writer.output.split(b'\n', 1)
            target = root / 'received'
            target.mkdir()
            extract(io.BytesIO(payload), target, json.loads(header)['bytes'])
            self.assertEqual((target / 'job.json').read_bytes(), body)

    def test_rejects_empty_or_oversized_package_before_writing(self):
        writer = Mock()
        for size in (0, MAX_PACKAGE_BYTES + 1):
            package = Mock()
            package.stat.return_value.st_size = size
            with self.assertRaisesRegex(RuntimeError, 'package-cap'):
                send_package(writer, package)
        writer.write.assert_not_called()

    def test_failed_send_is_not_retried_or_recreated(self):
        with tempfile.TemporaryDirectory() as folder:
            package = Path(folder) / 'input.tar'
            package.write_bytes(b'hello')
            writer = Writer()
            writer.drain = Mock(side_effect=TimeoutError('ambiguous'))
            with self.assertRaises(TimeoutError):
                send_package(writer, package)
            self.assertEqual(writer.drain.call_count, 1)
            self.assertFalse(writer.eof)

    def test_only_input_transport_command_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            provider = HostedProvider(Path(folder), Path(folder))
            for action in ('create', 'find', 'logs', 'poll', 'terminate'):
                self.assertEqual(provider.command(action, {})[2], 'on_demand.provider')
            self.assertEqual(provider.command('send', {})[2:4], ['hosted_transfer', 'send'])

    def test_same_subprocess_timeout_and_one_shot_call(self):
        with tempfile.TemporaryDirectory() as folder:
            package = Path(folder) / 'input.tar'
            package.write_bytes(b'hello')
            provider = HostedProvider(Path(folder), Path(folder))
            control = {'id': 'sb-test', 'package': str(package)}
            with patch('on_demand.dispatcher.Provider.call', side_effect=TimeoutError('private-details')) as call, patch('builtins.print') as log:
                with self.assertRaises(TimeoutError):
                    provider.call('send', control, timeout=180)
                call.assert_called_once_with('send', control, 180)
                self.assertNotIn('private-details', log.call_args.args[0])
                self.assertEqual(json.loads(log.call_args.args[0])['outcome'], 'failed')
