import ast
import builtins
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from hosted_dispatcher import LaneService, drain, durable_journal, worker_recipe
from on_demand.journal import Journal


class HostedJournalTests(unittest.TestCase):
    def test_serialized_callbacks_do_not_import_the_unshipped_deployment_module(self):
        from modal._serialization import deserialize, serialize
        source = Path(__file__).resolve().parents[2] / 'deploy_dispatcher.py'
        functions = [node for node in ast.parse(source.read_text()).body if isinstance(node, ast.FunctionDef)]
        for node in functions:
            node.decorator_list = []
        module = ModuleType('deploy_dispatcher')
        module.__dict__.update(volume='foreground-volume', background_volume='background-volume',
                               APP_NAME='fury-render-library-dispatcher')
        imported = builtins.__import__

        def remote_import(name, *args, **kwargs):
            if name == module.__name__:
                raise ModuleNotFoundError(name)
            return imported(name, *args, **kwargs)

        with patch.dict(sys.modules, {module.__name__: module}):
            exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), module.__dict__)
            callbacks = []
            for name in ('dispatch', 'dispatch_background', 'initialize', 'initialize_background'):
                callback = module.__dict__[name]
                module.__dict__[name] = 'modal-decorated-function'
                callbacks.append(serialize(callback))
            with patch('builtins.__import__', side_effect=remote_import), \
                    patch('hosted_dispatcher.run_dispatch', return_value={'status': 'idle'}) as dispatch, \
                    patch('hosted_dispatcher.initialize_volume', return_value={'initialized': True}) as initialize:
                results = [deserialize(payload, None)() for payload in callbacks]
            self.assertEqual(results, [{'status': 'idle'}, {'status': 'idle'},
                                       {'initialized': True}, {'initialized': True}])
            self.assertEqual([call.args for call in dispatch.call_args_list], [
                ('foreground-volume', 'foreground', module.APP_NAME),
                ('background-volume', 'background', module.APP_NAME)])
            self.assertEqual([call.args for call in initialize.call_args_list],
                             [('foreground-volume',), ('background-volume',)])

    def test_worker_build_does_not_rewrite_customer_admission_recipe(self):
        original = {'releaseId': 'fury-native-five@2', 'workerBuildSha256': 'a' * 64}
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
            wrapped = LaneService(service, database, lane, 'a' * 64)
            values = {'dispatcherId': 'test:' + lane}
            wrapped.rpc('claim_dispatch', values)
            database.rpc.assert_called_once_with('claim_dispatch', {**values, 'lane': lane,
                                                                   'workerBuildSha256': 'a' * 64})
            self.assertNotIn('lane', values)
            wrapped.rpc('reconcile_terminal', {'jobId': 'job'})
            service.rpc.assert_called_once_with('reconcile_terminal', {'jobId': 'job'})
            wrapped.claim('dispatch')
            service.claim.assert_called_once_with('dispatch')
            wrapped.event('event')
            service.event.assert_called_once_with('event')
            wrapped.upload('event', 'artifact')
            service.upload.assert_called_once_with('event', 'artifact')

    def test_invalid_lane_does_not_reserve_cpu_budget(self):
        with patch('hosted_dispatcher.Database') as database:
            with self.assertRaises(ValueError):
                drain(Mock(), lane='unbounded')
            database.assert_not_called()

    def test_temporary_budget_pressure_never_stops_the_sibling_lane(self):
        for may_stop in (False, True):
            database = Mock()
            database.rpc.side_effect = [False, may_stop]
            volume = Mock()
            with patch('hosted_dispatcher.Database', return_value=database):
                result = drain(volume, lane='background')
            self.assertEqual(result, {'status': 'budget-exhausted' if may_stop else 'budget-busy',
                                      'lane': 'background'})
            self.assertEqual(database.rpc.call_args_list[1].args, ('halt_dispatcher_if_exhausted', {}))
            volume.reload.assert_not_called()

    def test_each_lane_reopens_only_its_own_durable_journal(self):
        with tempfile.TemporaryDirectory() as folder:
            journals = []
            for lane in ('foreground', 'background'):
                path = Path(folder) / lane
                path.mkdir()
                Journal.initialize(path / 'dispatch.sqlite3')
                journal = durable_journal(path / 'dispatch.sqlite3', Mock())
                journal.save({'dispatch': {'dispatchId': lane}, 'phase': 'creating'})
                journal.db.close()
                journals.append(path / 'dispatch.sqlite3')
            for lane, path in zip(('foreground', 'background'), journals):
                restored = durable_journal(path, Mock())
                self.assertEqual(restored.jobs(), [{'dispatch': {'dispatchId': lane}, 'phase': 'creating'}])
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
        database.read.return_value = [{'policy': {'recipe': {'workerBuildSha256': 'a' * 64}}, 'enabled': True, 'expires_at': '2099-01-01T00:00:00Z'}]
        env = {key: 'test' for key in ['FURY_DISPATCHER_ID', 'FURY_GPU_APP', 'FURY_GPU_IMAGE',
                                     'FURY_SERVICE_ORIGIN', 'FURY_WORKER_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']}
        with patch.dict('os.environ', env), patch('hosted_dispatcher.Database', return_value=database), \
                patch('hosted_dispatcher.durable_journal', return_value=journal), \
                patch('hosted_dispatcher.deployment_token', return_value='test'), \
                patch('on_demand.dispatcher.Dispatcher', return_value=worker) as dispatcher, \
                patch('hosted_transfer.HostedProvider'), patch('on_demand.transport.Service'):
            self.assertEqual(drain(Mock())['status'], 'processed')
            self.assertEqual(dispatcher.call_args.args[0].lane, 'foreground')
            self.assertEqual(dispatcher.call_args.args[3]['dispatcherId'], 'test:foreground')
            result = drain(Mock(), lane='background')
            self.assertEqual(result['status'], 'idle')
            self.assertEqual(result['lane'], 'background')
            self.assertEqual(dispatcher.call_args.args[0].lane, 'background')
            self.assertEqual(dispatcher.call_args.args[3]['dispatcherId'], 'test:background')
        self.assertEqual(worker.new_job.call_count, 2)
        worker.recover.assert_any_call(queued)
        self.assertEqual(sum(call.args[0] is stuck for call in worker.recover.call_args_list), 2)

    def test_missing_journal_never_silently_resets(self):
        with tempfile.TemporaryDirectory() as folder:
            volume = Mock()
            with self.assertRaises(RuntimeError):
                durable_journal(Path(folder) / 'journal.sqlite3', volume)
            volume.commit.assert_not_called()

    def test_creation_barrier_and_deliveries_commit_before_returning(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'journal.sqlite3'
            Journal.initialize(path)
            volume = Mock()
            journal = durable_journal(path, volume)
            journal.save({'dispatch': {'dispatchId': 'test'}, 'phase': 'creating'})
            self.assertEqual(volume.commit.call_count, 1)
            journal.queue('test', {'eventId': 'event', 'sequence': 1})
            self.assertEqual(volume.commit.call_count, 2)
            journal.delivered('event')
            self.assertEqual(volume.commit.call_count, 3)
            journal.db.close()
            restored = durable_journal(path, volume)
            self.assertEqual(restored.jobs()[0]['phase'], 'creating')
            self.assertEqual(restored.pending('test'), [])
            restored.db.close()

    def test_failed_durability_barrier_stops_the_caller(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'journal.sqlite3'
            Journal.initialize(path)
            volume = Mock()
            volume.commit.side_effect = RuntimeError('storage unavailable')
            journal = durable_journal(path, volume)
            with self.assertRaises(RuntimeError):
                journal.save({'dispatch': {'dispatchId': 'test'}, 'phase': 'creating'})
            journal.db.close()
