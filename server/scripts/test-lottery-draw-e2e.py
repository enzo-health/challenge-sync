#!/usr/bin/env python3
"""The official weekly draw (`src/lottery_draw.rs`) through its APIs, on a disposable database,
after cargo build. Nothing here touches the network: drand is two local fake relays
(LOTTERY_BEACON_URLS), signing with made-up signatures whose randomness is their SHA-256, so the
debug-only DEV_BEACON_SKIP_SIGNATURE_CHECK=1 stands in for the BLS check (that check is a unit test
against a real quicknet round in `src/beacon.rs`).

The server's clock is pinned with DEV_CLOCK_OFFSET_FILE and moved through draw Fridays:

* phases at every boundary, in a standard-time week (Fri 2026-11-20, 09:30 = 16:30Z), after the
  fall-back week (Fri 2026-11-06, 169 hours) and after the spring-forward week (Fri 2026-03-13,
  167 hours, 09:30 = 15:30Z): party until 09:29:59, frozen 09:30:00-09:34:59, the wheel
  09:35:00-11:59:59, party from 12:00:00 with the next draw and the stars for the week in progress;
* the freeze: by the cron's request (labelled `cron`), idempotent (`already-frozen`), the other
  UTC candidate time a no-op (`not-due`), the safety net when nobody called the freeze URL, many
  requests at once leaving exactly one record, only on the draw Friday; a list that never changes
  afterwards (an exclusion or a deletion later changes nothing), its hash the SHA-256 of its text;
* the seed: not fetched before its round's time; fetched at 09:35, from the second relay when the
  first fails; when every relay fails, no winner and the page says what failed (no local fallback),
  and the next request recovers; the winner recomputed here from the published formula;
* nobody posted (no winner, no fetch, nothing to redraw); exactly one entrant (they win);
* redraw: signed out, a regular member, and an admin viewing as a member are refused; a reason is
  required (blank, too long); a missing week is a 404; the redraw is recorded (who, why, which pick
  it replaced) and seeded by a later round; a second redraw before that seed is refused; earlier
  winners are never drawn again; once everyone has won, refused saying so;
* the public API carries only the allowed fields (no emails, LinkedIn data, or the redrawing
  admin's id), and /lottery and its API are reachable signed out while nothing else became public.
"""
import concurrent.futures
import contextlib
import datetime as dt
import hashlib
import http.cookiejar
import http.server
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'
GENESIS, PERIOD = 1692803367, 3
checks = []


def check(name, condition, detail=''):
    assert condition, f'{name} {detail}'
    checks.append(name)
    print('PASS:', name, flush=True)


def utc(value):
    return int(dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc).timestamp())


def round_at_or_after(t):
    return 1 if t <= GENESIS else (t - GENESIS + PERIOD - 1) // PERIOD + 1


def round_time(r):
    return GENESIS + (r - 1) * PERIOD


def fake_beacon(round_):
    signature = (hashlib.sha256(b'fake signature %d' % round_).digest()
                 + hashlib.sha256(b'fake signature tail %d' % round_).digest())[:48]
    return {'round': round_, 'randomness': hashlib.sha256(signature).hexdigest(), 'signature': signature.hex()}


class Relay:
    """A local stand-in for one drand HTTP relay, counting what it is asked."""

    def __init__(self):
        self.down = False
        self.requests = []
        relay = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                relay.requests.append(self.path)
                match = re.fullmatch(rf'/{CHAIN}/public/(\d+)', self.path)
                if relay.down or not match:
                    body, code = b'relay is down for the test', 500
                else:
                    body, code = json.dumps(fake_beacon(int(match.group(1)))).encode(), 200
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def pick(list_hash, randomness, sequence, n):
    return int(hashlib.sha256(f'{list_hash}:{randomness}:{sequence}'.encode()).hexdigest(), 16) % n


relay_a, relay_b = Relay(), Relay()

