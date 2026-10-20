import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from hosted_dispatcher import LaneService, drain, initialize_journal, worker_recipe
from on_demand.journal import Journal
from vast_host import LocalVastProvider, runtime_command

BUILD = 'a' * 64


class HostedDispatcherTests(unittest.TestCase):
    def test_worker_build_does_not_rewrite_customer_admission_recipe(self):
        original = {'releaseId': 'fury-native-five@2', 'workerBuildSha256': BUILD}
        active = {**original, 'workerBuildSha256': 'b' * 64}
        approval = {'policy': {'recipe': original}}
        database = Mock()
        self.assertEqual(worker_recipe(database, approval), original)
        database.read.assert_not_called()
        approval['active_worker_build_sha256'] = active['workerBuildSha256']
        database.read.return_value = [{'registration': active}]
        self.assertEqual(worker_recipe(database, approval), active)
        self.assertEqual(approval['policy']['recipe'], original)
        database.read.return_value = []
        with self.assertRaises(RuntimeError):
            worker_recipe(database, approval)

    def test_lanes_only_change_the_dispatch_rpc(self):
        for lane in ('foreground', 'background'):
            database, service = Mock(), Mock()
            wrapped = LaneService(service, database, lane, BUILD)
            values = {'dispatcherId': 'test:' + lane}
            wrapped.rpc('claim_dispatch', values)
            database.rpc.assert_called_once_with('claim_dispatch', {**values, 'lane': lane,
                                                                   'workerBuildSha256': BUILD})
            self.assertNotIn('lane', values)
            wrapped.rpc('reconcile_terminal', {'jobId': 'job'})
            service.rpc.assert_called_once_with('reconcile_terminal', {'jobId': 'job'})
            wrapped.claim('dispatch')
            service.claim.assert_called_once_with('dispatch')

    def test_invalid_lane_does_not_reserve_cpu_budget(self):
        with patch('hosted_dispatcher.Database') as database:
            with self.assertRaises(ValueError):
                drain(Path('/root'), Path('/work'), lane='unbounded')
            database.assert_not_called()

    def test_budget_pressure_reports_without_touching_the_journal(self):
        for may_stop in (False, True):
            database = Mock()
            database.rpc.side_effect = [False, may_stop]
            with patch('hosted_dispatcher.Database', return_value=database), \
                    patch('on_demand.journal.Journal') as journal:
                result = drain(Path('/root'), Path('/work'), lane='background')
            self.assertEqual(result, {'status': 'budget-exhausted' if may_stop else 'budget-busy',
                                      'lane': 'background'})
            self.assertEqual(database.rpc.call_args_list[1].args, ('halt_dispatcher_if_exhausted', {}))
            journal.assert_not_called()

    def test_journal_initialization_never_resets_existing_state(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder) / 'lane'
            initialize_journal(work)
            journal = Journal(work / 'dispatch.sqlite3')
            journal.save({'dispatch': {'dispatchId': 'kept'}, 'phase': 'creating'})
            journal.db.close()
            initialize_journal(work)
            restored = Journal(work / 'dispatch.sqlite3')
            self.assertEqual(restored.jobs(), [{'dispatch': {'dispatchId': 'kept'}, 'phase': 'creating'}])
            restored.db.close()

    def test_unacknowledged_settled_job_does_not_starve_new_work(self):
        stuck = {'phase': 'settled', 'dispatch': {'dispatchId': 'old'}}
        queued = {'phase': 'submitted', 'dispatch': {'dispatchId': 'new'}}
        journal = Mock()
        journal.jobs.return_value = [stuck]
        journal.pending.return_value = [('unacknowledged', None)]
        worker = Mock()
        worker.new_job.side_effect = [queued, None]

        def recover(row):
            if row is queued:
                row['phase'] = 'settled'

        worker.recover.side_effect = recover
        database = Mock()
        database.rpc.return_value = True
        recipe = {'workerBuildSha256': BUILD, 'gpuDevice': 'NVIDIA GeForce RTX 5090'}
        database.read.return_value = [{'policy': {'recipe': recipe}, 'enabled': True,
                                       'expires_at': '2099-01-01T00:00:00Z'}]
        env = {key: 'test' for key in ['FURY_DISPATCHER_ID', 'FURY_SERVICE_ORIGIN', 'FURY_WORKER_TOKEN',
                                     'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']}
        env['FURY_VAST_INSTANCE'] = '7'
        with patch.dict('os.environ', env), patch('hosted_dispatcher.Database', return_value=database), \
                patch('on_demand.journal.Journal', return_value=journal), \
                patch('hosted_dispatcher.deployment_token', return_value='test'), \
                patch('on_demand.dispatcher.Dispatcher', return_value=worker) as dispatcher, \
                patch('on_demand.transport.Service'):
            self.assertEqual(drain(Path('/root'), Path('/work'))['status'], 'processed')
            self.assertEqual(dispatcher.call_args.args[0].lane, 'foreground')
            policy = dispatcher.call_args.args[3]
            self.assertEqual(policy['dispatcherId'], 'test:foreground')
            self.assertEqual((policy['providerKind'], policy['instanceId']), ('vast-warm', '7'))
            self.assertIsInstance(dispatcher.call_args.args[1], LocalVastProvider)
            result = drain(Path('/root'), Path('/work'), lane='background')
            self.assertEqual(result['status'], 'idle')
            self.assertEqual(dispatcher.call_args.args[3]['dispatcherId'], 'test:background')
        self.assertEqual(worker.new_job.call_count, 2)
        worker.recover.assert_any_call(queued)
        self.assertEqual(sum(call.args[0] is stuck for call in worker.recover.call_args_list), 2)

    def test_unregistered_gpu_never_dispatches(self):
        database = Mock()
        database.rpc.return_value = True
        database.read.return_value = [{'policy': {'recipe': {'workerBuildSha256': BUILD}}, 'enabled': True,
                                       'expires_at': '2099-01-01T00:00:00Z'}]
        env = {'FURY_DISPATCHER_ID': 'test', 'FURY_VAST_INSTANCE': '7'}
        with patch.dict('os.environ', env), patch('hosted_dispatcher.Database', return_value=database), \
                patch('on_demand.journal.Journal'):
            with self.assertRaises(RuntimeError):
                drain(Path('/root'), Path('/work'))
        self.assertEqual(database.rpc.call_args_list[-1].args[1]['result'], 'unavailable')


