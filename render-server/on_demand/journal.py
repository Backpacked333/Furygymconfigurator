"""Fsynced delivery/dispatch journal, not image-library authority. Persistent CPU disk required."""

import json
import os
from pathlib import Path
import sqlite3


class Journal:
    def __init__(self, path):
        path = Path(path)
        if not path.is_file():
            raise RuntimeError("journal-missing-operator-initialization-required")
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("SELECT dispatch_id FROM jobs LIMIT 1")

    @staticmethod
    def initialize(path):
        path = Path(path)
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        with sqlite3.connect(path) as db:
            db.execute(
                "CREATE TABLE jobs(dispatch_id TEXT PRIMARY KEY, payload TEXT NOT NULL)"
            )
            db.execute(
                "CREATE TABLE deliveries(event_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL, payload TEXT NOT NULL, artifact TEXT, delivered INTEGER NOT NULL DEFAULT 0)"
            )
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    def save(self, row):
        with self.db:
            self.db.execute(
                "INSERT INTO jobs VALUES (?,?) ON CONFLICT(dispatch_id) DO UPDATE SET payload=excluded.payload",
                (row["dispatch"]["dispatchId"], json.dumps(row, allow_nan=False)),
            )

    def jobs(self):
        return [json.loads(r[0]) for r in self.db.execute("SELECT payload FROM jobs")]

    def queue(self, dispatch, event, artifact=None):
        encoded = json.dumps(event, sort_keys=True, allow_nan=False)
        with self.db:
            existing = self.db.execute(
                "SELECT payload FROM deliveries WHERE event_id=?", (event["eventId"],)
            ).fetchone()
            if existing and existing[0] != encoded:
                raise RuntimeError("event-replay-diverged")
            self.db.execute(
                "INSERT OR IGNORE INTO deliveries(event_id,dispatch_id,payload,artifact) VALUES(?,?,?,?)",
                (
                    event["eventId"],
                    dispatch,
                    encoded,
                    str(artifact) if artifact else None,
                ),
            )

    def pending(self, dispatch):
        return [
            (json.loads(p), Path(a) if a else None)
            for p, a in self.db.execute(
                "SELECT payload,artifact FROM deliveries WHERE dispatch_id=? AND delivered=0 ORDER BY rowid",
                (dispatch,),
            )
        ]

    def delivered(self, event_id):
        with self.db:
            self.db.execute(
                "UPDATE deliveries SET delivered=1 WHERE event_id=?", (event_id,)
            )