with tempfile.TemporaryDirectory(prefix='lottery-draw-e2e-') as directory:
    db_path = Path(directory) / 'test.db'
    log_path = Path(directory) / 'server.log'
    clock_path = Path(directory) / 'clock-offset'
    state = {}

    def set_clock(unix):
        # The offset is whole seconds and the server adds it to its own clock, so write it just after
        # a second ticks over: the next ~0.9 s of requests then see exactly `unix`, which the
        # boundary checks (09:29:59 / 09:30:00 …) need.
        time.sleep(1.02 - time.time() % 1)
        clock_path.write_text(str(unix - int(time.time())))

    def start():
        log = log_path.open('a')
        state['process'] = subprocess.Popen(
            [str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
            env={**os.environ, 'DATABASE_URL': f'turso:{db_path}', 'SEED_DEMO': '1', 'PORT': '0',
                 'DEV_CLOCK_OFFSET_FILE': str(clock_path), 'LOTTERY_BEACON_URLS': f'{relay_a.url},{relay_b.url}',
                 'DEV_BEACON_SKIP_SIGNATURE_CHECK': '1'},
            stdout=log, stderr=log)
        seen = len(re.findall(r'listening on http://[^:]+:(\d+)', log_path.read_text()))
        for _ in range(300):
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

        def raw(self, path, data=None, method=None, token=None, headers=None):
            all_headers = {'Content-Type': 'application/json', **(headers or {})}
            if token:
                all_headers['Authorization'] = 'Bearer ' + token
            request = urllib.request.Request(state['base'] + path, headers=all_headers, method=method,
                                             data=json.dumps(data).encode() if data is not None else None)
            try:
                response = self.opener.open(request)
            except urllib.error.HTTPError as error:
                response = error
            return response.code, response.headers, response.read()

        def request(self, path, data=None, method=None, token=None, status=200, headers=None):
            code, response_headers, body = self.raw(path, data, method, token, headers)
            assert code == status, (path, code, status, body[:400])
            return json.loads(body) if response_headers.get_content_type() == 'application/json' else body.decode()

    no_redirect = urllib.request.build_opener(type('NoRedirect', (urllib.request.HTTPRedirectHandler,), {
        'redirect_request': lambda *args, **kwargs: None}))

    def page_status(path):
        try:
            response = no_redirect.open(state['base'] + path)
        except urllib.error.HTTPError as error:
            return error.code, error.headers.get('Location')
        return response.code, None

    set_clock(utc('2026-10-25T18:00:00Z'))
    start()
    try:
        anon = Client()

        def person(name):
            client = Client()
            slug = name.split()[0].lower()
            client.request('/api/auth/signup', {'name': name, 'email': f'{slug}-draw-e2e@enzo.health',
                                                'password': 'DrawE2E!pass123'})
            session = next(c.value for c in client.jar if c.name == 'session')
            token = client.request('/api/auth/device/session', {'sessionToken': session})['syncToken']
            return client, token, client.request('/api/auth/me')['memberId']

        ann, ann_token, ann_id = person('Ann Draw')
        bob, bob_token, bob_id = person('Bob Draw')
        cat, cat_token, cat_id = person('Cat Draw')
        dan, dan_token, dan_id = person('Dan Solo')
        hal, hal_token, hal_id = person('Hal Fall')
        org, org_token, org_id = person('Olga Organiser')
        fay, _, fay_id = person('Fay Quiet')
        emails = [f'{n}-draw-e2e@enzo.health' for n in ('ann', 'bob', 'cat', 'dan', 'hal', 'olga', 'fay')]

        def post(urn, created):
            return {'urn': urn, 'permalink': f'https://www.linkedin.com/feed/update/{urn}/', 'createdAt': created,
                    'textPreview': 'draw e2e', 'isRepost': False, 'metrics': {'impressions': 1}, 'comments': []}

        def sync(token, posts):
            anon.request('/api/sync', {'profile': {'followerCount': 100}, 'posts': posts}, token=token)

        # The week of 2026-11-13 (drawn Fri 2026-11-20): Ann (2), Bob, Cat, and the organiser.
        sync(ann_token, [post('urn:li:activity:d-ann1', '2026-11-14T15:00:00Z'), post('urn:li:activity:d-ann2', '2026-11-16T15:00:00Z')])
        sync(bob_token, [post('urn:li:activity:d-bob1', '2026-11-15T15:00:00Z')])
        sync(cat_token, [post('urn:li:activity:d-cat1', '2026-11-20T06:59:59Z')])  # Thu 23:59:59 MST
        sync(org_token, [post('urn:li:activity:d-org1', '2026-11-16T15:00:00Z')])
        # The fall-back week of 2026-10-30 (drawn Fri 2026-11-06): Hal.
        sync(hal_token, [post('urn:li:activity:d-hal1', '2026-11-01T18:00:00Z')])
        # The week of 2026-11-20 (drawn Fri 2026-11-27): only Dan.
        sync(dan_token, [post('urn:li:activity:d-dan1', '2026-11-21T18:00:00Z')])

        stop()
        with sql() as db:
            # Nobody else posts in the weeks under test: the demo seed's posts would make the lists
            # depend on the day this test runs.
            db.execute("DELETE FROM posts WHERE urn NOT LIKE 'urn:li:activity:d-%'")
        start()

        admin = Client('sysadmin@demo.test')
        admin.request(f'/api/admin/lottery/exclusions/{org_id}', {'excluded': True}, method='PUT')

        def lottery(client=anon):
            return client.request('/api/lottery')

        def freeze(headers=None):
            return anon.request('/api/lottery/freeze', headers=headers)

        CRON = {'User-Agent': 'vercel-cron/1.0'}

        # --- the fall-back week: Fri 2026-11-06, MST, the cron freezes ------------------------------
        set_clock(utc('2026-11-06T16:29:59Z'))  # 09:29:59 MST
        state_ = lottery()
        check('09:29:59 on the draw Friday is still the party', state_['phase'] == 'party' and state_['draw'] is None)
        check('the party is about today\'s draw of the fall-back week (169 hours)',
              (state_['schedule']['drawDay'], state_['schedule']['firstDay'], state_['schedule']['lastDay'],
               state_['schedule']['freezeAt']) == ('2026-11-06', '2026-10-30', '2026-11-05', '2026-11-06T09:30:00-07:00'))
        stars = {p['memberId']: p['postCount'] for p in state_['party']}
        check('before the freeze the stars are for the week about to be drawn (Hal posted in it)',
              stars.get(hal_id) == 1 and stars.get(ann_id) == 0 and stars.get(fay_id) == 0)
        check('everyone not deleted is at the party, sorted by name',
              {ann_id, bob_id, cat_id, dan_id, hal_id, org_id, fay_id} <= set(stars)
              and [p['displayName'].lower() for p in state_['party']] == sorted(p['displayName'].lower() for p in state_['party']))
        out = freeze(CRON)
        check('the freeze URL before 09:30 is not due and names the next freeze',
              out['action'] == 'not-due' and out['nextFreezeAt'] == '2026-11-06T09:30:00-07:00')
        check('no official draw exists before the freeze', admin.request('/api/admin/lottery/draws')['draws'] == [])

        set_clock(utc('2026-11-06T16:30:00Z'))  # 09:30:00 MST
        out = freeze(CRON)
        check('at 09:30:00 the cron\'s call freezes the list', out['action'] == 'frozen' and out['drawDay'] == '2026-11-06'
              and out['seed'] == 'waiting')
        check('calling it again changes nothing', freeze(CRON)['action'] == 'already-frozen'
              and freeze()['action'] == 'already-frozen')
        state_ = lottery()
        draw = state_['draw']
        check('09:30:00 is the frozen phase with the draw', state_['phase'] == 'frozen' and draw is not None)
        check('the record says the cron froze it, at 09:30:00, not late',
              draw['frozenBy'] == 'cron' and draw['frozenAt'] == '2026-11-06T09:30:00-07:00' and draw['frozenLate'] is False)
        check('the frozen list is Hal alone, and its text is the documented format',
              [e['memberId'] for e in draw['entrants']] == [hal_id] and draw['listText'] ==
              f'Challenge Sync weekly lottery, entrant list v1\nweek 2026-10-30 to 2026-11-05 America/Denver\nentrants 1\n{hal_id} 1 Hal Fall\n')
        check('the list hash is the SHA-256 of the text', draw['listHash'] == hashlib.sha256(draw['listText'].encode()).hexdigest())
        first = draw['results'][0]
        seed_at = utc('2026-11-06T16:35:00Z')
        check('the seed round is fixed at the freeze: the first published at or after 09:35:00',
              first['round'] == round_at_or_after(seed_at) and first['roundAtUnix'] == round_time(first['round'])
              and first['status'] == 'waiting' and first['winner'] is None)
        check('nothing was fetched from the beacon before 09:35', relay_a.requests == [] and relay_b.requests == [])
        set_clock(utc('2026-11-06T16:34:59Z'))
        check('09:34:59 is still frozen', lottery()['phase'] == 'frozen' and relay_a.requests == [])

        set_clock(utc('2026-11-06T16:35:00Z'))
        state_ = lottery()
        first = state_['draw']['results'][0]
        beacon = fake_beacon(first['round'])
        check('09:35:00 opens the wheel and the seed is fetched once',
              state_['phase'] == 'spin' and first['status'] == 'drawn' and len(relay_a.requests) == 1)
        check('the stored seed is the beacon\'s', (first['randomness'], first['signature']) == (beacon['randomness'], beacon['signature']))
        check('one entrant: they win, through the same formula (index 0 of 1)',
              first['winner']['memberId'] == hal_id and first['winnerIndex'] == 0 and first['eligible'] == [hal_id])
        check('the page shows what was hashed and the digest',
              first['pickInput'] == f"{state_['draw']['listHash']}:{beacon['randomness']}:1"
              and first['pickDigest'] == hashlib.sha256(first['pickInput'].encode()).hexdigest())
        check('a second look does not fetch again, and gives the same answer',
              lottery()['draw']['results'] == state_['draw']['results'] and len(relay_a.requests) == 1)
        set_clock(utc('2026-11-06T18:59:59Z'))
        check('11:59:59 is still the wheel', lottery()['phase'] == 'spin')
        set_clock(utc('2026-11-06T19:00:00Z'))
        state_ = lottery()
        check('12:00:00 is the party again, for the next draw and the week in progress',
              state_['phase'] == 'party' and state_['schedule']['drawDay'] == '2026-11-13'
              and state_['schedule']['firstDay'] == '2026-11-06' and state_['draw'] is None)
        past = anon.request('/api/lottery/results')['draws']
        check('after noon the draw is in the past results',
              [d['schedule']['drawDay'] for d in past] == ['2026-11-06'] and past[0]['results'][0]['winner']['memberId'] == hal_id)

        # --- a standard week: Fri 2026-11-20; nobody calls the freeze URL ------------------------
        set_clock(utc('2026-11-20T15:30:00Z'))  # 08:30 MST: the cron's other (daylight-time) slot
        check('the cron\'s other UTC slot is a no-op in standard time', freeze(CRON)['action'] == 'not-due')
        state_ = lottery()
        stars = {p['memberId']: p['postCount'] for p in state_['party']}
        check('Friday morning the stars are for the week just ended (Ann 2, Bob, Cat; the organiser is left out)',
              stars[ann_id] == 2 and stars[bob_id] == 1 and stars[cat_id] == 1 and stars[org_id] == 0 and stars[dan_id] == 0)
        set_clock(utc('2026-11-20T16:30:00Z'))
        with concurrent.futures.ThreadPoolExecutor(12) as pool:
            answers = list(pool.map(lambda i: (lottery() if i % 2 else freeze()), range(12)))
        draws = [d for d in admin.request('/api/admin/lottery/draws')['draws'] if d['schedule']['drawDay'] == '2026-11-20']
        check('twelve requests at 09:30:00 at once leave exactly one frozen list with one first pick',
              len(draws) == 1 and len(draws[0]['results']) == 1 and draws[0]['results'][0]['sequence'] == 1)
        check('every one of them saw that same list', len({a['draw']['listHash'] for a in answers if 'draw' in a}) == 1
              and sum(1 for a in answers if a.get('action') == 'frozen') <= 1)
        week = draws[0]
        check('the safety net froze it (nobody called the freeze URL as the cron)',
              week['frozenBy'] in ('safety-net', 'freeze-endpoint'))
        expected = sorted([ann_id, bob_id, cat_id])
        check('the frozen list is the week\'s entrants by the lottery\'s rule, in member id order',
              [e['memberId'] for e in week['entrants']] == expected
              and {e['memberId']: e['postCount'] for e in week['entrants']} == {ann_id: 2, bob_id: 1, cat_id: 1})
        check('it matches the admin lottery for that week',
              sorted(e['memberId'] for e in admin.request('/api/admin/lottery?week=2026-11-13')['entrants']) == expected)

        # The beacon fails at 09:35: both relays.
        relay_a.down = relay_b.down = True
        set_clock(utc('2026-11-20T16:35:00Z'))
        state_ = lottery()
        first = state_['draw']['results'][0]
        problem = state_['draw']['seedProblem'] or ''
        check('with every relay failing there is no winner, and no local randomness',
              state_['phase'] == 'spin' and first['status'] == 'unavailable' and first['winner'] is None
              and first['randomness'] is None)
        check('the page says what failed at each relay',
              f'drand round {first["round"]}' in problem and problem.count('HTTP 500') == 2
              and relay_a.url.split('//')[1] in problem and relay_b.url.split('//')[1] in problem, problem)
        code, _, body = admin.raw('/api/admin/lottery/draws/2026-11-13/redraw', {'reason': 'too soon'}, method='POST')
        check('a redraw before the first winner is refused, saying why', code == 409 and b'has no winner yet' in body
              and b'HTTP 500' in body, body)
        relay_a.down = False
        before_b = len(relay_b.requests)
        state_ = lottery()
        first = state_['draw']['results'][0]
        check('the next request recovers: the seed is fetched and the winner drawn',
              first['status'] == 'drawn' and state_['draw']['seedProblem'] is None and len(relay_b.requests) == before_b)
        list_hash = state_['draw']['listHash']
        n1 = pick(list_hash, first['randomness'], 1, 3)
        check('the winner is the published formula over the frozen list, recomputed here',
              first['winnerIndex'] == n1 and first['winner']['memberId'] == expected[n1] and first['eligible'] == expected)
        winner1 = first['winner']['memberId']

        # --- redraws ------------------------------------------------------------------------------
        def redraw(client, reason, week='2026-11-13', status=200):
            return client.request(f'/api/admin/lottery/draws/{week}/redraw', {'reason': reason}, method='POST', status=status)

        code, _, _ = anon.raw('/api/admin/lottery/draws/2026-11-13/redraw', {'reason': 'x'}, method='POST')
        check('a signed-out redraw is refused (401)', code == 401)
        refusal = redraw(ann, 'I would like to win', status=401)
        check('a regular member cannot redraw', 'admins only' in refusal['error'])
        viewer = Client('sysadmin@demo.test')
        viewer.request('/api/system/impersonate', {'memberId': ann_id})
        check('an admin viewing as a member cannot either', redraw(viewer, 'as ann', status=401) == refusal)
        check('signed out, the admin draws list is refused too', anon.raw('/api/admin/lottery/draws')[0] == 401)
        check('a reason is required', 'reason is required' in redraw(admin, '', status=400)['error']
              and 'reason is required' in redraw(admin, '   \n ', status=400)['error'])
        check('a reason over 500 characters is refused', 'longest allowed is 500' in redraw(admin, 'x' * 501, status=400)['error'])
        check('a week with no official draw is a 404', 'no official draw' in redraw(admin, 'why', week='2026-10-16', status=404)['error'])
        reason = '  Winner already got a prize this month  '
        out = redraw(admin, reason)
        second = out['results'][1]
        now = utc('2026-11-20T16:35:00Z')
        check('a redraw is recorded: who, why, what it replaced, seeded by a round a few seconds later',
              second['sequence'] == 2 and second['redraw'] == {'byName': 'System Operator', 'reason': reason.strip(), 'replacesSequence': 1}
              and second['round'] == round_at_or_after(now + 6) and second['status'] == 'waiting'
              and out['redrawnBy'] == [{'sequence': 2, 'memberId': admin.request('/api/auth/me')['memberId']}], second)
        check('the first pick is unchanged', out['results'][0] == first)
        check('a second redraw before the first one\'s seed is refused',
              'pick 2 of this week has no winner yet' in redraw(admin, 'again', status=409)['error'])
        set_clock(now + 12)
        state_ = lottery()
        second = state_['draw']['results'][1]
        eligible2 = [m for m in expected if m != winner1]
        n2 = pick(list_hash, second['randomness'], 2, 2)
        check('the redraw is drawn among the list minus the earlier winner, by the same formula',
              second['status'] == 'drawn' and second['eligible'] == eligible2 and second['winnerIndex'] == n2
              and second['winner']['memberId'] == eligible2[n2] != winner1)
        check('the public view names the redrawing admin but not their id',
              'redrawnBy' not in state_['draw'] and second['redraw']['byName'] == 'System Operator')
        redraw(admin, 'third time')
        set_clock(now + 24)
        third = lottery()['draw']['results'][2]
        check('the third pick goes to the one entrant who has not won', third['eligible'] == [m for m in eligible2 if m != eligible2[n2]]
              and third['winnerIndex'] == 0)
        error = redraw(admin, 'fourth', status=409)['error']
        check('once everyone has won, a redraw is refused saying so', 'every entrant in this draw has already won (3 of 3)' in error, error)

        # The list never changes; a deleted winner keeps their name in the result.
        admin.request(f'/api/admin/lottery/exclusions/{ann_id}', {'excluded': True}, method='PUT')
        admin.request(f'/api/system/members/{bob_id}', method='DELETE')
        after = lottery()['draw']
        check('an exclusion or a deletion after the freeze changes neither the list nor its hash',
              [e['memberId'] for e in after['entrants']] == expected and after['listHash'] == list_hash)
        check('the results keep every winner\'s name as it was', [r['winner']['displayName'] for r in after['results']]
              == [r['winner']['displayName'] for r in lottery()['draw']['results']] and
              any(r['winner']['displayName'] == 'Bob Draw' for r in after['results']))

        # --- what the public sees -----------------------------------------------------------------
        allowed = {
            'nowUnix', 'phase', 'schedule', 'party', 'draw', 'drawDay', 'firstDay', 'lastDay', 'freezeAt', 'seedAt',
            'closesAt', 'freezeAtUnix', 'seedAtUnix', 'closesAtUnix', 'timezone', 'memberId', 'displayName',
            'postCount', 'avatar', 'frozenAt', 'frozenAtUnix', 'frozenBy', 'frozenLate', 'listText', 'listHash',
            'listFormat', 'formula', 'entrants', 'results', 'seedProblem', 'beacon', 'sequence', 'requestedAt',
            'round', 'roundAt', 'roundAtUnix', 'status', 'randomness', 'signature', 'eligible', 'pickInput',
            'pickDigest', 'winnerIndex', 'winner', 'redraw', 'byName', 'reason', 'replacesSequence', 'chainHash',
            'infoUrl', 'roundUrl', 'signatureVerified', 'draws',
        }
        avatar_fields = {'v', 'skin', 'outfit', 'accent', 'hairColor', 'hair', 'facialHair', 'hat', 'ears', 'eyes',
                         'brows', 'nose', 'mouth', 'build'}

        def keys(value, inside_avatar=False):
            if isinstance(value, dict):
                for key, item in value.items():
                    yield key, inside_avatar
                    yield from keys(item, key == 'avatar')
            elif isinstance(value, list):
                for item in value:
                    yield from keys(item, inside_avatar)

        bodies = {'spin': lottery(), 'results': None, 'party': None}
        set_clock(utc('2026-11-20T19:00:00Z'))
        bodies['party'] = lottery()
        bodies['results'] = anon.request('/api/lottery/results')
        for name, body in bodies.items():
            unexpected = {k for k, in_avatar in keys(body) if k not in (avatar_fields if in_avatar else allowed)}
            text = json.dumps(body).lower()
            check(f'the public {name} answer has only the allowed fields', not unexpected, unexpected)
            check(f'the public {name} answer has no emails or LinkedIn data',
                  not any(e in text for e in emails) and 'urn:li' not in text and 'linkedin.com' not in text
                  and '@' not in text.replace('"@', ''))
        check('the past results list the newest draw first, with its redraw history',
              [d['schedule']['drawDay'] for d in bodies['results']['draws']] == ['2026-11-20', '2026-11-06']
              and [r['sequence'] for r in bodies['results']['draws'][0]['results']] == [1, 2, 3])
        check('after noon the stars are for the week in progress (Dan)',
              {p['memberId']: p['postCount'] for p in bodies['party']['party']}.get(dan_id) == 1)

        # --- one entrant, the second relay, and the next week -----------------------------------
        set_clock(utc('2026-11-27T16:30:00Z'))
        freeze(CRON)
        relay_a.down = True
        set_clock(utc('2026-11-27T16:35:00Z'))
        before_b = len(relay_b.requests)
        relay_b.down = False
        first = lottery()['draw']['results'][0]
        check('when the first relay fails the second one is used', first['status'] == 'drawn' and len(relay_b.requests) == before_b + 1)
        check('exactly one entrant wins (Dan)', first['winner']['memberId'] == dan_id and first['eligible'] == [dan_id])
        relay_a.down = False

        # --- a week nobody froze on its Friday ----------------------------------------------------
        set_clock(utc('2026-12-05T18:00:00Z'))  # the Saturday after the 2026-12-04 draw day
        check('the day after a draw day nobody visited, no freeze is due', freeze(CRON)['action'] == 'not-due')
        lottery()
        days = [d['schedule']['drawDay'] for d in anon.request('/api/lottery/results')['draws']]
        check('and that week has no official draw, rather than one frozen late', '2026-12-04' not in days)

        # --- the spring-forward week: Fri 2026-03-13 (MDT, 09:30 = 15:30Z); nobody posted ----------
        set_clock(utc('2026-03-13T15:29:59Z'))
        check('09:29:59 MDT is the party', lottery()['phase'] == 'party')
        set_clock(utc('2026-03-13T15:30:00Z'))
        out = freeze(CRON)
        state_ = lottery()
        check('09:30:00 MDT (15:30Z) freezes, the 167-hour week of 2026-03-06',
              out['action'] == 'frozen' and state_['phase'] == 'frozen'
              and state_['schedule']['freezeAt'] == '2026-03-13T09:30:00-06:00' and state_['schedule']['firstDay'] == '2026-03-06')
        set_clock(utc('2026-03-13T16:30:00Z'))  # the cron's standard-time slot, 10:30 MDT
        check('the cron\'s other slot finds it already frozen', freeze(CRON)['action'] == 'already-frozen')
        set_clock(utc('2026-03-13T15:34:59Z'))
        check('09:34:59 MDT is frozen', lottery()['phase'] == 'frozen')
        fetched = len(relay_a.requests) + len(relay_b.requests)
        set_clock(utc('2026-03-13T15:35:00Z'))
        state_ = lottery()
        empty = state_['draw']
        check('nobody posted: a record with an empty list and no winner, and no beacon fetch',
              state_['phase'] == 'spin' and empty['entrants'] == [] and empty['results'][0]['status'] == 'empty'
              and empty['results'][0]['winner'] is None and len(relay_a.requests) + len(relay_b.requests) == fetched)
        check('nothing to redraw when nobody posted', 'nobody was in this week' in redraw(Client('sysadmin@demo.test'), 'why', week='2026-03-06', status=409)['error'])
        set_clock(utc('2026-03-13T17:59:59Z'))
        check('11:59:59 MDT is the wheel', lottery()['phase'] == 'spin')
        set_clock(utc('2026-03-13T18:00:00Z'))
        check('12:00:00 MDT is the party', lottery()['phase'] == 'party')

        # --- signed out: what is reachable --------------------------------------------------------
        check('the public page loads signed out', page_status('/lottery')[0] == 200)
        check('the API, past results and freeze URL answer signed out',
              all(anon.raw(p)[0] == 200 for p in ('/api/lottery', '/api/lottery/results', '/api/lottery/freeze')))
        check('paths under /lottery and /api/lottery that are not routes are not served',
              page_status('/lottery/other')[0] == 404 and anon.raw('/api/lottery/other')[0] == 404)
        check('nothing else became public: signed-out pages still go to sign-in, APIs still refuse',
              all(page_status(p)[1] == '/auth/login' for p in ('/', '/me', '/plaza', '/admin/lottery/present'))
              and all(anon.raw(p)[0] == 401 for p in ('/api/plaza/roster', '/api/admin/lottery/draws',
                                                      '/api/leaderboard', '/api/v1/posts')))
        check('the admin pages still send a signed-out visitor to sign in',
              page_status('/admin/lottery')[0] in (302, 303, 307) and page_status('/admin/lottery/official')[0] in (302, 303, 307))
        check('the admin lottery API is still refused signed out', anon.raw('/api/admin/lottery')[0] == 401)

        print(json.dumps({'result': 'PASS', 'checks': len(checks)}), flush=True)
    finally:
        stop()
        relay_a.server.shutdown()
        relay_b.server.shutdown()
