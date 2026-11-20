#!/usr/bin/env python3
"""The plaza's two APIs (`GET /api/plaza/roster`, `POST /api/plaza/pass`) on a disposable database,
after cargo build. The live room (`../plaza/`) is not needed and not started.

* signed out: both APIs get the root middleware's 401; a forged session cookie gets the handler's
  `sign-in required` 401, like /api/me/posts;
* an ordinary member (not an admin, so refused by the challenge APIs) can call both;
* roster: `me` is the caller; `members` lists every member who is not deleted, each with exactly
  `id`, `name`, `avatar`, `postedThisWeek` (no email anywhere); a saved avatar comes back and an
  unsaved one is null; a member deleted through the system API, and one marked deleted in the
  database without their session being removed, are not listed and their sessions are refused by
  both APIs; `week` is the current lottery week;
* the star is the lottery's rule for the current week: an original post this week stars; only a
  reshare, only a post last week, only a post with no creation time (0) do not; an excluded member
  who posted keeps the star; and the starred set equals the entrants plus the excluded posters that
  `GET /api/admin/lottery?week=<this Friday>` reports for the same data;
* pass: with PLAZA_PASS_PRIVATE_KEY set to the dev key (`../plaza/dev-keys.env`) the pass verifies
  against the dev public key, checked independently with node's built-in Ed25519; it names the
  caller and expires 60 s after the server's clock; a member id in the body or query is ignored; a
  system admin viewing as a member gets that member's pass and roster `me`; the response is
  `Cache-Control: no-store`;
* configuration: PLAZA_PASS_PRIVATE_KEY unset or blank is a 503 with `plaza_key_missing` naming the
  variable; garbage is a 503 with `plaza_key_invalid` that does not echo the value; `roomUrl` is
  PLAZA_ROOM_URL when set and `ws://127.0.0.1:8787/room` (the debug default) when unset.

The server's clock is pinned with DEV_CLOCK_OFFSET_FILE (debug builds only) to Thursday 2026-11-19
10:00 in Denver, so the current lottery week is Friday 2026-11-13 to Thursday 2026-11-19 (ending at
Friday 2026-11-20 00:00) whenever the test runs.
"""
import base64
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
DEV_KEYS = ROOT.parent / 'plaza' / 'dev-keys.env'
OPTIONS = json.loads((ROOT / 'components/lottery/avatar-options.json').read_text())
DEV_ROOM_URL = 'ws://127.0.0.1:8787/room'
ROOM_URL = 'wss://plaza.example.test/room'
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

def utc(value):
    return int(dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc).timestamp())

def read_dev_keys():
    if not DEV_KEYS.exists():
        raise SystemExit(f'missing {DEV_KEYS}: the plaza dev key pair is needed to test passes')
    keys = {}
    for line in DEV_KEYS.read_text().splitlines():
        found = re.match(r'\s*(PLAZA_PASS_(?:PRIVATE|PUBLIC)_KEY)\s*=\s*(\S+)\s*$', line)
        if found:
            keys[found[1]] = found[2].strip('"\'')
    missing = {'PLAZA_PASS_PRIVATE_KEY', 'PLAZA_PASS_PUBLIC_KEY'} - set(keys)
    if missing:
        raise SystemExit(f'{DEV_KEYS} does not define {", ".join(sorted(missing))}')
    return keys['PLAZA_PASS_PRIVATE_KEY'], keys['PLAZA_PASS_PUBLIC_KEY']

# Node's crypto verifies Ed25519 without any extra package (Python's standard library cannot).
NODE_VERIFY = r'''
const crypto = require('crypto');
const [publicKey, pass] = process.argv.slice(1);
const x = Buffer.from(publicKey, 'base64').toString('base64url');
const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
const [payload, signature] = pass.split('.');
const ok = crypto.verify(null, Buffer.from(payload, 'base64url'), key, Buffer.from(signature, 'base64url'));
process.stdout.write(JSON.stringify({ ok, payload: Buffer.from(payload, 'base64url').toString('utf8') }));
'''

def node_verify(public_key, pass_):
    out = subprocess.run(['node', '-e', NODE_VERIFY, public_key, pass_], capture_output=True, text=True, check=True)
    result = json.loads(out.stdout)
    return result['ok'], json.loads(result['payload'])

def tamper(pass_):
    """The same pass claiming someone else, keeping the original signature."""
    payload, signature = pass_.split('.')
    claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    claims['m'] += 1
    forged = base64.urlsafe_b64encode(json.dumps(claims, separators=(',', ':')).encode()).decode().rstrip('=')
    return forged + '.' + signature

