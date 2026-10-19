import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from hosted_dispatcher import drain, durable_journal
from on_demand.journal import Journal


class HostedJournalTests(unittest.TestCase):
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
        database.read.return_value = [{'policy': {}, 'enabled': True, 'expires_at': '2099-01-01T00:00:00Z'}]
        env = {key: 'test' for key in ['FURY_DISPATCHER_ID', 'FURY_GPU_APP', 'FURY_GPU_IMAGE',
                                     'FURY_SERVICE_ORIGIN', 'FURY_WORKER_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']}
        with patch.dict('os.environ', env), patch('hosted_dispatcher.Database', return_value=database), \
                patch('hosted_dispatcher.durable_journal', return_value=journal), \
                patch('hosted_dispatcher.deployment_token', return_value='test'), \
                patch('on_demand.dispatcher.Dispatcher', return_value=worker), \
                patch('on_demand.dispatcher.Provider'), patch('on_demand.transport.Service'):
            self.assertEqual(drain(Mock())['status'], 'processed')
            self.assertEqual(drain(Mock())['status'], 'idle')
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
