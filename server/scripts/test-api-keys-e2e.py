#!/usr/bin/env python3
"""Members' own API keys, read-only enforcement, the public docs and the rate limit, on a
disposable database, after cargo build:

* any signed-in member can create, list and revoke keys of their own (name, dates, shown once,
  never listed), and a member's key reads /api/v1/posts, /members and /stats although they are
  not an admin;
* a member cannot see or revoke anyone else's key; nobody signed out can do anything with them;
* a "View as" session cannot make a key in the viewed member's name;
* a member may hold at most 5 keys; the sixth is refused with a 409 that says so;
* a revoked key (by its owner or by an admin) is refused with 401, and so is the key of an
  account an admin deleted;
* an admin sees every key with its owner and kind, and revokes any of them; an admin's own
  Reports-page key behaves as before (stops when they stop being an admin), while a personal key
  of the same person keeps working;
* a key is refused by every write and session route tried, as a bearer token, as the session
  cookie, and as a device session token; the /api/v1 routes take GET only;
* /api/v1/docs serves docs/reporting-api.md, byte for byte, signed out;
* a key may make 120 requests a minute; the next is a 429 with Retry-After and a JSON reason, the
  limit is per key, and it resets the next minute.
"""
import http.cookiejar
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
DOC = (ROOT.parent / 'docs' / 'reporting-api.md').read_bytes()
JOIN_CODE = 'e2e-api-keys-code'
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

