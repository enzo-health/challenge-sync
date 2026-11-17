#!/usr/bin/env python3
"""The weekly lottery (`GET /api/admin/lottery`) on a disposable database, after cargo build:

* a week is Monday 00:00 to Monday 00:00 in Denver: a post at Sunday 23:59:59 local is in the week,
  one at Monday 00:00:00 local is in the next, including across the fall-back week (169 hours,
  starting at -06:00 and ending at -07:00);
* entrants: one per person with an original post in the week, `postCount` counting originals only
  (a member with originals and a reshare), sorted by name ignoring case;
* audience: the rest of the org: someone who only reshared, someone who never posted; not someone
  whose account was created after the week ended; nobody in both lists;
* a deleted member is in neither list; members of another (legacy) org are included like everyone
  else, since org_id is not a boundary: as an entrant when they posted, in the audience otherwise;
* the default is the last complete week; the current week is allowed and flagged incomplete with
  no next week; a week that is not a Monday, has not started, or is not a date gets a 400 saying so;
* anonymous callers, regular members, and a system admin viewing as a regular member get a 401;
* no email, LinkedIn URN or profile URL anywhere in the response.

The server's clock is pinned with DEV_CLOCK_OFFSET_FILE (debug builds only): accounts are created
on 2026-10-20, then the clock moves to Monday 2026-11-16 10:00 in Denver, so "today" and "the last
complete week" do not depend on when the test runs. Posts are dated through /api/sync's createdAt.
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
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

def utc(value):
    """`2026-11-16T07:00:00Z` as unix seconds."""
    return int(dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc).timestamp())

ACCOUNTS_CREATED = utc('2026-10-20T18:00:00Z')
NOW = utc('2026-11-16T17:00:00Z')  # Monday 2026-11-16, 10:00 MST

with tempfile.TemporaryDirectory(prefix='lottery-e2e-') as directory:
    db_path = Path(directory) / 'test.db'
    log_path = Path(directory) / 'server.log'
    clock_path = Path(directory) / 'clock-offset'
    state = {}

    def set_clock(unix):
        clock_path.write_text(str(unix - int(time.time())))

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
        """Cookies survive a server restart: the session lives in the database file."""
        def __init__(self, email=None, password='demopassword'):
            self.jar = http.cookiejar.CookieJar()
            self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
            if email:
                self.request('/api/auth/login', {'email': email, 'password': password})
        def raw(self, path, data=None, method=None, token=None):
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            request = urllib.request.Request(state['base'] + path, headers=headers, method=method,
                data=json.dumps(data).encode() if data is not None else None)
            try:
                response = self.opener.open(request)
            except urllib.error.HTTPError as error:
                response = error
            return response.code, response.headers, response.read()
        def request(self, path, data=None, method=None, token=None, status=200):
            code, headers, body = self.raw(path, data, method, token)
            assert code == status, (path, code, status, body[:300])
            return json.loads(body) if headers.get_content_type() == 'application/json' else body.decode()

    def lottery(client, week=None, status=200):
        query = '?' + urllib.parse.urlencode({'week': week}) if week is not None else ''
        return client.request('/api/admin/lottery' + query, status=status)

    set_clock(ACCOUNTS_CREATED)
    start()
    try:
        anon = Client()

        def person(name):
            client = Client()
            slug = name.split()[0].lower()
            client.request('/api/auth/signup', {'name': name, 'email': f'{slug}-lottery-e2e@enzo.health',
                                                'password': 'LotteryE2E!pass123'})
            session = next(c.value for c in client.jar if c.name == 'session')
            token = client.request('/api/auth/device/session', {'sessionToken': session})['syncToken']
            return client, token, client.request('/api/auth/me')['memberId']

        # Names chosen so that case-insensitive order differs from byte order ("bob" < "Cat").
        ada, _, ada_id = person('Ada Admin')       # becomes the users org's system admin
        ann, ann_token, ann_id = person('Ann Two')  # two originals and a reshare
        bob, bob_token, bob_id = person('bob reshare')  # only a reshare
        cat, cat_token, cat_id = person('Cat Sunday')   # Sunday 23:59:59 local
        dan, dan_token, dan_id = person('Dan Monday')   # Monday 00:00:00 local, the next week
        eve, eve_token, eve_id = person('Eve Deleted')  # posts, then is deleted
        fay, _, fay_id = person('Fay Quiet')            # never posts
        hal, hal_token, hal_id = person('Hal Fall')     # first second of the fall-back week
        ivy, ivy_token, ivy_id = person('Ivy Fall')     # last second of the fall-back week
        kim, kim_token, kim_id = person('Kim Other')    # moved to the demo org below; posts
        lea, _, lea_id = person('Lea Other')            # moved to the demo org below; never posts
        ours = {ada_id, ann_id, bob_id, cat_id, dan_id, eve_id, fay_id, hal_id, ivy_id, kim_id, lea_id}

        stop()
        with sql() as db:
            db.execute('UPDATE members SET is_system_admin = 1 WHERE id = ?', (ada_id,))
            demo_org = db.execute("SELECT id FROM orgs WHERE slug = 'demo'").fetchone()[0]
            db.execute('UPDATE members SET org_id = ? WHERE id IN (?, ?)', (demo_org, kim_id, lea_id))
        set_clock(NOW)
        start()

        def post(urn, created, is_repost=False):
            return {'urn': urn, 'permalink': f'https://www.linkedin.com/feed/update/{urn}/', 'createdAt': created,
                    'textPreview': 'lottery e2e', 'isRepost': is_repost, 'metrics': {'impressions': 1}, 'comments': []}
        def sync(token, posts):
            anon.request('/api/sync', {'profile': {'followerCount': 100}, 'posts': posts}, token=token)

        sync(ann_token, [post('urn:li:activity:ann1', '2026-11-10T15:00:00Z'),
                         post('urn:li:activity:ann2', '2026-11-12T15:00:00Z'),
                         post('urn:li:activity:ann3', '2026-11-13T15:00:00Z', is_repost=True)])
        sync(bob_token, [post('urn:li:activity:bob1', '2026-11-11T15:00:00Z', is_repost=True)])
        sync(cat_token, [post('urn:li:activity:cat1', '2026-11-16T06:59:59Z')])   # Sun 23:59:59 MST
        sync(dan_token, [post('urn:li:activity:dan1', '2026-11-16T07:00:00Z')])   # Mon 00:00:00 MST
        sync(eve_token, [post('urn:li:activity:eve1', '2026-11-10T15:00:00Z')])
        sync(kim_token, [post('urn:li:activity:kim1', '2026-11-10T15:00:00Z')])
        sync(hal_token, [post('urn:li:activity:hal1', '2026-10-26T06:00:00Z'),    # Mon 00:00:00 MDT
                         post('urn:li:activity:hal0', '2026-10-26T05:59:59Z')])   # Sun 23:59:59 MDT, week before
        sync(ivy_token, [post('urn:li:activity:ivy1', '2026-11-02T06:59:59Z'),    # Sun 23:59:59 MST
                         post('urn:li:activity:ivy2', '2026-11-02T07:00:00Z')])   # Mon 00:00:00 MST, next week

        admin = Client(f'ada-lottery-e2e@enzo.health', 'LotteryE2E!pass123')
        demo_admin = Client('sysadmin@demo.test')

        # Delete Eve through the system API.
        admin.request(f'/api/system/members/{eve_id}', method='DELETE')
        # Gus signs up after the week of 2026-11-09 ended (the clock says 2026-11-16).
        gus, _, gus_id = person('Gus Late')
        ours.add(gus_id)

        def ids(rows):
            return [row['memberId'] for row in rows]
        def names_sorted(rows):
            keys = [(row['displayName'].lower(), row['memberId']) for row in rows]
            return keys == sorted(keys)

        # --- the default week ---------------------------------------------------------------------
        week = lottery(admin)
        check('the default is the last complete week (2026-11-09 to 2026-11-16, Denver)',
              (week['weekStart'], week['weekEnd'], week['startsAt'], week['endsAt'], week['timezone']) ==
              ('2026-11-09', '2026-11-16', '2026-11-09T00:00:00-07:00', '2026-11-16T00:00:00-07:00', 'America/Denver'))
        check('the last complete week is complete, with the current week next', week['isComplete'] is True
              and week['previousWeek'] == '2026-11-02' and week['nextWeek'] == '2026-11-16')
        check('asking for 2026-11-09 gives the same answer', lottery(admin, '2026-11-09') == week)

        entrants = {row['memberId']: row for row in week['entrants']}
        audience = set(ids(week['audience']))
        check('original posts count; a reshare is not counted (Ann: two originals and a reshare -> 2)',
              entrants[ann_id]['postCount'] == 2 and entrants[ann_id]['displayName'] == 'Ann Two')
        check('a post at Sunday 23:59:59 Denver is in the week', cat_id in entrants and entrants[cat_id]['postCount'] == 1)
        check('a post at Monday 00:00:00 Denver is not', dan_id not in entrants and dan_id in audience)
        check('only a reshare: in the audience, not an entrant', bob_id not in entrants and bob_id in audience)
        check('never posted: in the audience', fay_id in audience and ada_id in audience)
        check('a deleted member is in neither list', eve_id not in entrants and eve_id not in audience)
        check('an account created after the week ended is not in its audience', gus_id not in audience)
        check('a member of another legacy org who posted is an entrant', entrants.get(kim_id, {}).get('postCount') == 1)
        check('a member of another legacy org who did not post is in the audience', lea_id in audience and lea_id not in entrants)
        check('of this test\'s members, the entrants are exactly Ann, Cat and Kim', set(entrants) & ours == {ann_id, cat_id, kim_id})
        check('nobody is in both lists', not set(entrants) & audience)
        check('every non-deleted member who existed that week is listed', ours - {eve_id, gus_id} <= set(entrants) | audience)
        check('entrants and audience are sorted by name ignoring case, then id',
              names_sorted(week['entrants']) and names_sorted(week['audience'])
              and ids(week['audience']).index(bob_id) < ids(week['audience']).index(dan_id))

        def leaks(value, path='$'):
            if isinstance(value, dict):
                for key, inner in value.items():
                    assert key in {'weekStart', 'weekEnd', 'startsAt', 'endsAt', 'timezone', 'isComplete', 'previousWeek',
                                   'nextWeek', 'entrants', 'audience', 'memberId', 'displayName', 'postCount'}, (path, key)
                    leaks(inner, f'{path}.{key}')
            elif isinstance(value, list):
                for index, inner in enumerate(value):
                    leaks(inner, f'{path}[{index}]')
            elif isinstance(value, str):
                assert '@' not in value and 'urn:' not in value and 'linkedin.com' not in value, (path, value)
        leaks(week)
        check('no email, LinkedIn URN or profile URL anywhere in the response', True)

        # --- another org's admin ------------------------------------------------------------------------
        check('an admin in another org sees the same lists', lottery(demo_admin, '2026-11-09') == week)

        # --- the week in progress -----------------------------------------------------------------
        current = lottery(admin, '2026-11-16')
        check('the current week is allowed, flagged incomplete, with no next week',
              current['isComplete'] is False and current['nextWeek'] is None and current['previousWeek'] == '2026-11-09')
        check('the post at Monday 00:00:00 is in the current week', ids(current['entrants']) == [dan_id])
        check('the late account is in the current week\'s audience', gus_id in ids(current['audience']))

        # --- the fall-back week -------------------------------------------------------------------
        fall = lottery(admin, '2026-10-26')
        check('the fall-back week starts at -06:00 and ends at -07:00',
              (fall['weekEnd'], fall['startsAt'], fall['endsAt']) ==
              ('2026-11-02', '2026-10-26T00:00:00-06:00', '2026-11-02T00:00:00-07:00'))
        fall_entrants = {row['memberId']: row['postCount'] for row in fall['entrants']}
        check('the fall-back week holds its first and last second (169 hours) and nothing outside',
              fall_entrants == {hal_id: 1, ivy_id: 1})
        check('Hal\'s Sunday 23:59:59 MDT post is in the week before', ids(lottery(admin, '2026-10-19')['entrants']) == [hal_id])
        check('Ivy\'s Monday 00:00 MST post is in the week after', ivy_id in ids(lottery(admin, '2026-11-02')['entrants']))

        # --- bad weeks ----------------------------------------------------------------------------
        error = lottery(admin, '2026-11-10', status=400)['error']
        check('a Tuesday is refused (400), naming the Monday it belongs to',
              error == 'week must be the Monday a week starts on, got 2026-11-10 (a Tuesday); that week starts on 2026-11-09')
        error = lottery(admin, '2026-11-23', status=400)['error']
        check('a week that has not started is refused (400)',
              error == 'week 2026-11-23 has not started yet; the latest week is the one starting 2026-11-16')
        error = lottery(admin, 'last-week', status=400)['error']
        check('a week that is not a date is refused (400)', error == 'week must be a date like 2026-11-09, got "last-week"')

        # --- who may ask --------------------------------------------------------------------------
        code, _, body = anon.raw('/api/admin/lottery')
        check('anonymous callers get a 401', code == 401)
        refusal = lottery(ann, status=401)
        check('a regular member gets the same 401 as the other admin APIs',
              refusal['error'] == 'challenges are open to admins only for now'
              and ann.request('/api/admin/overview', status=401) == refusal)
        viewer = Client(f'ada-lottery-e2e@enzo.health', 'LotteryE2E!pass123')
        viewer.request('/api/system/impersonate', {'memberId': ann_id})
        check('a system admin viewing as a regular member is refused too', lottery(viewer, status=401) == refusal)

        print(json.dumps({'result': 'PASS', 'checks': len(checks)}), flush=True)
    finally:
        if state['process'].poll() is None:
            stop()
