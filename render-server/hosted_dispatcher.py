"""Hosted CPU lifecycle around an unchanged, immutable native-render package."""

import json
import os
from pathlib import Path
import time
import urllib.request
import uuid
from urllib.parse import urlencode


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise RuntimeError('redirect-rejected')


def request_json(url, headers, data=None):
    if not url.startswith('https://'):
        raise RuntimeError('https-required')
    request = urllib.request.Request(
        url, headers=headers,
        data=None if data is None else json.dumps(data).encode(),
    )
    with urllib.request.build_opener(NoRedirects()).open(request, timeout=30) as response:
        body = response.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise RuntimeError('response-cap')
    return json.loads(body) if body else None


class Database:
    def __init__(self):
        self.origin = os.environ['SUPABASE_URL'].rstrip('/')
        key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
        self.headers = {'Authorization': 'Bearer ' + key, 'apikey': key, 'Content-Type': 'application/json'}

    def read(self, path):
        return request_json(self.origin + '/rest/v1/' + path, self.headers)

    def rpc(self, name, values):
        return request_json(self.origin + '/rest/v1/rpc/render_library_' + name, self.headers, values)


def deployment_token():
    # Refresh on every cycle rather than storing an expiring OIDC credential.
    url = ('https://api.vercel.com/v3/env/pull/' + os.environ['FURY_VERCEL_PROJECT']
           + '/development?teamId=' + os.environ['FURY_VERCEL_TEAM'])
    return request_json(url, {'Authorization': 'Bearer ' + os.environ['VERCEL_TOKEN']})['env']['VERCEL_OIDC_TOKEN']


def durable_journal(path, volume):
    from on_demand.journal import Journal

    class VolumeJournal(Journal):
        def commit(self):
            self.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            volume.commit()

        def save(self, row):
            super().save(row)
            self.commit()

        def queue(self, dispatch, event, artifact=None):
            super().queue(dispatch, event, artifact)
            self.commit()

        def delivered(self, event_id):
            super().delivered(event_id)
            self.commit()

    return VolumeJournal(path)


class LaneService:
    def __init__(self, service, database, lane, worker_build):
        self.service, self.database, self.lane = service, database, lane
        self.worker_build = worker_build

    def __getattr__(self, name):
        return getattr(self.service, name)

    def rpc(self, name, values):
        if name == 'claim_dispatch':
            return self.database.rpc(name, {**values, 'lane': self.lane, 'workerBuildSha256': self.worker_build})
        return self.service.rpc(name, values)


def worker_recipe(database, approval):
    original = approval['policy']['recipe']
    build = approval.get('active_worker_build_sha256')
    if not build or build == original['workerBuildSha256']:
        return original
    query = urlencode({'worker_build_sha256': 'eq.' + build,
                       'release_id': 'eq.' + original['releaseId'], 'select': 'registration'})
    rows = database.read('render_library_worker_builds?' + query)
    if len(rows) != 1 or rows[0]['registration']['workerBuildSha256'] != build:
        raise RuntimeError('worker-registration-mismatch')
    return rows[0]['registration']


def drain(volume, root=Path('/opt/fury'), work=Path('/state'), lane='foreground'):
    from on_demand.dispatcher import Dispatcher
    from hosted_transfer import HostedProvider
    from on_demand.transport import Service

    if lane not in ('foreground', 'background'):
        raise ValueError('invalid-dispatch-lane')
    db = Database()
    cycle = str(uuid.uuid4())
    if db.rpc('start_cpu_cycle', {'cycleId': cycle}) is not True:
        halted = db.rpc('halt_dispatcher_if_exhausted', {}) is True
        return {'status': 'budget-exhausted' if halted else 'budget-busy', 'lane': lane}
    journal = None
    outcome = 'unavailable'
    try:
        volume.reload()
        journal = durable_journal(work / 'dispatch.sqlite3', volume)
        approval = db.read('render_library_approvals?select=id,enabled,policy,expires_at,active_worker_build_sha256')[0]
        policy = {
            **approval['policy'],
            'recipe': worker_recipe(db, approval),
            'enabled': approval['enabled'],
            'expiresAt': approval['expires_at'],
            'dispatcherId': os.environ['FURY_DISPATCHER_ID'] + ':' + lane,
            'appName': os.environ['FURY_GPU_APP'],
            'imageId': os.environ['FURY_GPU_IMAGE'],
        }
        service = Service(os.environ['FURY_SERVICE_ORIGIN'], os.environ['FURY_WORKER_TOKEN'],
                          os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'],
                          deployment_token())
        worker = Dispatcher(LaneService(service, db, lane, policy['recipe']['workerBuildSha256']),
                            HostedProvider(root, work), journal, policy, root, work)
        worker.verify_source()
        pending = [row for row in journal.jobs() if row['phase'] != 'settled']
        active = [row for row in pending if row['phase'] != 'uncertain']
        if not active and pending:
            worker.recover(pending[0])
            if pending[0]['phase'] not in ('uncertain', 'settled'):
                active.append(pending[0])
        # Each lane owns a separate volume and one serial invocation, never a shared SQLite writer.
        row = active[0] if active else worker.new_job()
        if row is None:
            outcome = 'idle'
        else:
            deadline = time.monotonic() + 2400
            while time.monotonic() < deadline:
                worker.recover(row)
                if row['phase'] == 'settled':
                    outcome = 'processed'
                    break
                if row['phase'] == 'uncertain':
                    outcome = 'recovery-pending'
                    break
                time.sleep(2)
            else:
                outcome = 'recovery-pending'
        # Best-effort terminal acknowledgements never consume the active-job slot.
        settled = [row for row in journal.jobs() if row['phase'] == 'settled' and journal.pending(row['dispatch']['dispatchId'])]
        if settled:
            worker.recover(settled[uuid.UUID(cycle).int % len(settled)])
        return {'status': outcome, 'cycleId': cycle, 'lane': lane}
    finally:
        if journal is not None:
            journal.db.close()
            volume.commit()
        db.rpc('finish_cpu_cycle', {'cycleId': cycle, 'result': outcome})
