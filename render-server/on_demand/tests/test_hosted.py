import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from hosted_dispatcher import durable_journal
from on_demand.journal import Journal


class HostedJournalTests(unittest.TestCase):
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