with tempfile.TemporaryDirectory(prefix='api-keys-e2e-') as directory:
    log_path = Path(directory) / 'server.log'
    # Debug builds add this many seconds to the server's clock (DEV_CLOCK_OFFSET_FILE), so the
    # rate-limit check can start at the top of a minute and move to the next one without waiting.
    clock_path = Path(directory) / 'clock-offset'
    clock_path.write_text('0')
    with log_path.open('w') as log:
        process = subprocess.Popen([str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
            env={**os.environ, 'DATABASE_URL': f'turso:{directory}/test.db', 'SEED_DEMO': '1', 'PORT': '0',
                 'JOIN_CODE': JOIN_CODE, 'DEV_CLOCK_OFFSET_FILE': str(clock_path)},
            stdout=log, stderr=log)
    try:
        for _ in range(200):
            output = log_path.read_text()
            match = re.search(r'listening on http://[^:]+:(\d+)', output)
            if match:
                break
            if process.poll() is not None:
                raise RuntimeError(output)
            time.sleep(.05)
        else:
            raise RuntimeError('server startup timed out: ' + output)
        base = 'http://127.0.0.1:' + match[1]

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        class Response:
            def __init__(self, code, headers, body):
                self.code, self.headers, self.body = code, headers, body
            def json(self):
                return json.loads(self.body)

        class Client:
            def __init__(self, email=None, cookie=None):
                self.jar = http.cookiejar.CookieJar()
                self.opener = urllib.request.build_opener(
                    urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
                self.cookie = cookie
                if email:
                    self.request('/api/auth/login', {'email': email, 'password': 'demopassword'})
            def raw(self, path, data=None, method=None, token=None):
                headers = {'Content-Type': 'application/json'}
                if token:
                    headers['Authorization'] = 'Bearer ' + token
                if self.cookie:
                    headers['Cookie'] = 'session=' + self.cookie
                request = urllib.request.Request(base + path, headers=headers, method=method,
                    data=json.dumps(data).encode() if data is not None else None)
                try:
                    response = self.opener.open(request)
                except urllib.error.HTTPError as error:
                    response = error
                return Response(response.code, response.headers, response.read())
            def request(self, path, data=None, method=None, token=None, status=200):
                response = self.raw(path, data, method, token)
                assert response.code == status, (path, response.code, status, response.body)
                if response.headers.get_content_type() == 'application/json':
                    return response.json()
                return response.body.decode()

        anon = Client()
        admin = Client('sysadmin@demo.test')
        ada = Client('ada@demo.test')
        ben = Client('ben@demo.test')
        ada_id = ada.request('/api/auth/me')['memberId']
        ben_id = ben.request('/api/auth/me')['memberId']
        assert not ada.request('/api/auth/me')['isSystemAdmin']

        def reads(token):
            """The status of each reporting API read made with this key."""
            return [anon.raw(path, token=token).code
                    for path in ('/api/v1/posts', '/api/v1/members', '/api/v1/stats?days=30')]

        # --- a member's own keys ------------------------------------------------------------
        for path, method, data in [('/api/me/api-keys', None, None),
                                   ('/api/me/api-keys', 'POST', {'name': 'sneaky'}),
                                   ('/api/me/api-keys/1', 'DELETE', None)]:
            assert anon.raw(path, data, method).code == 401, path
        check('signed out, nobody can list, create or revoke keys', True)

        empty = ada.request('/api/me/api-keys')
        check('a member starts with no keys and is told the cap',
              empty['keys'] == [] and empty['maxKeys'] == 5 and empty['requestsPerMinute'] == 120)
        ada.request('/api/me/api-keys', {'name': '   '}, method='POST', status=400)
        ada.request('/api/me/api-keys', {'name': 'x' * 101}, method='POST', status=400)
        check('a key needs a name of 1 to 100 characters', True)

        created = ada.request('/api/me/api-keys', {'name': 'Claude on my laptop'}, method='POST')
        ada_key = created['key']
        check('a member (not an admin) can create a key, shown once with its csk_ prefix',
              ada_key.startswith('csk_') and len(ada_key) > 40 and created['name'] == 'Claude on my laptop')
        listed = ada.request('/api/me/api-keys')
        check('their list shows the key by name, never the key itself',
              [k['name'] for k in listed['keys']] == ['Claude on my laptop']
              and listed['keys'][0]['personal'] is True and listed['keys'][0]['lastUsedAt'] is None
              and ada_key not in json.dumps(listed))

        check("a member's key reads posts, members and stats", reads(ada_key) == [200, 200, 200])
        report = anon.request('/api/v1/posts?' + urllib.parse.urlencode({'since': '2000-01-01', 'until': '2000-12-31'}),
                              token=ada_key)
        check("a member's key reads everyone's report, the same shape an admin key reads",
              'posts' in report and 'authors' in report)
        check('using it records when it was last used',
              ada.request('/api/me/api-keys')['keys'][0]['lastUsedAt'] is not None)

        # --- other members ------------------------------------------------------------------
        check("another member does not see it", ben.request('/api/me/api-keys')['keys'] == [])
        ben.request(f"/api/me/api-keys/{created['id']}", method='DELETE', status=404)
        check("another member cannot revoke it (404, as for a key that does not exist)",
              reads(ada_key) == [200, 200, 200])
        for path, method, data in [('/api/system/api-keys', None, None),
                                   ('/api/system/api-keys', 'POST', {'name': 'sneaky'}),
                                   (f"/api/system/api-keys/{created['id']}", 'DELETE', None)]:
            assert ben.raw(path, data, method).code == 401, path
        check('a member cannot use the admin key routes', reads(ada_key) == [200, 200, 200])
        ben_key = ben.request('/api/me/api-keys', {'name': "Ben's agent"}, method='POST')['key']
        check("each member lists only their own keys",
              [k['name'] for k in ben.request('/api/me/api-keys')['keys']] == ["Ben's agent"]
              and [k['name'] for k in ada.request('/api/me/api-keys')['keys']] == ['Claude on my laptop'])

        # --- "View as" ----------------------------------------------------------------------
        viewing = Client('sysadmin@demo.test')
        viewing.request('/api/system/impersonate', {'memberId': ada_id}, method='POST')
        refused = viewing.request('/api/me/api-keys', {'name': 'not mine'}, method='POST', status=403)
        check('a "View as" session cannot make a key in the viewed member\'s name',
              refused.get('code') == 'impersonation_session'
              and len(ada.request('/api/me/api-keys')['keys']) == 1)

        # --- the cap ------------------------------------------------------------------------
        extra = [ada.request('/api/me/api-keys', {'name': f'spare {n}'}, method='POST') for n in range(4)]
        over = ada.request('/api/me/api-keys', {'name': 'one too many'}, method='POST', status=409)
        check('a member can hold 5 keys; the sixth is refused, saying why',
              len(ada.request('/api/me/api-keys')['keys']) == 5 and over.get('code') == 'api_key_limit'
              and '5' in over['error'] and 'revoke' in over['error'])
        ada.request(f"/api/me/api-keys/{extra[0]['id']}", method='DELETE')
        again = ada.request('/api/me/api-keys', {'name': 'after revoking one'}, method='POST')
        check('revoking one makes room for another', again['key'].startswith('csk_'))

        # --- revoking -----------------------------------------------------------------------
        check('a key its owner revoked is refused at once', reads(extra[0]['key']) == [401, 401, 401])
        ada.request(f"/api/me/api-keys/{extra[0]['id']}", method='DELETE', status=404)
        check('revoking it again is a 404', True)

        # --- the admin's view ---------------------------------------------------------------
        everyone = admin.request('/api/system/api-keys')['keys']
        ada_row = next(k for k in everyone if k['id'] == created['id'])
        check("an admin sees every member's keys with the owner's name, never the key",
              ada_row['createdByName'] == 'Ada Ortiz' and ada_row['personal'] is True
              and any(k['createdByName'] == 'Ben Cho' for k in everyone)
              and ada_key not in json.dumps(everyone) and ben_key not in json.dumps(everyone))
        admin.request(f"/api/system/api-keys/{extra[1]['id']}", method='DELETE')
        check("an admin can revoke a member's key, and it stops working",
              reads(extra[1]['key']) == [401, 401, 401]
              and extra[1]['id'] not in [k['id'] for k in ada.request('/api/me/api-keys')['keys']])

        # --- admin keys keep their rule; a personal key does not depend on being an admin ----
        def join(urn, first, last):
            joined = anon.request('/api/auth/extension/join', {'joinCode': JOIN_CODE, 'member': {
                'memberUrn': urn, 'publicIdentifier': f'{first}-{last}'.lower(), 'firstName': first,
                'lastName': last, 'profileUrl': f'https://www.linkedin.com/in/{first}-{last}'.lower()}})
            web = Client(cookie=anon.request('/api/auth/device/web-session', method='POST',
                                             token=joined['syncToken'])['sessionToken'])
            return joined['memberId'], joined['syncToken'], web
        ola_id, ola_sync, ola = join('urn:li:fsd_profile:OLA1', 'Ola', 'Organiser')
        admin.request(f'/api/system/members/{ola_id}/admin', {'isAdmin': True}, method='PUT')
        ola_admin_key = ola.request('/api/system/api-keys', {'name': 'Reports script'}, method='POST')
        ola_own_key = ola.request('/api/me/api-keys', {'name': 'My assistant'}, method='POST')['key']
        rows = {k['id']: k for k in admin.request('/api/system/api-keys')['keys']}
        check('an admin key made on the Reports page is listed as an admin key, not personal',
              rows[ola_admin_key['id']]['personal'] is False
              and [k['name'] for k in ola.request('/api/me/api-keys')['keys']] == ['My assistant'])
        check('while its creator is an admin, an admin key works',
              reads(ola_admin_key['key']) == [200, 200, 200] and reads(ola_own_key) == [200, 200, 200])
        admin.request(f'/api/system/members/{ola_id}/admin', {'isAdmin': False}, method='PUT')
        check('when its creator stops being an admin, their admin key stops (as before)',
              reads(ola_admin_key['key']) == [401, 401, 401])
        check('but their personal key keeps working', reads(ola_own_key) == [200, 200, 200])

        # --- a deleted account ---------------------------------------------------------------
        dee_id, _, dee = join('urn:li:fsd_profile:DEE1', 'Dee', 'Departing')
        dee_key = dee.request('/api/me/api-keys', {'name': 'Dee agent'}, method='POST')['key']
        assert reads(dee_key) == [200, 200, 200]
        admin.request(f'/api/system/members/{dee_id}', method='DELETE')
        check("a deleted member's key is refused", reads(dee_key) == [401, 401, 401])
        admin.request(f'/api/system/members/{dee_id}/restore', method='POST')
        check('and restoring the account does not bring the key back', reads(dee_key) == [401, 401, 401])

        # --- read-only: a key works nowhere but GET /api/v1/* --------------------------------
        key = ada_key
        as_cookie = Client(cookie=key)  # the key as the session cookie, past the root presence check
        bearer_routes = [  # the extension's routes, which take a bearer token
            ('/api/sync', 'POST', {'profile': {'followerCount': 1}, 'posts': []}),
            ('/api/me/sync-status', None, None),
            ('/api/link', 'POST', {'member': {'memberUrn': 'urn:li:fsd_profile:KEY1', 'publicIdentifier': 'k',
                                              'firstName': 'K', 'lastName': 'Ey'}}),
            ('/api/auth/device/web-session', 'POST', None),
        ]
        for path, method, data in bearer_routes:
            response = anon.raw(path, data, method, token=key)
            assert response.code == 401, (path, response.code, response.body)
        response = anon.raw('/api/auth/device/session', {'sessionToken': key}, 'POST')
        assert response.code == 401, response.body
        session_routes = [  # every kind of signed-in write, and the key routes themselves
            ('/api/me/api-keys', 'POST', {'name': 'made with a key'}),
            ('/api/me/api-keys', None, None),
            (f"/api/me/api-keys/{created['id']}", 'DELETE', None),
            ('/api/system/api-keys', 'POST', {'name': 'made with a key'}),
            (f"/api/system/api-keys/{created['id']}", 'DELETE', None),
            ('/api/me/avatar', 'PUT', {'body': 'round'}),
            ('/api/me/avatar', 'DELETE', None),
            ('/api/me/posts', None, None),
            ('/api/stats/overview', None, None),
            ('/api/plaza/pass', 'POST', None),
            ('/api/challenges', 'POST', {'name': 'key challenge', 'start': '2026-01-01', 'end': '2026-02-01', 'config': {}}),
            ('/api/system/join-link', 'POST', None),
            (f'/api/system/members/{ben_id}/admin', 'PUT', {'isAdmin': True}),
            (f'/api/system/members/{ben_id}', 'DELETE', None),
            ('/api/system/impersonate', 'POST', {'memberId': ben_id}),
            ('/api/auth/logout', 'POST', None),
        ]
        for path, method, data in session_routes:
            for who, response in [('bearer', anon.raw(path, data, method, token=key)),
                                  ('cookie', as_cookie.raw(path, data, method)),
                                  ('both', as_cookie.raw(path, data, method, token=key))]:
                if path == '/api/auth/logout':
                    # Logging out answers everyone; it must not have ended anything the key holds.
                    continue
                assert response.code == 401, (path, who, response.code, response.body)
        me_with_key = as_cookie.request('/api/auth/me', token=key)
        check('a key is refused by the extension routes and as a device session token', True)
        check('a key is refused by every session route tried, as bearer, as cookie or both',
              me_with_key['signedIn'] is False)
        for path in ('/api/v1/posts', '/api/v1/members', '/api/v1/stats'):
            for method in ('POST', 'PUT', 'DELETE', 'PATCH'):
                code = anon.raw(path, {}, method, token=key).code
                assert code == 405, (path, method, code)
        check('the /api/v1 routes take GET only', True)
        check('nothing the key tried changed anything: it still works and Ben is still not an admin',
              reads(key) == [200, 200, 200] and not ben.request('/api/auth/me')['isSystemAdmin']
              and [k['name'] for k in ada.request('/api/me/api-keys')['keys']]
                  == ['after revoking one', 'spare 3', 'spare 2', 'Claude on my laptop'])

        # --- the documentation ---------------------------------------------------------------
        response = anon.raw('/api/v1/docs')
        check('the docs are served signed out as Markdown, byte for byte docs/reporting-api.md',
              response.code == 200 and response.headers.get_content_type() == 'text/markdown'
              and response.body == DOC)
        text = DOC.decode()
        check('the docs name no real host and point members at their own API keys page',
              'enzo.health/' not in text and 'social-challenge' not in text and 'API keys' in text
              and '/api/v1/docs' in text)

        # --- rate limit ------------------------------------------------------------------------
        # Start just after the top of a (server) minute so all the requests land in one window.
        clock_path.write_text(str(int(61 - time.time() % 60)))
        limited = ada.request('/api/me/api-keys', {'name': 'rate limit'}, method='POST')['key']
        codes = [anon.raw('/api/v1/members', token=limited).code for _ in range(120)]
        over = anon.raw('/api/v1/members', token=limited)
        body = over.json()
        check('a key may make 120 requests a minute', codes == [200] * 120)
        check('the next is a 429 with Retry-After and a JSON reason naming the limit',
              over.code == 429 and body.get('code') == 'rate_limited' and '120' in body['error']
              and 1 <= int(over.headers['Retry-After']) <= 60)
        check('every reporting route counts against the same limit',
              anon.raw('/api/v1/posts', token=limited).code == 429
              and anon.raw('/api/v1/stats', token=limited).code == 429)
        check('the limit is per key: another key is unaffected', reads(ben_key) == [200, 200, 200])
        check('an admin website session is not limited',
              admin.raw('/api/v1/members').code == 200)
        clock_path.write_text(str(int(clock_path.read_text()) + 60))
        check('the next minute the key works again', reads(limited) == [200, 200, 200])
    finally:
        process.terminate()
        process.wait(timeout=10)

print(f'api keys e2e passed: {len(checks)} checks')
