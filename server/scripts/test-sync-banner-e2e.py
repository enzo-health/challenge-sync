#!/usr/bin/env python3
"""The "Chrome paused Challenge Sync" banner's flag, on a disposable database, after cargo build.

`GET /api/auth/me` carries `lastSyncAt` (newest profile snapshot, unix seconds, or null) and
`syncStale` (signed in, and never synced or last synced more than two days ago). Checks:

* a member who synced just now is not stale, and `lastSyncAt` matches /api/me/sync-status;
* a member whose newest sync is three days old is stale; one 47 hours old is not;
* a member who has never synced is stale, with `lastSyncAt` null;
* "last sync" is the newest PROFILE snapshot, whatever the post snapshots say;
* a system admin viewing as someone sees that person's flag;
* signed-out callers, and a deleted account's old cookie, get `syncStale: false` and nothing else.

Backdating writes the file directly with sqlite3 while the server is stopped (Turso holds a lock),
then starts it again on the same file; cookies live in the database, so they survive the restart.
"""
import contextlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
HOUR = 3600
DAY = 86400
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

with tempfile.TemporaryDirectory(prefix='sync-banner-e2e-') as directory:
    db_path = Path(directory) / 'test.db'
    log_path = Path(directory) / 'server.log'
    state = {}

    def start():
        log = log_path.open('a')
        state['process'] = subprocess.Popen([str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
            env={**os.environ, 'DATABASE_URL': f'turso:{db_path}', 'SEED_DEMO': '1', 'PORT': '0'},
            stdout=log, stderr=log)
        seen = len(re.findall(r'listening on http://[^:]+:(\d+)', log_path.read_text()))
        for _ in range(200):
            ports = re.findall(r'listening on http://[^:]+:(\d+)', log_path.read_text())
            if len(ports) > seen:
                state['base'] = 'http://127.0.0.1:' + ports[-1]
                return
            if state['process'].poll() is not None:
                raise RuntimeError(log_path.read_text())
            time.sleep(.05)
        raise RuntimeError('server startup timed out: ' + log_path.read_text())

    def stop():
        state['process'].terminate()
        state['process'].wait(timeout=10)

    @contextlib.contextmanager
    def sql():
        # sqlite3's own context manager commits but leaves the file open (and locked for Turso).
        db = sqlite3.connect(db_path)
        try:
            with db:
                yield db
        finally:
            db.close()

    class Client:
        def __init__(self, email=None, password='demopassword'):
            self.jar = http.cookiejar.CookieJar()
            self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
            if email:
                self.request('/api/auth/login', {'email': email, 'password': password})
        def request(self, path, data=None, method=None, token=None, status=200):
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            request = urllib.request.Request(state['base'] + path, headers=headers, method=method,
                data=json.dumps(data).encode() if data is not None else None)
            try:
                response = self.opener.open(request)
            except urllib.error.HTTPError as error:
                response = error
            body = response.read()
            assert response.code == status, (path, response.code, status, body[:300])
            return json.loads(body) if response.headers.get_content_type() == 'application/json' else body.decode()
        def me(self):
            return self.request('/api/auth/me')
        def device_token(self):
            session = next(c.value for c in self.jar if c.name == 'session')
            return self.request('/api/auth/device/session', {'sessionToken': session})['syncToken']
        def sync(self, token, posts=()):
            return self.request('/api/sync', {'profile': {'followerCount': 100}, 'posts': list(posts)}, token=token)

    def person(name, email):
        client = Client()
        client.request('/api/auth/signup', {'name': name, 'email': email, 'password': 'SyncBannerE2E!123'})
        return client, client.me()['memberId']

    start()
    try:
        anon = Client()
        admin = Client('sysadmin@demo.test')

        # --- signed out -----------------------------------------------------------------------
        signed_out = anon.me()
        check('signed out: not stale, no last sync',
              signed_out['signedIn'] is False and signed_out['syncStale'] is False and signed_out['lastSyncAt'] is None)

        # --- fresh, old, borderline, never --------------------------------------------------------
        fresh, fresh_id = person('Fresh Syncer', 'fresh.syncer@enzo.health')
        old, old_id = person('Old Syncer', 'old.syncer@enzo.health')
        edge, edge_id = person('Edge Syncer', 'edge.syncer@enzo.health')
        never, never_id = person('Never Syncer', 'never.syncer@enzo.health')
        leaver, leaver_id = person('Leaving Syncer', 'leaving.syncer@enzo.health')

        before = int(time.time())
        tokens = {}
        # Old's sync carries a post, so it has a post snapshot to leave un-backdated below.
        old_post = {'urn': 'urn:li:activity:sync-banner-1', 'permalink': 'https://www.linkedin.com/feed/',
                    'createdAt': '2026-01-01T00:00:00Z', 'textPreview': 'e2e',
                    'metrics': {'reactions': 1, 'comments': 0}, 'comments': []}
        for name, client in (('fresh', fresh), ('old', old), ('edge', edge), ('leaver', leaver)):
            tokens[name] = client.device_token()
            client.sync(tokens[name], [old_post] if name == 'old' else [])
        after = int(time.time())

        me = fresh.me()
        check('a member who synced just now is not stale',
              me['signedIn'] is True and me['syncStale'] is False and before <= me['lastSyncAt'] <= after)
        status = Client().request('/api/me/sync-status', token=tokens['fresh'])
        check('lastSyncAt on /api/auth/me matches /api/me/sync-status', status['lastSyncAt'] == me['lastSyncAt'])

        me = never.me()
        check('a member who has never synced is stale, with lastSyncAt null',
              me['signedIn'] is True and me['syncStale'] is True and me['lastSyncAt'] is None)

        # --- backdate: old to three days, edge to 47 hours ------------------------------------------
        stop()
        now = int(time.time())
        with sql() as db:
            db.execute('UPDATE profile_snapshots SET captured_at = ? WHERE member_id = ?', (now - 3 * DAY, old_id))
            db.execute('UPDATE profile_snapshots SET captured_at = ? WHERE member_id = ?', (now - 47 * HOUR, edge_id))
            # Old's post snapshot stays at "now": only profile snapshots are written on every sync,
            # so they alone say when the extension last ran.
            recent_post_snapshots = db.execute(
                'SELECT COUNT(*) FROM post_snapshots s JOIN posts p ON p.id = s.post_id '
                'WHERE p.member_id = ? AND s.captured_at >= ?', (old_id, now - HOUR)).fetchone()[0]
        start()

        me = old.me()
        check('a member whose last sync is three days old is stale',
              me['syncStale'] is True and me['lastSyncAt'] == now - 3 * DAY)
        check('a recent post snapshot does not count as a sync', recent_post_snapshots >= 1 and me['syncStale'] is True)
        me = edge.me()
        check('a member whose last sync is 47 hours old is not stale yet',
              me['syncStale'] is False and me['lastSyncAt'] == now - 47 * HOUR)

        # Old syncs once more: the banner goes away by itself.
        old.sync(tokens['old'])
        me = old.me()
        check('syncing again clears the flag', me['syncStale'] is False and me['lastSyncAt'] >= now)

        # Several snapshots: the newest wins, not the first or the oldest.
        stop()
        with sql() as db:
            db.execute('INSERT INTO profile_snapshots (member_id, captured_at, follower_count) VALUES (?, ?, ?)',
                       (never_id, now - 10 * DAY, 5))
            db.execute('INSERT INTO profile_snapshots (member_id, captured_at, follower_count) VALUES (?, ?, ?)',
                       (never_id, now - 1 * DAY, 5))
            db.execute('INSERT INTO profile_snapshots (member_id, captured_at, follower_count) VALUES (?, ?, ?)',
                       (never_id, now - 5 * DAY, 5))
        start()
        me = never.me()
        check('with several profile snapshots the newest is the last sync',
              me['syncStale'] is False and me['lastSyncAt'] == now - 1 * DAY)

        # --- viewing as someone ----------------------------------------------------------------------
        viewer = Client('sysadmin@demo.test')
        viewer.request('/api/system/impersonate', {'memberId': edge_id}, method='POST')
        viewing = viewer.me()
        check("an admin viewing as someone sees that person's flag",
              viewing['memberId'] == edge_id and viewing['impersonatedBy'] and viewing['lastSyncAt'] == now - 47 * HOUR)

        # --- a deleted account -----------------------------------------------------------------------
        admin.request(f'/api/system/members/{leaver_id}', method='DELETE')
        me = leaver.me()
        check("a deleted account's old cookie is signed out and never flagged",
              me['signedIn'] is False and me['syncStale'] is False and me['lastSyncAt'] is None)
        check('anonymous callers are still unaffected', anon.me()['syncStale'] is False)
    finally:
        stop()
print(json.dumps({'result': 'PASS', 'checks': len(checks)}, indent=2))
