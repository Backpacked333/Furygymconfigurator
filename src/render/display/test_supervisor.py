"""Deterministic supervisor policy tests. No child spawn, browser, signal or real provision."""
import hashlib
import io
import json
import unittest
from contextlib import ExitStack
from itertools import count
from unittest.mock import Mock, patch
import supervisor


class SupervisorPolicy(unittest.TestCase):
    def setUp(self):
        self.permit = {'kind': 'operator-local-only', 'runId': 'test-only', 'paidExecutionAllowed': False,
                       'productionAllowed': False, 'expiresAt': 700000}
        self.lock = {'ownerPid': 123, 'runId': 'test-only', 'started': 100000,
                     'permitDigest': 'sha256:' + hashlib.sha256(json.dumps(self.permit, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}

    def provision(self, path):
        return {'permit': self.permit} if path.endswith('operator.json') else self.lock

    def test_independent_lifetime_and_same_operator_authority(self):
        with patch.object(supervisor, 'private_json', side_effect=self.provision), patch.object(supervisor.time, 'time', return_value=200):
            self.assertEqual(supervisor.admitted_lifetime(123, 600000), 500000)
            for change in ({'ownerPid': 999}, {'permitDigest': 'changed'}, {'runId': 'other'}):
                old = self.lock.copy()
                self.lock.update(change)
                with self.assertRaises(ValueError):
                    supervisor.admitted_lifetime(123, 600000)
                self.lock = old
        with patch.object(supervisor, 'private_json', side_effect=self.provision), patch.object(supervisor.time, 'time', return_value=701):
            with self.assertRaises(ValueError):
                supervisor.admitted_lifetime(123, 600000)

    def test_bare_supervisor_cannot_spawn_without_private_admission(self):
        paths = [supervisor.ROOT + 'renderer-profile-test', supervisor.ROOT + 'renderer-temp-test']
        with patch.object(supervisor.sys, 'argv', ['supervisor.py', *paths, '1000', '123']), patch.object(supervisor.os, 'getppid', return_value=123), patch.object(supervisor.os.path, 'realpath', side_effect=lambda value: value), patch.object(supervisor.os.path, 'isdir', return_value=True), patch.object(supervisor, 'private_json', side_effect=FileNotFoundError()) as provision, patch.object(supervisor.subprocess, 'Popen') as spawn:
            self.assertEqual(supervisor.main(), 70)
            provision.assert_called_once_with(supervisor.ROOT + 'private-display-operator/operator.json')
            spawn.assert_not_called()

    def test_kernel_pidfd_denial_prevents_browser_spawn(self):
        paths = [supervisor.ROOT + 'renderer-profile-test', supervisor.ROOT + 'renderer-temp-test']
        with patch.object(supervisor.sys, 'argv', ['supervisor.py', *paths, '1000', '123']), patch.object(supervisor.os, 'getppid', return_value=123), patch.object(supervisor.os.path, 'realpath', side_effect=lambda value: value), patch.object(supervisor.os.path, 'isdir', return_value=True), patch.object(supervisor, 'admitted_lifetime', return_value=1000), patch.object(supervisor.os, 'pidfd_open', side_effect=OSError('denied')), patch.object(supervisor.subprocess, 'Popen') as spawn:
            self.assertEqual(supervisor.main(), 70)
            spawn.assert_not_called()

    def test_owned_detached_and_adopted_descendants_but_not_unrelated_or_reused_pids(self):
        # pid -> parent, process group, start identity (all strings are inert synthetic /proc).
        records = {100: (1, 100, 'supervisor'), 101: (100, 101, 'browser'),
                   102: (101, 102, 'detached'), 103: (100, 103, 'adopted'), 200: (1, 200, 'unrelated')}

        def proc(path, **_kwargs):
            pid = int(path.split('/')[2])
            parent, group, identity = records[pid]
            data = ['0'] * 20
            data[0], data[1], data[2], data[19] = 'S', str(parent), str(group), identity
            return io.StringIO(str(pid) + ' (synthetic) ' + ' '.join(data))

        with patch.object(supervisor.os, 'listdir', return_value=list(map(str, records))), patch('builtins.open', side_effect=proc):
            self.assertEqual(set(supervisor.descendants(100)), {101, 102, 103})
            with patch.object(supervisor.os, 'getpid', return_value=100), patch.object(supervisor, 'parent_identity', side_effect=lambda pid: 'reused' if pid == 102 else records[pid][2]), patch.object(supervisor.os, 'pidfd_open', side_effect=lambda pid, _flags: pid + 1000), patch.object(supervisor.os, 'close') as close, patch.object(supervisor.signal, 'pidfd_send_signal') as send, patch.object(supervisor.os, 'kill', side_effect=AssertionError('numeric PID signal')), patch.object(supervisor.os, 'killpg', side_effect=AssertionError('numeric PGID signal')):
                supervisor.signal_descendants(supervisor.signal.SIGTERM)
                self.assertEqual([call.args[0] for call in send.call_args_list], [1101, 1103])
                self.assertEqual([call.args[0] for call in close.call_args_list], [1101, 1102, 1103])

    def test_exited_process_fd_is_closed_without_falling_back_to_numeric_signal(self):
        with patch.object(supervisor, 'descendants', return_value={101: 'owned'}), patch.object(supervisor, 'parent_identity', return_value='owned'), patch.object(supervisor.os, 'pidfd_open', return_value=9001), patch.object(supervisor.os, 'close') as close, patch.object(supervisor.signal, 'pidfd_send_signal', side_effect=ProcessLookupError()) as send, patch.object(supervisor.os, 'kill', side_effect=AssertionError('numeric PID signal')), patch.object(supervisor.os, 'killpg', side_effect=AssertionError('numeric PGID signal')):
            supervisor.signal_descendants(supervisor.signal.SIGKILL)
            send.assert_called_once_with(9001, supervisor.signal.SIGKILL)
            close.assert_called_once_with(9001)

    def startup_failure(self, failure):
        child = Mock(pid=55555)
        child.poll.return_value = 0
        selector = Mock()
        paths = [supervisor.ROOT + 'renderer-profile-INERT', supervisor.ROOT + 'renderer-temp-INERT']
        with ExitStack() as stack:
            def mock(target, **kwargs):
                return stack.enter_context(patch.object(*target, **kwargs))
            mock((supervisor.sys, 'argv'), new=['supervisor.py', *paths, '1000', '123'])
            mock((supervisor.os, 'getppid'), return_value=123)
            mock((supervisor.os.path, 'realpath'), side_effect=lambda value: value)
            mock((supervisor.os.path, 'isdir'), return_value=True)
            mock((supervisor, 'admitted_lifetime'), return_value=1000)
            mock((supervisor.os, 'pidfd_open'), return_value=77777)
            mock((supervisor.os, 'close'))
            mock((supervisor.signal, 'pidfd_send_signal'))
            mock((supervisor.signal, 'signal'))
            mock((supervisor.ctypes, 'CDLL'), return_value=Mock(prctl=Mock(return_value=0)))
            mock((supervisor, 'parent_identity'), return_value='INERT-parent')
            spawn = mock((supervisor.subprocess, 'Popen'), return_value=child)
            cleanup = mock((supervisor, 'signal_descendants'))
            mock((supervisor, 'descendants'), return_value={})
            mock((supervisor.os, 'waitpid'), side_effect=ChildProcessError())
            clock = count()
            mock((supervisor.time, 'monotonic'), side_effect=lambda: next(clock) / 100)
            mock((supervisor.time, 'sleep'))
            factory = mock((supervisor.selectors, 'DefaultSelector'), return_value=selector)
            printer = stack.enter_context(patch('builtins.print'))
            target = {'owned-pipe': printer, 'selector-create': factory,
                      'selector-register': selector.register, 'selector-close': selector.close}[failure]
            target.side_effect = BrokenPipeError('INERT startup failure')
            if failure == 'selector-close':
                self.assertEqual(supervisor.main(), 0)
            else:
                with self.assertRaises(BrokenPipeError):
                    supervisor.main()
            spawn.assert_called_once()
            self.assertEqual([call.args[0] for call in cleanup.call_args_list],
                             [supervisor.signal.SIGTERM, supervisor.signal.SIGKILL, supervisor.signal.SIGKILL])
            child.wait.assert_called_once_with(timeout=2)
            if failure in ('selector-register', 'selector-close'):
                selector.close.assert_called_once()

    def test_closed_owned_pipe_cannot_skip_cleanup(self):
        self.startup_failure('owned-pipe')

    def test_selector_creation_failure_cannot_skip_cleanup(self):
        self.startup_failure('selector-create')

    def test_selector_registration_failure_cannot_skip_cleanup(self):
        self.startup_failure('selector-register')

    def test_selector_close_failure_cannot_skip_cleanup(self):
        self.startup_failure('selector-close')


if __name__ == '__main__':
    unittest.main()