class LocalVastProviderTests(unittest.TestCase):
    def test_runtime_runs_locally_against_the_registered_release(self):
        control = {'name': 'fury-job', 'timeout': 60, 'workerBuildSha256': BUILD, 'id': 'vast:7:fury-job',
                   'package': '/ignored'}
        with patch.dict(os.environ, {'FURY_VAST_INSTANCE': '7'}):
            command, env = runtime_command('poll', control)
        self.assertEqual(command[:4], ['/usr/local/bin/python', '-m', 'on_demand.vast_runtime', 'poll'])
        self.assertEqual(json.loads(base64.urlsafe_b64decode(command[4])),
                         {'name': 'fury-job', 'timeout': 60, 'workerBuildSha256': BUILD,
                          'instanceId': '7', 'id': 'vast:7:fury-job'})
        self.assertEqual(env['PYTHONPATH'], f'/opt/fury/releases/{BUILD}/render-server')
        self.assertNotIn('SUPABASE_SERVICE_ROLE_KEY', env)

    def test_rejects_unbound_actions_builds_and_instances(self):
        control = {'name': 'fury-job', 'timeout': 60, 'workerBuildSha256': BUILD}
        with patch.dict(os.environ, {'FURY_VAST_INSTANCE': '7'}):
            with self.assertRaises(ValueError):
                runtime_command('supervise', control)
            with self.assertRaises(ValueError):
                runtime_command('poll', {**control, 'workerBuildSha256': '../x'})
        with patch.dict(os.environ, {'FURY_VAST_INSTANCE': '0'}):
            with self.assertRaises(ValueError):
                runtime_command('poll', control)

    def test_provider_invokes_the_host_module(self):
        with tempfile.TemporaryDirectory() as folder:
            provider = LocalVastProvider(Path(folder), Path(folder))
            command = provider.command('find', {'name': 'fury-job'})
            self.assertEqual(command[1:4], ['-m', 'vast_host', 'find'])
            self.assertEqual(json.loads(Path(command[4]).read_text()), {'name': 'fury-job'})


if __name__ == '__main__':
    unittest.main()