def private_to_public(private_key):
    """The public key for a base64 seed, by node (to check the dev pair belongs together)."""
    script = r'''
const crypto = require('crypto');
const seed = Buffer.from(process.argv[1], 'base64');
const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const key = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
process.stdout.write(Buffer.from(key.export({ format: 'jwk' }).x, 'base64url').toString('base64'));
'''
    return subprocess.run(['node', '-e', script, private_key], capture_output=True, text=True, check=True).stdout

PRIVATE_KEY, PUBLIC_KEY = read_dev_keys()
ACCOUNTS_CREATED = utc('2026-10-20T18:00:00Z')
NOW = utc('2026-11-19T17:00:00Z')  # Thursday 2026-11-19, 10:00 MST; the last day of the week of Friday 2026-11-13
THIS_FRIDAY = '2026-11-13'
AVATAR = {'v': OPTIONS['version'], **{key: values[0] for key, values in OPTIONS.items() if key != 'version'}}

with tempfile.TemporaryDirectory(prefix='plaza-e2e-') as directory:
    db_path = Path(directory) / 'test.db'
    log_path = Path(directory) / 'server.log'
    clock_path = Path(directory) / 'clock-offset'
    state = {}

    def set_clock(unix):
        clock_path.write_text(str(unix - int(time.time())))

    def start(private_key=PRIVATE_KEY, room_url=ROOM_URL):
        """`None` leaves a variable unset (removed from the inherited environment)."""
        env = {key: value for key, value in os.environ.items()
               if key not in ('PLAZA_PASS_PRIVATE_KEY', 'PLAZA_PASS_PUBLIC_KEY', 'PLAZA_ROOM_URL')}
        env.update({'DATABASE_URL': f'turso:{db_path}', 'SEED_DEMO': '1', 'PORT': '0',
                    'DEV_CLOCK_OFFSET_FILE': str(clock_path), 'RUST_LOG': 'warn'})
        if private_key is not None:
            env['PLAZA_PASS_PRIVATE_KEY'] = private_key
        if room_url is not None:
            env['PLAZA_ROOM_URL'] = room_url
        log = log_path.open('a')
        state['process'] = subprocess.Popen([str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
            env=env, stdout=log, stderr=log)
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

    def restart(**env):
        stop()
        start(**env)

    @contextlib.contextmanager
    def sql():
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
            assert code == status, (path, method, code, status, body[:500])
            return json.loads(body) if headers.get_content_type() == 'application/json' else body.decode()

    def roster(client, status=200):
        return client.request('/api/plaza/roster', status=status)
    def get_pass(client, status=200, data=None, query=''):
        return client.request('/api/plaza/pass' + query, data, method='POST', status=status)

    set_clock(ACCOUNTS_CREATED)
    start()
    try:
        anon = Client()

        def person(name):
            client = Client()
            slug = name.split()[0].lower()
            client.request('/api/auth/signup', {'name': name, 'email': f'{slug}-plaza-e2e@enzo.health',
                                                'password': 'PlazaE2E!pass123'})
            session = next(c.value for c in client.jar if c.name == 'session')
            token = client.request('/api/auth/device/session', {'sessionToken': session})['syncToken']
            return client, token, client.request('/api/auth/me')['memberId']

        ann, ann_token, ann_id = person('Ann Original')   # an original this week: star
        bob, bob_token, bob_id = person('Bob Reshare')    # only a reshare this week
        cat, cat_token, cat_id = person('Cat Lastweek')   # only a post last week
        dee, dee_token, dee_id = person('Dee Undated')    # only a post with no creation time
        exa, exa_token, exa_id = person('Exa Excluded')   # posted this week, excluded from the draw
        fay, _, fay_id = person('Fay Quiet')              # never posts
        eve, eve_token, eve_id = person('Eve Deleted')    # posts this week, deleted through the API
        gil, gil_token, gil_id = person('Gil Marked')     # posts this week, marked deleted in the db
        set_clock(NOW)

        def post(urn, created, is_repost=False):
            return {'urn': urn, 'permalink': f'https://www.linkedin.com/feed/update/{urn}/', 'createdAt': created,
                    'textPreview': 'plaza e2e', 'isRepost': is_repost, 'metrics': {'impressions': 1}, 'comments': []}
        def sync(token, posts):
            anon.request('/api/sync', {'profile': {'followerCount': 100}, 'posts': posts}, token=token)

        sync(ann_token, [post('urn:li:activity:plann1', '2026-11-17T15:00:00Z'),
                         post('urn:li:activity:plann2', '2026-11-12T15:00:00Z')])  # and one last week
        sync(bob_token, [post('urn:li:activity:plbob1', '2026-11-17T15:00:00Z', is_repost=True)])
        sync(cat_token, [post('urn:li:activity:plcat1', '2026-11-13T06:59:59Z')])  # Thu 23:59:59 MST, last week
        sync(dee_token, [post('urn:li:activity:pldee1', None)])                     # stored with created_at 0
        sync(exa_token, [post('urn:li:activity:plexa1', '2026-11-18T15:00:00Z')])
        sync(eve_token, [post('urn:li:activity:pleve1', '2026-11-17T15:00:00Z')])
        sync(gil_token, [post('urn:li:activity:plgil1', '2026-11-17T15:00:00Z')])
        ann.request('/api/me/avatar', AVATAR, method='PUT')

        sysadmin = Client('sysadmin@demo.test')
        sysadmin.request(f'/api/admin/lottery/exclusions/{exa_id}', {'excluded': True}, method='PUT')

        # --- signed out -----------------------------------------------------------------------------
        def bare(client, path, method=None):
            code, headers, body = client.raw(path, method=method)
            return code, headers.get_content_type(), body
        reference = bare(anon, '/api/me/posts')
        check('no session cookie: /api/me/posts is a 401 (the reference)', reference[0] == 401)
        check('no session cookie: the roster gets the same 401', bare(anon, '/api/plaza/roster') == reference)
        check('no session cookie: the pass gets the same 401', bare(anon, '/api/plaza/pass', 'POST') == reference)
        forged = Client()
        forged.jar.set_cookie(http.cookiejar.Cookie(0, 'session', 'not-a-session', None, False, '127.0.0.1', False,
            False, '/', True, False, None, False, None, None, {}))
        refusal = forged.request('/api/me/posts', status=401)
        check('a forged session: /api/me/posts says sign-in required', refusal == {'error': 'sign-in required'})
        check('a forged session: the roster gets the same 401', roster(forged, status=401) == refusal)
        check('a forged session: the pass gets the same 401', get_pass(forged, status=401) == refusal)

        # --- an ordinary member ---------------------------------------------------------------------
        ann.request('/api/admin/lottery', status=401)
        check('Ann is an ordinary member: the challenge APIs refuse her', True)
        mine = roster(ann)
        check('an ordinary member can read the roster, and `me` is her id', mine['me'] == ann_id)
        check('the response has exactly me, roomUrl, week and members', set(mine) == {'me', 'roomUrl', 'week', 'members'})
        check('roomUrl is PLAZA_ROOM_URL when set', mine['roomUrl'] == ROOM_URL)
        check('week is the current lottery week',
              mine['week'] == {'weekStart': THIS_FRIDAY, 'weekEnd': '2026-11-20', 'startsAt': '2026-11-13T00:00:00-07:00',
                               'endsAt': '2026-11-20T00:00:00-07:00', 'timezone': 'America/Denver'})
        members = {row['id']: row for row in mine['members']}
        check('every member has exactly id, name, avatar and postedThisWeek',
              all(set(row) == {'id', 'name', 'avatar', 'postedThisWeek'} for row in mine['members']))
        check('no email anywhere in the roster', '@' not in json.dumps(mine))
        check('names are display names', members[ann_id]['name'] == 'Ann Original' and members[fay_id]['name'] == 'Fay Quiet')
        check('a saved avatar comes back', members[ann_id]['avatar'] == AVATAR)
        check('an unsaved avatar is null', members[fay_id]['avatar'] is None)
        keys = [(row['name'].lower(), row['id']) for row in mine['members']]
        check('members are sorted by name ignoring case, then id', keys == sorted(keys))
        check('another member sees the same members', roster(fay)['members'] == mine['members'])

        # --- the star ---------------------------------------------------------------------------------
        starred = {id for id, row in members.items() if row['postedThisWeek']}
        check('an original post this week stars', ann_id in starred)
        check('only a reshare this week: no star', bob_id not in starred)
        check('only a post last week (Thursday 23:59:59 Denver): no star', cat_id not in starred)
        check('only a post with no creation time: no star', dee_id not in starred)
        check('never posted: no star', fay_id not in starred)
        check('excluded from the draw but posted: still starred', exa_id in starred)
        check('postedThisWeek is always a bool', all(isinstance(row['postedThisWeek'], bool) for row in members.values()))

        def lottery_posters():
            week = sysadmin.request('/api/admin/lottery?' + urllib.parse.urlencode({'week': THIS_FRIDAY}))
            return ({row['memberId'] for row in week['entrants']}
                    | {row['memberId'] for row in week['audience'] if row['excluded']}), week
        posters, week = lottery_posters()
        check('the stars are exactly the lottery\'s entrants plus excluded posters this week', starred == posters)
        check('and the roster lists exactly the lottery\'s entrants plus audience this week',
              set(members) == {row['memberId'] for row in week['entrants'] + week['audience']})

        # --- deleted members --------------------------------------------------------------------------
        check('before deletion, Eve and Gil are listed and starred', {eve_id, gil_id} <= starred)
        sysadmin.request(f'/api/system/members/{eve_id}', method='DELETE')
        stop()
        with sql() as db:  # deleted without removing the session, to exercise the handlers' own check
            db.execute('UPDATE members SET deleted_at = ? WHERE id = ?', (NOW, gil_id))
            check('Gil still has a session row', db.execute(
                'SELECT COUNT(*) FROM admin_sessions WHERE admin_id = ?', (gil_id,)).fetchone()[0] > 0)
        start()
        after = roster(ann)
        listed = {row['id'] for row in after['members']}
        check('a member deleted through the system API is not listed', eve_id not in listed)
        check('a member marked deleted in the database is not listed', gil_id not in listed)
        check('everyone else is still listed', set(members) - {eve_id, gil_id} == listed)
        for name, client in (('Eve', eve), ('Gil', gil)):
            check(f'{name}\'s old session is refused by the roster', roster(client, status=401) == refusal)
            check(f'{name}\'s old session is refused by the pass', get_pass(client, status=401) == refusal)
        posters, _ = lottery_posters()
        check('after deletion the stars still equal the lottery\'s posters',
              {row['id'] for row in after['members'] if row['postedThisWeek']} == posters)

        # --- the pass ---------------------------------------------------------------------------------
        check('the dev key pair in plaza/dev-keys.env belongs together', private_to_public(PRIVATE_KEY) == PUBLIC_KEY)
        code, headers, body = ann.raw('/api/plaza/pass', method='POST')
        issued = json.loads(body)
        check('an ordinary member gets a pass', code == 200 and set(issued) == {'pass', 'expiresAt'})
        check('the pass response is Cache-Control: no-store', headers.get('Cache-Control') == 'no-store')
        ok, claims = node_verify(PUBLIC_KEY, issued['pass'])
        check('the pass verifies against the dev public key (node Ed25519)', ok)
        check('the pass names the caller', claims['m'] == ann_id)
        check('the pass and the response agree on the expiry', claims['exp'] == issued['expiresAt'])
        server_now = int(time.time()) + int(clock_path.read_text())
        check('the pass expires about 60 s after the server\'s clock',
              abs(issued['expiresAt'] - (server_now + 60)) <= 5)
        check('a tampered pass does not verify (the check is real)', not node_verify(PUBLIC_KEY, tamper(issued['pass']))[0])
        _, other = node_verify(PUBLIC_KEY, get_pass(fay)['pass'])
        check('another member\'s pass names them', other['m'] == fay_id)

        smuggled = get_pass(ann, data={'memberId': fay_id, 'member_id': fay_id, 'm': fay_id},
                            query=f'?memberId={fay_id}&m={fay_id}')
        ok, claims = node_verify(PUBLIC_KEY, smuggled['pass'])
        check('a member id in the body or query is ignored', ok and claims['m'] == ann_id)

        viewer = Client('sysadmin@demo.test')
        viewer.request('/api/system/impersonate', {'memberId': bob_id})
        check('a system admin viewing as Bob reads the roster as Bob', roster(viewer)['me'] == bob_id)
        ok, claims = node_verify(PUBLIC_KEY, get_pass(viewer)['pass'])
        check('and gets Bob\'s pass, like the /api/me routes act as Bob', ok and claims['m'] == bob_id)

        # --- configuration ----------------------------------------------------------------------------
        restart(private_key=None, room_url=None)
        missing = get_pass(ann, status=503)
        check('PLAZA_PASS_PRIVATE_KEY unset: 503 plaza_key_missing naming the variable',
              missing['code'] == 'plaza_key_missing' and 'PLAZA_PASS_PRIVATE_KEY is not set' in missing['error'])
        check('PLAZA_ROOM_URL unset: roomUrl is the debug default', roster(ann)['roomUrl'] == DEV_ROOM_URL)
        check('the roster still works without a pass key', roster(ann)['me'] == ann_id)

        restart(private_key='   ', room_url=None)
        check('PLAZA_PASS_PRIVATE_KEY blank: also plaza_key_missing', get_pass(ann, status=503)['code'] == 'plaza_key_missing')

        garbage = 'definitely-not-a-key!!'
        restart(private_key=garbage, room_url=None)
        invalid = get_pass(ann, status=503)
        check('a garbage key: 503 plaza_key_invalid saying what was wrong',
              invalid['code'] == 'plaza_key_invalid' and 'not standard base64' in invalid['error'])
        check('the refusal does not echo the key', garbage not in invalid['error'])

        short = base64.b64encode(base64.b64decode(PRIVATE_KEY)[:16]).decode()
        restart(private_key=short, room_url=None)
        invalid = get_pass(ann, status=503)
        check('a 16-byte key: plaza_key_invalid naming the length, without the key',
              invalid['code'] == 'plaza_key_invalid' and '16 bytes, expected 32' in invalid['error']
              and short not in invalid['error'])

        print(json.dumps({'result': 'PASS', 'checks': len(checks)}), flush=True)
    finally:
        if state['process'].poll() is None:
            stop()
