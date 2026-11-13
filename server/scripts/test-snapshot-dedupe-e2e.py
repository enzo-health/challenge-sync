#!/usr/bin/env python3
"""Unchanged post readings are not stored, and no score moves because of it. Run after cargo build.

* Three syncs of two posts (first reading, identical repeat, one number changed) store only the
  first and the changed readings, while `postsIngested` still counts every accepted post.
* A metric missing from a reading keeps the post's last known value, and a reading that is then
  unchanged is not stored.
* Putting back the rows the old server would have written (the repeats) leaves the leaderboard and
  member detail the same, apart from wall-clock fields: scores with the dedupe equal scores
  without it.
* scripts/dedupe-post-snapshots.sql changes nothing as written (it ends in ROLLBACK), and with
  COMMIT deletes exactly the repeats, again without moving any score. That includes a run of
  identical readings spanning a past challenge's end, where the in-window reading must survive.

The database is a throwaway Turso file. The server is stopped whenever this script reads or
writes the file directly with sqlite3, then started again on the same file.
"""
import contextlib
import datetime as dt
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
CLEANUP_SQL = (ROOT / 'scripts/dedupe-post-snapshots.sql').read_text()
METRICS = ['impressions', 'reactions', 'comments', 'reposts', 'sends', 'saves', 'impressions_in_network',
           'impressions_out_of_network', 'members_reached', 'profile_viewers_from_post', 'followers_from_post']
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

