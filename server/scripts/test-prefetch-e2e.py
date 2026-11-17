#!/usr/bin/env python3
"""The busiest pages' prefetch.rs seeds, on a disposable database, after cargo build:

* signed in, `GET /__nx/prefetch?path=<page>` returns exactly the expected cache keys for `/`,
  `/me`, `/challenges` and `/reports` (URL state such as `?days=30` or `?sort=oldest&page=2`
  included), and each entry's `data` deep-equals the JSON body of that API call made with the same
  cookie;
* the hard-loaded page carries the same entries in its `__nx_seeds__` tag;
* the entries that depend on the viewer's time zone are seeded only with the `tz` cookie the shell
  writes, under that offset;
* signed out, the prefetch endpoint answers with the page's own redirect and no data; a non-admin
  gets the same refusal as the page on the admin-only pages, their own data elsewhere, and never
  the admin-only entries; a forged cookie seeds only the signed-out `/api/auth/me`; under "View
  as" the seeds are the target's, without the admin's; a request that also presents a bearer token
  is not given the reporting API's data;
* the prefetch response carries Server-Timing with its `seed-*` segments.
"""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TZ = '-07:00'
checks = []


def check(name, condition, detail=''):
    assert condition, f'{name}: {detail}'
    checks.append(name)
    print('PASS:', name, flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect)

