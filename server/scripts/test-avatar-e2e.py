#!/usr/bin/env python3
"""A member's own avatar (`GET/PUT/DELETE /api/me/avatar`) on a disposable database, after cargo build:

* signed out, all three methods get the same 401 as the other /api/me routes;
* GET is null before any save; a valid PUT is returned by PUT and by a later GET;
* each kind of invalid body gets a 400 whose message names what was wrong: not JSON, not an
  object, an unknown key (a `memberId` aimed at someone else included), a missing key, the wrong
  `v`, a value that is not a string, a value not in the options list; a refused PUT changes nothing;
* one member's save or reset leaves another's avatar alone; a system admin viewing as a member
  reads and writes that member's avatar;
* DELETE goes back to null;
* `GET /api/admin/lottery` carries the saved avatar for an entrant and for an audience member, and
  null for someone who never saved;
* a stored value that no longer validates reads as null, with a warning naming the member;
* a database created before the column existed gets it on startup, with every avatar null;
* versions: the current one (v2, the options file's `version`) adds `facialHair` and more hair
  styles; a v1 avatar (no `facialHair`) is still accepted on save and when read from a stored row,
  and always comes back as v2 with `facialHair: "none"`; a v1 body with `facialHair`, a v2 body
  without it, and any other `v` are refused with a message saying so.

The valid values come from `components/lottery/avatar-options.json`, the file the server checks
against. The clock is pinned with DEV_CLOCK_OFFSET_FILE (debug builds only) so the lottery week is
fixed, like test-lottery-e2e.py.
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
OPTIONS = json.loads((ROOT / 'components/lottery/avatar-options.json').read_text())
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

def utc(value):
    return int(dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc).timestamp())

ACCOUNTS_CREATED = utc('2026-10-20T18:00:00Z')
NOW = utc('2026-11-16T17:00:00Z')  # Monday 2026-11-16, 10:00 MST; the Fri-Thu week of 2026-11-06 is complete

FIELDS = [key for key in OPTIONS if key != 'version']
# A v2 avatar using a hair style and facial hair that v1 did not have.
AVATAR_A = {'v': OPTIONS['version'], **{field: OPTIONS[field][0] for field in FIELDS},
            'hair': 'sidepart', 'facialHair': 'goatee'}
AVATAR_B = {'v': OPTIONS['version'], **{field: OPTIONS[field][-1] for field in FIELDS}}
assert OPTIONS['version'] == 2, 'this test knows versions 1 and 2; revisit it for a new version'
# A v1 avatar as a v1 client saved it: the 13 original keys, values v1 offered, no facialHair.
AVATAR_V1 = {'v': 1, 'skin': '#b97a50', 'outfit': '#3a86ff', 'accent': '#ffd166', 'hairColor': '#e4572e',
             'hair': 'curly', 'hat': 'beanie', 'ears': 'pointy', 'eyes': 'happy', 'brows': 'arched',
             'nose': 'button', 'mouth': 'grin', 'build': 'tall'}
AVATAR_V1_UPGRADED = {**AVATAR_V1, 'v': 2, 'facialHair': 'none'}

with tempfile.TemporaryDirectory(prefix='avatar-e2e-') as directory:
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
                 'DEV_CLOCK_OFFSET_FILE': str(clock_path), 'RUST_LOG': 'warn'},
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
        def raw(self, path, data=None, method=None, token=None, body=None):
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            if body is None and data is not None:
                body = json.dumps(data).encode()
            request = urllib.request.Request(state['base'] + path, headers=headers, method=method, data=body)
            try:
                response = self.opener.open(request)
            except urllib.error.HTTPError as error:
                response = error
            return response.code, response.headers, response.read()
        def request(self, path, data=None, method=None, token=None, status=200, body=None):
            code, headers, raw = self.raw(path, data, method, token, body)
            assert code == status, (path, method, code, status, raw[:500])
            assert headers.get_content_type() == 'application/json', (path, headers.get_content_type(), raw[:300])
            return json.loads(raw)

    def get_avatar(client, status=200):
        return client.request('/api/me/avatar', status=status)
    def put_avatar(client, avatar, status=200, body=None):
        return client.request('/api/me/avatar', avatar, method='PUT', status=status, body=body)
    def reset_avatar(client, status=200):
        return client.request('/api/me/avatar', method='DELETE', status=status)

    set_clock(ACCOUNTS_CREATED)
    start()
    try:
        anon = Client()

        def person(name):
            client = Client()
            slug = name.split()[0].lower()
            client.request('/api/auth/signup', {'name': name, 'email': f'{slug}-avatar-e2e@enzo.health',
                                                'password': 'AvatarE2E!pass123'})
            session = next(c.value for c in client.jar if c.name == 'session')
            token = client.request('/api/auth/device/session', {'sessionToken': session})['syncToken']
            return client, token, client.request('/api/auth/me')['memberId']

        amy, amy_token, amy_id = person('Amy Poster')    # posts in the week: an entrant
        ben, _, ben_id = person('Ben Watcher')           # never posts: audience
        cal, _, cal_id = person('Cal Default')           # never posts, never saves an avatar
        dee, _, dee_id = person('Dee Legacy')            # never posts; a v1 client, then a stored v1 row
        set_clock(NOW)

        # --- signed out -------------------------------------------------------------------------
        # No cookie at all: the root middleware answers, as for every /api/me route.
        def bare(client, path, method=None, data=None):
            code, headers, body = client.raw(path, data, method)
            return code, headers.get_content_type(), body
        refusal = bare(anon, '/api/me/posts')
        check('no session cookie: /api/me/posts is a 401 (the reference)', refusal[0] == 401)
        check('no session cookie: GET gets the same 401', bare(anon, '/api/me/avatar') == refusal)
        check('no session cookie: PUT gets the same 401', bare(anon, '/api/me/avatar', 'PUT', AVATAR_A) == refusal)
        check('no session cookie: DELETE gets the same 401', bare(anon, '/api/me/avatar', 'DELETE') == refusal)
        # A cookie that is no session: the handler's own check answers, as for /api/me/posts.
        forged = Client()
        forged.jar.set_cookie(http.cookiejar.Cookie(0, 'session', 'not-a-session', None, False, '127.0.0.1', False,
            False, '/', True, False, None, False, None, None, {}))
        refusal = forged.request('/api/me/posts', status=401)
        check('an unknown session: /api/me/posts says sign-in required', refusal == {'error': 'sign-in required'})
        check('an unknown session: GET gets the same 401', get_avatar(forged, status=401) == refusal)
        check('an unknown session: PUT gets the same 401', put_avatar(forged, AVATAR_A, status=401) == refusal)
        check('an unknown session: DELETE gets the same 401', reset_avatar(forged, status=401) == refusal)

        # --- save and read back ---------------------------------------------------------------------
        check('GET is null before any save', get_avatar(amy) == {'avatar': None})
        check('PUT of a v2 avatar with facial hair and a new hair style returns it',
              put_avatar(amy, AVATAR_A) == {'avatar': AVATAR_A})
        check('GET returns the saved avatar', get_avatar(amy) == {'avatar': AVATAR_A})

        # --- validation ----------------------------------------------------------------------------
        def refused(body=None, raw=None):
            return put_avatar(amy, body, status=400, body=raw)['error']

        error = refused(raw=b'{"v": 1, ')
        check('a body that is not JSON: 400 saying so', error.startswith('the request body is not valid JSON: '))
        error = refused(raw=b'')
        check('an empty body: 400 saying it is not valid JSON', error.startswith('the request body is not valid JSON: '))
        error = refused(['not', 'an', 'object'])
        check('a non-object: 400 naming what was sent', error == 'an avatar must be a JSON object, got an array')
        error = refused({**AVATAR_A, 'sparkles': 'yes'})
        check('an unknown key: 400 naming it', error.startswith('unknown field sparkles; a v2 avatar has exactly the fields v, '))
        error = refused({**AVATAR_A, 'memberId': ben_id})
        check('a memberId aimed at someone else is an unknown key (400)', error.startswith('unknown field memberId;'))
        missing = {key: value for key, value in AVATAR_A.items() if key not in ('hat', 'mouth')}
        error = refused(missing)
        check('missing keys: 400 naming each', error == 'missing fields hat, mouth')
        error = refused({**AVATAR_A, 'v': 99})
        check('an unknown version: 400 naming the supported ones and what was sent',
              error == 'unsupported avatar version: v must be 1 or 2, got 99')
        error = refused({**AVATAR_A, 'v': 3})
        check('v3 is refused the same way', error == 'unsupported avatar version: v must be 1 or 2, got 3')
        error = refused({key: value for key, value in AVATAR_A.items() if key != 'facialHair'})
        check('a v2 body without facialHair: 400 naming it as missing', error == 'missing field facialHair')
        error = refused({**AVATAR_A, 'facialHair': 'mutton'})
        check('an unknown facialHair value: 400 naming the field, the value and the allowed values',
              error == f'facialHair "mutton" is not an allowed value; allowed: {", ".join(OPTIONS["facialHair"])}')
        error = refused({**AVATAR_V1, 'facialHair': 'goatee'})
        check('a v1 body with facialHair: 400 saying v1 has no such field',
              error == 'facialHair is not a field of a v1 avatar (it was added in v2); send v 2 to set it')
        error = refused({**AVATAR_V1, 'hair': 'afro'})
        check('a v1 body is checked against the current lists too',
              error == f'hair "afro" is not an allowed value; allowed: {", ".join(OPTIONS["hair"])}')
        error = refused({**AVATAR_A, 'eyes': 7})
        check('a value that is not a string: 400 naming the field', error == 'eyes must be a string, got a number (7)')
        error = refused({**AVATAR_A, 'hair': 'afro'})
        check('a value not in the list: 400 naming the field, the value and the allowed values',
              error == f'hair "afro" is not an allowed value; allowed: {", ".join(OPTIONS["hair"])}')
        error = refused({**AVATAR_A, 'skin': AVATAR_A['skin'].upper()})
        check('colours compare exactly (upper-case hex is refused)', error.startswith(f'skin "{AVATAR_A["skin"].upper()}" is not an allowed value'))
        error = refused({**AVATAR_A, 'hair': 'afro', 'nose': None})
        check('several problems are all reported', 'hair "afro"' in error and 'nose must be a string, got null' in error)
        check('a refused PUT leaves the stored avatar unchanged', get_avatar(amy) == {'avatar': AVATAR_A})

        # --- every value, and v1 bodies ---------------------------------------------------------------
        for field in ('hair', 'facialHair'):
            for value in OPTIONS[field]:
                body = {**AVATAR_A, field: value}
                assert put_avatar(dee, body) == {'avatar': body}, (field, value)
            check(f'every {field} value is accepted ({len(OPTIONS[field])})', True)
        check('a v1 body is accepted and returned as v2 with facialHair none',
              put_avatar(dee, AVATAR_V1) == {'avatar': AVATAR_V1_UPGRADED})
        check('and GET returns it as v2', get_avatar(dee) == {'avatar': AVATAR_V1_UPGRADED})
        reset_avatar(dee)

        # --- one member, one avatar ------------------------------------------------------------------
        check('Amy\'s save did not give Ben an avatar', get_avatar(ben) == {'avatar': None})
        put_avatar(ben, AVATAR_B)
        check('Ben saves his own', get_avatar(ben) == {'avatar': AVATAR_B})
        check('Ben\'s save did not change Amy\'s', get_avatar(amy) == {'avatar': AVATAR_A})

        operator = Client('sysadmin@demo.test')
        operator.request('/api/system/impersonate', {'memberId': cal_id})
        check('a system admin viewing as Cal reads Cal\'s avatar (null)', get_avatar(operator) == {'avatar': None})
        put_avatar(operator, AVATAR_B)
        check('and saves onto Cal\'s row', get_avatar(cal) == {'avatar': AVATAR_B})
        reset_avatar(operator)
        check('and resets Cal\'s', get_avatar(cal) == {'avatar': None})
        operator.request('/api/system/impersonate/stop', method='POST')

        # --- the lottery ----------------------------------------------------------------------------
        anon.request('/api/sync', {'profile': {'followerCount': 100}, 'posts': [{
            'urn': 'urn:li:activity:amy1', 'permalink': 'https://www.linkedin.com/feed/update/urn:li:activity:amy1/',
            'createdAt': '2026-11-10T15:00:00Z', 'textPreview': 'avatar e2e', 'isRepost': False,
            'metrics': {'impressions': 1}, 'comments': []}]}, token=amy_token)
        admin = Client('sysadmin@demo.test')
        week = admin.request('/api/admin/lottery?week=2026-11-06')
        entrants = {row['memberId']: row for row in week['entrants']}
        audience = {row['memberId']: row for row in week['audience']}
        check('the lottery gives an entrant\'s saved avatar', entrants[amy_id]['avatar'] == AVATAR_A)
        check('the lottery gives an audience member\'s saved avatar', audience[ben_id]['avatar'] == AVATAR_B)
        check('the lottery gives null for someone who never saved', audience[cal_id]['avatar'] is None)
        check('every entrant and audience row has an avatar key',
              all('avatar' in row for row in week['entrants'] + week['audience']))

        # --- reset ---------------------------------------------------------------------------------
        check('DELETE returns null', reset_avatar(amy) == {'avatar': None})
        check('GET is null again after DELETE', get_avatar(amy) == {'avatar': None})
        check('Amy\'s reset left Ben\'s alone', get_avatar(ben) == {'avatar': AVATAR_B})
        check('DELETE with nothing saved is still fine', reset_avatar(amy) == {'avatar': None})

        put_avatar(dee, AVATAR_V1)

        # --- what is stored, stored v1 rows, and a stored value that no longer validates ------------
        stop()  # the running server holds the database file locked
        with sql() as db:
            stored = dict(db.execute('SELECT id, avatar_json FROM members WHERE id IN (?, ?, ?)', (amy_id, ben_id, dee_id)))
            check('DELETE stored NULL on Amy\'s row', stored[amy_id] is None)
            check('Ben\'s avatar is stored on his own row as JSON', json.loads(stored[ben_id]) == AVATAR_B)
            check('a v1 save is stored as v2', json.loads(stored[dee_id]) == AVATAR_V1_UPGRADED)
            db.execute('UPDATE members SET avatar_json = ? WHERE id = ?',
                       (json.dumps({**AVATAR_B, 'hair': 'retired-style'}), ben_id))
            # Rows as a v1 server stored them: Amy is an entrant, Dee is in the audience.
            for member_id in (amy_id, dee_id):
                db.execute('UPDATE members SET avatar_json = ? WHERE id = ?', (json.dumps(AVATAR_V1), member_id))
        start()
        check('a stored v1 row reads back as v2 from GET (entrant)', get_avatar(amy) == {'avatar': AVATAR_V1_UPGRADED})
        check('a stored v1 row reads back as v2 from GET (audience)', get_avatar(dee) == {'avatar': AVATAR_V1_UPGRADED})
        week = admin.request('/api/admin/lottery?week=2026-11-06')
        entrants = {row['memberId']: row for row in week['entrants']}
        audience = {row['memberId']: row for row in week['audience']}
        check('the lottery gives a stored v1 entrant as v2', entrants[amy_id]['avatar'] == AVATAR_V1_UPGRADED)
        check('the lottery gives a stored v1 audience member as v2', audience[dee_id]['avatar'] == AVATAR_V1_UPGRADED)
        check('a stored avatar that no longer validates reads as null', get_avatar(ben) == {'avatar': None})
        week = admin.request('/api/admin/lottery?week=2026-11-06')
        check('and is null in the lottery too', {r['memberId']: r for r in week['audience']}[ben_id]['avatar'] is None)
        log = log_path.read_text()
        check('with a warning naming the member and the reason',
              re.search(rf'WARN.*stored avatar is invalid.*member_id={ben_id}.*hair \\?"retired-style\\?" is not an allowed value', log)
              is not None)

        # --- a database from before the column -------------------------------------------------------
        stop()
        with sql() as db:
            db.execute('ALTER TABLE members DROP COLUMN avatar_json')
        start()
        check('an existing database without the column starts, and every avatar reads as null',
              get_avatar(amy) == get_avatar(ben) == get_avatar(cal) == {'avatar': None})
        check('and saving works on it', put_avatar(amy, AVATAR_B) == {'avatar': AVATAR_B} and get_avatar(amy) == {'avatar': AVATAR_B})
        stop()
        with sql() as db:
            columns = [row[1] for row in db.execute('PRAGMA table_info(members)')]
            stored = db.execute('SELECT avatar_json FROM members WHERE id = ?', (amy_id,)).fetchone()[0]
        check('startup added the avatar_json column back, holding the new save',
              'avatar_json' in columns and json.loads(stored) == AVATAR_B)

        print(json.dumps({'result': 'PASS', 'checks': len(checks)}), flush=True)
    finally:
        if state['process'].poll() is None:
            stop()