with tempfile.TemporaryDirectory(prefix='snapshot-dedupe-e2e-') as directory:
    db_path = Path(directory) / 'test.db'
    log_path = Path(directory) / 'server.log'
    # The debug server adds this many seconds to its clock (DEV_CLOCK_OFFSET_FILE, debug builds only).
    clock_path = Path(directory) / 'clock-offset'
    clock_path.write_text('0')
    state = {}

    def start():
        log = log_path.open('a')
        state['process'] = subprocess.Popen([str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
            env={**os.environ, 'DATABASE_URL': f'turso:{db_path}', 'SEED_DEMO': '1', 'PORT': '0',
                 'DEV_CLOCK_OFFSET_FILE': str(clock_path)},
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
        def __init__(self):
            self.jar = http.cookiejar.CookieJar()
            self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
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
            assert response.code == status, (path, response.code, status, body)
            return json.loads(body) if response.headers.get_content_type() == 'application/json' else body.decode()

    start()
    try:
        me = Client()
        me.request('/api/auth/signup', {'name': 'Snapshot Dedupe E2E', 'email': 'snapshot-dedupe-e2e@enzo.health', 'password': 'SnapshotDedupeE2E!123'})
        session = next(c.value for c in me.jar if c.name == 'session')
        token = me.request('/api/auth/device/session', {'sessionToken': session})['syncToken']
        mid = me.request('/api/auth/me')['memberId']
        # Challenges are open to system admins only for now (`auth::can_use_challenges`), and this
        # test reads its scores through two challenges, so the account is made an admin.
        operator = Client()
        operator.request('/api/auth/login', {'email': 'sysadmin@demo.test', 'password': 'demopassword'})
        operator.request(f'/api/system/members/{mid}/admin', {'isAdmin': True}, method='PUT')
        today = dt.datetime.now(dt.timezone.utc).date()
        current = me.request('/api/challenges', {'name': 'Dedupe current', 'start': str(today - dt.timedelta(days=2)), 'end': str(today + dt.timedelta(days=2)), 'config': {}})['id']
        past = me.request('/api/challenges', {'name': 'Dedupe past', 'start': str(today - dt.timedelta(days=20)), 'end': str(today - dt.timedelta(days=10)), 'config': {}})['id']

        def at(days_ago, hours=0):
            return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days_ago, hours=hours)).isoformat()
        def post(urn, created, **metrics):
            return {'urn': urn, 'permalink': 'https://www.linkedin.com/feed/', 'createdAt': created,
                    'textPreview': 'e2e', 'metrics': metrics, 'comments': []}
        def sync(posts):
            # No follower count, so engagement is unscaled and easy to check by hand.
            result = me.request('/api/sync', {'profile': {'followerCount': None}, 'posts': posts}, token=token)
            # Scoring orders readings by captured_at to the second; distinct seconds keep the rows
            # this test puts back later in the order a real server would have written them, as a
            # real member never syncs twice in one second. Rather than sleep a second, move the
            # debug server's clock a second on.
            clock_path.write_text(str(int(clock_path.read_text()) + 1))
            return result
        def timeless(value):
            # `asOf` and `progress` follow the wall clock, not the data.
            if isinstance(value, dict):
                return {k: timeless(v) for k, v in value.items() if k not in ('asOf', 'progress')}
            if isinstance(value, list):
                return [timeless(v) for v in value]
            return value
        def views():
            return timeless({
                'boardCurrent': me.request(f'/api/leaderboard?challengeId={current}'),
                'boardPast': me.request(f'/api/leaderboard?challengeId={past}'),
                'detailCurrent': me.request(f'/api/members/{mid}?challengeId={current}'),
                'detailPast': me.request(f'/api/members/{mid}?challengeId={past}'),
                'posts': me.request('/api/me/posts'),
            })
        def standing(view, key):
            return next(s for s in view[key]['standings'] if s['memberId'] == mid)

        a, b, old = 'urn:li:activity:dedupe-a', 'urn:li:activity:dedupe-b', 'urn:li:activity:dedupe-old'
        a1 = dict(impressions=500, reactions=100, comments=40, reposts=None, sends=2)
        a2 = dict(a1, reactions=50)
        b1 = dict(impressions=80, reactions=10, comments=0)
        old_now = dict(impressions=900, reactions=60, comments=0)

        # --- ingest skips unchanged readings ------------------------------------------------------
        first = sync([post(a, at(0, 1), **a1), post(b, at(0, 2), **b1), post(old, at(15), **old_now)])
        repeat = sync([post(a, at(0, 1), **a1), post(b, at(0, 2), **b1)])
        changed = sync([post(a, at(0, 1), **a2), post(b, at(0, 2), **b1)])
        check('postsIngested counts every accepted post, stored reading or not',
              (first['postsIngested'], repeat['postsIngested'], changed['postsIngested']) == (3, 2, 2))
        live = views()
        posts_live = {p['urn']: p for p in live['posts']['posts']}
        check('the post list shows the latest numbers', posts_live[a]['reactions'] == 50 and posts_live[b]['reactions'] == 10)
        # a2: 50 × 0.2 + 40 × 5 = 210 → 150 + 60 × 0.5 = 180; b1: 10 × 0.2 = 2.
        check('engagement is priced from the latest reading', standing(live, 'boardCurrent')['engagementPoints'] == 182)

        # --- a known number never goes back to unknown -------------------------------------------
        # The author-only analytics request sometimes fails, and the reading then lacks its fields.
        # A separate post, so the scoring checks above stay as they are.
        c = 'urn:li:activity:dedupe-carry'
        sync([post(c, at(0, 3), reactions=10, comments=0, impressionsOutOfNetwork=3200)])
        sync([post(c, at(0, 3), reactions=12, comments=0)])
        sync([post(c, at(0, 3), reactions=12, comments=0)])
        live = views()
        check('the post list keeps the carried out-of-network count',
              {p['urn']: p for p in live['posts']['posts']}[c]['impressionsOutOfNetwork'] == 3200)
        stop()
        with sql() as db:
            carried = db.execute('SELECT s.reactions, s.impressions_out_of_network, s.impressions FROM post_snapshots s '
                                 'JOIN posts p ON p.id = s.post_id WHERE p.urn = ? ORDER BY s.captured_at, s.id', (c,)).fetchall()
        check('a missing metric carries the stored value forward, and a repeat after that is not stored',
              carried == [(10, 3200, None), (12, 3200, None)])
        check('a metric never recorded for the post stays unknown', all(i is None for *_, i in carried))

        with sql() as db:
            post_ids = dict(db.execute('SELECT urn, id FROM posts WHERE member_id = ?', (mid,)).fetchall())
            rows = {urn: db.execute('SELECT captured_at, reactions FROM post_snapshots WHERE post_id = ? ORDER BY captured_at, id', (pid,)).fetchall()
                    for urn, pid in post_ids.items()}
            sync_times = [t for (t,) in db.execute('SELECT captured_at FROM profile_snapshots WHERE member_id = ? ORDER BY captured_at, id', (mid,))]
        check('the database file is readable with sqlite3 once the server has stopped', len(sync_times) == 6)
        check('a profile snapshot is still written on every sync', len(set(sync_times)) == 6)
        check('only the first and the changed readings were stored',
              [r for _, r in rows[a]] == [100, 50] and [r for _, r in rows[b]] == [10] and len(rows[old]) == 1)

        # --- what the old server would have stored ----------------------------------------------
        # Put back the repeats the dedupe skipped (A at sync two, B at syncs two and three), and give
        # the old post the history a pre-dedupe server collected: a run of identical readings that
        # spans the past challenge's end (day 10), then a change, then repeats of that change.
        end_of_past = int(dt.datetime.combine(today - dt.timedelta(days=10), dt.time.max, dt.timezone.utc).timestamp())
        def insert(db, urn, captured_at, metrics):
            columns = ['post_id', 'captured_at', *METRICS]
            values = [post_ids[urn], captured_at, *(metrics.get(m) for m in METRICS)]
            db.execute(f"INSERT INTO post_snapshots ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})", values)
        old_in_window = dict(impressions=700, reactions=30, comments=0)
        day = 86400
        with sql() as db:
            insert(db, a, sync_times[1], a1)
            insert(db, b, sync_times[1], b1)
            insert(db, b, sync_times[2], b1)
            insert(db, old, end_of_past - 4 * day, dict(impressions=300, reactions=5, comments=0))
            insert(db, old, end_of_past - 2 * day, old_in_window)
            insert(db, old, end_of_past - 1 * day, old_in_window)
            insert(db, old, end_of_past + 1 * day, old_in_window)
            insert(db, old, end_of_past + 2 * day, old_now)
            insert(db, old, end_of_past + 3 * day, old_now)
            full_count = db.execute('SELECT count(*) FROM post_snapshots').fetchone()[0]
        start()
        full = views()
        check('scores with the dedupe equal scores without it (current challenge)',
              full['boardCurrent'] == live['boardCurrent'] and full['detailCurrent'] == live['detailCurrent'])
        check('the post list is the same with or without the repeats', full['posts'] == live['posts'])
        # The past challenge prices the last reading on or before its end: 30 × 0.2 = 6.
        check('the past challenge reads the old post from inside its window', standing(full, 'boardPast')['engagementPoints'] == 6)
        stop()

        # --- the one-off cleanup script ----------------------------------------------------------
        with sql() as db:
            db.executescript(CLEANUP_SQL)
            unchanged_count = db.execute('SELECT count(*) FROM post_snapshots').fetchone()[0]
        check('the cleanup script as written changes nothing', unchanged_count == full_count)
        # The edit the script's header describes: its final statement becomes COMMIT.
        head, tail = CLEANUP_SQL.rsplit('ROLLBACK;', 1)
        assert tail.strip() == ''
        with sql() as db:
            db.executescript(head + 'COMMIT;')
            kept = {urn: db.execute('SELECT captured_at, reactions FROM post_snapshots WHERE post_id = ? ORDER BY captured_at, id', (pid,)).fetchall()
                    for urn, pid in post_ids.items()}
        check('with COMMIT the script removes exactly the repeats',
              [r for _, r in kept[a]] == [100, 50] and [r for _, r in kept[b]] == [10]
              and [r for _, r in kept[old]] == [5, 30, 60])
        check('the earliest row of a run spanning the challenge end is the one kept',
              kept[old][1][0] == end_of_past - 2 * day)
        start()
        cleaned = views()
        check('scores after the cleanup equal scores before it, in both challenges', cleaned == full)

        # --- syncing on after the cleanup --------------------------------------------------------
        again = sync([post(a, at(0, 1), **a2), post(b, at(0, 2), **b1), post(old, at(15), **old_now)])
        check('a repeat after the cleanup is still recognised', again['postsIngested'] == 3)
        check('and leaves every score where it was', views() == cleaned)
        stop()
        with sql() as db:
            after = db.execute('SELECT count(*) FROM post_snapshots s JOIN posts p ON p.id = s.post_id WHERE p.member_id = ?', (mid,)).fetchone()[0]
        check('no rows were written for the repeat', after == sum(len(v) for v in kept.values()))
    finally:
        if state['process'].poll() is None:
            stop()
print(json.dumps({'result': 'PASS', 'checks': len(checks)}, indent=2))