with tempfile.TemporaryDirectory(prefix='prefetch-e2e-') as directory:
    db_path = Path(directory) / 'test.db'
    log_path = Path(directory) / 'server.log'
    log = log_path.open('a')
    env = {**os.environ, 'DATABASE_URL': f'turso:{db_path}', 'SEED_DEMO': '1', 'PORT': '0'}
    env.pop('NEXTRS_SERVER_TIMING', None)
    process = subprocess.Popen([str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
                               env=env, stdout=log, stderr=log)
    try:
        base = None
        for _ in range(200):
            ports = re.findall(r'listening on http://[^:]+:(\d+)', log_path.read_text())
            if ports:
                base = 'http://127.0.0.1:' + ports[-1]
                break
            if process.poll() is not None:
                raise RuntimeError(log_path.read_text())
            time.sleep(.05)
        if base is None:
            raise RuntimeError('server startup timed out: ' + log_path.read_text())

        def raw(path, cookies=None, data=None, headers=None):
            all_headers = {'Content-Type': 'application/json', **(headers or {})}
            if cookies:
                all_headers['Cookie'] = '; '.join(f'{k}={v}' for k, v in cookies.items())
            request = urllib.request.Request(base + path, headers=all_headers,
                                             data=json.dumps(data).encode() if data is not None else None)
            try:
                response = opener.open(request)
            except urllib.error.HTTPError as error:
                response = error
            return response.code, response.headers, response.read()

        def login(email):
            code, headers, body = raw('/api/auth/login', data={'email': email, 'password': 'demopassword'})
            assert code == 200, (email, code, body[:300])
            session = re.search(r'session=([^;]+)', headers.get('Set-Cookie', ''))
            assert session, headers
            return session[1]

        def prefetch(page, cookies, headers=None):
            return raw('/__nx/prefetch?path=' + urllib.parse.quote(page, safe=''), cookies, headers=headers)

        def entries_of(page, cookies, headers=None):
            code, response_headers, body = prefetch(page, cookies, headers)
            assert code == 200, (page, code, body[:300])
            return json.loads(body), response_headers

        def api(key, cookies, headers=None):
            url = key[0] + ('?' + urllib.parse.urlencode(key[1]) if len(key) > 1 else '')
            code, _, body = raw(url, cookies, headers=headers)
            return code, json.loads(body)

        def page_seeds(page, cookies):
            code, _, body = raw(page, cookies)
            assert code == 200, (page, code, body[:300])
            tag = re.search(rb'<script type="application/json" id="__nx_seeds__">(.*?)</script>', body, re.S)
            assert tag, f'{page}: no __nx_seeds__ tag'
            return json.loads(tag[1])

        def keys(entries):
            return sorted(json.dumps(e['key'], sort_keys=True) for e in entries)

        def expect(who, page, cookies, expected_keys):
            entries, headers = entries_of(page, cookies)
            check(f'{who} {page}: the expected keys', keys(entries) == keys([{'key': k} for k in expected_keys]),
                  keys(entries))
            for entry in entries:
                code, body = api(entry['key'], cookies)
                check(f'{who} {page}: {entry["key"][0]} equals the API', code == 200 and body == entry['data'],
                      (code, entry['key']))
            timing = headers.get('Server-Timing', '')
            check(f'{who} {page}: prefetch Server-Timing', 'seed-session;dur=' in timing and 'total;dur=' in timing,
                  timing)
            by_key = lambda entries: {json.dumps(e['key'], sort_keys=True): e['data'] for e in entries}
            check(f'{who} {page}: the page HTML carries the same seeds',
                  by_key(page_seeds(page, cookies)) == by_key(entries), keys(page_seeds(page, cookies)))
            return {e['key'][0]: e['data'] for e in entries}

        def refused(who, page, cookies, location, headers=None):
            code, response_headers, body = prefetch(page, cookies, headers)
            page_code, page_headers, _ = raw(page, cookies, headers=headers)
            check(f'{who} {page}: prefetch refused like the page',
                  code in (302, 303, 307) and response_headers.get('Location') == location
                  and page_code == code and page_headers.get('Location') == location
                  and b'"data"' not in body,
                  (code, response_headers.get('Location'), page_code, body[:200]))

        me = ['/api/auth/me']
        challenges = ['/api/challenges']
        keys_ = ['/api/system/api-keys']
        stats = lambda days: ['/api/stats/overview', {'days': days, 'timezone': TZ}]
        posts = lambda **p: ['/api/me/posts', {'sort': 'newest', 'page': 1, 'pageSize': 50, **p}]
        offset = dt.timezone(dt.timedelta(hours=-7))
        today = dt.datetime.now(offset).date()
        report = ['/api/v1/posts', {'since': f'{today - dt.timedelta(days=6)}T00:00:00{TZ}',
                                    'until': f'{today}T23:59:59{TZ}', 'timezone': TZ}]

        # --- signed out: the page's redirect, no data ------------------------------------------
        for page in ('/', '/me', '/challenges', '/reports'):
            refused('signed out', page, None, '/auth/login')

        # --- a system admin --------------------------------------------------------------------
        admin = {'session': login('sysadmin@demo.test'), 'tz': TZ}
        seeded = expect('admin', '/', admin, [me, challenges, stats(7)])
        check('admin /: me is the admin', seeded['/api/auth/me']['isSystemAdmin'] is True
              and seeded['/api/auth/me']['impersonatedBy'] is None, seeded['/api/auth/me'])
        expect('admin', '/?days=30', admin, [me, challenges, stats(30)])
        expect('admin', '/?days=15', admin, [me, challenges, stats(7)])  # nuqs falls back to 7
        expect('admin', '/me', admin, [me, challenges, posts()])
        expect('admin', '/me?filter=enzo&sort=oldest&page=2', admin,
               [me, challenges, posts(filter='enzo', sort='oldest', page=2)])
        expect('admin', '/me?sort=bogus&filter=', admin, [me, challenges, posts()])
        expect('admin', '/challenges', admin, [me, challenges])
        seeded = expect('admin', '/reports', admin, [me, challenges, report, keys_])
        check('admin /reports: the report covers seven local days',
              seeded['/api/v1/posts']['filters']['since'] == report[1]['since'], seeded['/api/v1/posts']['filters'])
        # No tz cookie (a first visit): the time-zone keyed entries are left to the page.
        no_tz = {'session': admin['session']}
        expect('admin without tz', '/', no_tz, [me, challenges])
        expect('admin without tz', '/reports', no_tz, [me, challenges, keys_])
        # A bearer token is judged by the key alone at the reporting API: not answered from the cookie.
        bearer = {'Authorization': 'Bearer csk_not_a_key'}
        entries, _ = entries_of('/reports', admin, bearer)
        code, _ = api(report, admin, bearer)
        check('admin + bearer /reports: no report seed, and the API refuses it',
              keys(entries) == keys([{'key': k} for k in (me, challenges, keys_)]) and code == 401, (keys(entries), code))

        # --- a member who is not an admin ------------------------------------------------------
        ada = {'session': login('ada@demo.test'), 'tz': TZ}
        seeded = expect('member', '/', ada, [me, stats(7)])
        ada_id = seeded['/api/auth/me']['memberId']
        check('member /: me is the member', seeded['/api/auth/me']['isSystemAdmin'] is False and ada_id, seeded)
        seeded = expect('member', '/me', ada, [me, posts()])
        refused('member', '/challenges', ada, '/')
        refused('member', '/reports', ada, '/')
        code, _ = api(challenges, ada)
        check('member: the API refuses the challenges the seeds left out', code == 401, code)

        # --- a cookie that is no session: only the signed-out me, as the API answers -------------
        forged = {'session': 'not-a-session', 'tz': TZ}
        seeded = expect('forged cookie', '/', forged, [me])
        check('forged cookie: me says signed out', seeded['/api/auth/me']['signedIn'] is False, seeded)

        # --- "View as": the target's seeds, never the admin's ----------------------------------
        viewer = {'session': login('sysadmin@demo.test'), 'tz': TZ}
        code, headers, body = raw('/api/system/impersonate', viewer, data={'memberId': ada_id})
        assert code == 200, (code, body)
        viewer['session'] = re.search(r'session=([^;]+)', headers['Set-Cookie'])[1]
        seeded = expect('view as member', '/', viewer, [me, stats(7)])
        check('view as member: me is the target, with the impersonator',
              seeded['/api/auth/me']['memberId'] == ada_id and seeded['/api/auth/me']['impersonatedBy'], seeded)
        expect('view as member', '/me', viewer, [me, posts()])
        refused('view as member', '/reports', viewer, '/')

        _, headers = entries_of('/reports', admin)
        print('sample prefetch /reports Server-Timing:', headers.get('Server-Timing'), flush=True)
        print(json.dumps({'result': 'PASS', 'checks': len(checks)}), flush=True)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
