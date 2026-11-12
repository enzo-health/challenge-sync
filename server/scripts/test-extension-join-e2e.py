#!/usr/bin/env python3
"""No-password sign-in on a disposable database, after cargo build:

* the extension can join with the company join code and a LinkedIn identity, and is refused
  without the code, with a wrong one, or with a placeholder identity;
* joining twice with one identity signs in to the same account instead of creating a second;
* a device sync token becomes a website session, and a bad token does not;
* only an admin can make someone else an admin, and cannot remove their own access;
* only an admin can generate the join link, and generating a new one retires the previous code
  while the fixed `JOIN_CODE` keeps working.
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
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
JOIN_CODE = 'e2e-join-code'
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

with tempfile.TemporaryDirectory(prefix='extension-join-e2e-') as directory:
    log_path = Path(directory) / 'server.log'
    with log_path.open('w') as log:
        process = subprocess.Popen([str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
            env={**os.environ, 'DATABASE_URL': f'turso:{directory}/test.db', 'SEED_DEMO': '1', 'PORT': '0',
                 'JOIN_CODE': JOIN_CODE},
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

        class Client:
            def __init__(self):
                self.jar = http.cookiejar.CookieJar()
                self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
            def request(self, path, data=None, method=None, token=None, cookie=None, status=200):
                headers = {'Content-Type': 'application/json'}
                if token:
                    headers['Authorization'] = 'Bearer ' + token
                if cookie:
                    headers['Cookie'] = 'session=' + cookie
                request = urllib.request.Request(base + path, headers=headers, method=method,
                    data=json.dumps(data).encode() if data is not None else None)
                try:
                    response = self.opener.open(request)
                except urllib.error.HTTPError as error:
                    response = error
                body = response.read()
                assert response.code == status, (path, response.code, status, body)
                return json.loads(body) if response.headers.get_content_type() == "application/json" else body.decode()

        anon = Client()
        ada = {'memberUrn': 'urn:li:fsd_profile:ADA123', 'publicIdentifier': 'ada-lovelace',
               'firstName': 'Ada', 'lastName': 'Lovelace', 'profileUrl': 'https://www.linkedin.com/in/ada-lovelace'}
        join = '/api/auth/extension/join'

        anon.request(join, {'member': ada}, status=403)
        anon.request(join, {'joinCode': 'wrong-code-000', 'member': ada}, status=403)
        anon.request(join, {'joinCode': '', 'member': ada}, status=403)
        check('joining needs the right company join code', True)

        anon.request(join, {'joinCode': JOIN_CODE, 'member': {**ada, 'memberUrn': ''}}, status=400)
        anon.request(join, {'joinCode': JOIN_CODE, 'member': {**ada, 'memberUrn': 'pending:admin@demo.test'}}, status=400)
        check('an empty or placeholder identity is refused', True)

        first = anon.request(join, {'joinCode': JOIN_CODE, 'member': ada})
        check('the first join creates the account from the LinkedIn name',
              first['created'] is True and first['displayName'] == 'Ada Lovelace' and first['syncToken'])

        second = anon.request(join, {'joinCode': JOIN_CODE, 'member': ada})
        check('a second device signs in to the same account',
              second['created'] is False and second['memberId'] == first['memberId']
              and second['syncToken'] != first['syncToken'])

        status = anon.request('/api/me/sync-status', token=first['syncToken'])
        check('the first device token still works after the second joined',
              status['linked'] is True and status['displayName'] == 'Ada Lovelace')

        web = '/api/auth/device/web-session'
        anon.request(web, method='POST', token='not-a-real-token', status=401)
        anon.request(web, method='POST', status=401)
        check('a website session needs a valid device token', True)

        session = anon.request(web, method='POST', token=first['syncToken'])
        me = Client().request('/api/auth/me', cookie=session['sessionToken'])
        check('a device token becomes a website session for that member',
              me['signedIn'] is True and me['memberId'] == first['memberId'] and session['maxAge'] > 0)
        check('the website is signed out without that session',
              Client().request('/api/auth/me')['signedIn'] is False)

        admin = Client()
        admin.request('/api/auth/login', {'email': 'sysadmin@demo.test', 'password': 'demopassword'})
        overview = admin.request('/api/system/overview')
        check('an admin sees the join code to share', overview['joinCode'] == JOIN_CODE)
        admin_id = next(m['id'] for m in overview['members'] if m['email'] == 'sysadmin@demo.test')
        ada_admin = f"/api/system/members/{first['memberId']}/admin"

        Client().request(ada_admin, {'isAdmin': True}, method='PUT', cookie=session['sessionToken'], status=401)
        check('a regular member cannot make themselves an admin', True)

        admin.request(ada_admin, {'isAdmin': True}, method='PUT')
        me = Client().request('/api/auth/me', cookie=session['sessionToken'])
        check('an admin can make another member an admin', me['isSystemAdmin'] is True)

        admin.request(f'/api/system/members/{admin_id}/admin', {'isAdmin': False}, method='PUT', status=400)
        check('an admin cannot remove their own access', True)

        admin.request(ada_admin, {'isAdmin': False}, method='PUT')
        me = Client().request('/api/auth/me', cookie=session['sessionToken'])
        check('an admin can remove another admin', me['isSystemAdmin'] is False)

        join_link = '/api/system/join-link'
        Client().request(join_link, method='POST', cookie=session['sessionToken'], status=401)
        Client().request(join_link, method='POST', status=401)
        check('a regular member cannot generate the join link', True)

        generated = admin.request(join_link, method='POST')['joinCode']
        check('an admin can generate a join link',
              len(generated) >= 16 and re.fullmatch(r'[A-Za-z0-9_-]+', generated) is not None)
        check('the overview shows the generated code instead of the fixed one',
              admin.request('/api/system/overview')['joinCode'] == generated)

        grace = {'memberUrn': 'urn:li:fsd_profile:GRACE1', 'publicIdentifier': 'grace-hopper',
                 'firstName': 'Grace', 'lastName': 'Hopper'}
        joined = anon.request(join, {'joinCode': generated, 'member': grace})
        check('the generated code lets a new person join', joined['created'] is True)

        replacement = admin.request(join_link, method='POST')['joinCode']
        alan = {'memberUrn': 'urn:li:fsd_profile:ALAN1', 'publicIdentifier': 'alan-turing',
                'firstName': 'Alan', 'lastName': 'Turing'}
        anon.request(join, {'joinCode': generated, 'member': alan}, status=403)
        check('a replaced code is refused', replacement != generated)
        check('the new code works after replacing',
              anon.request(join, {'joinCode': replacement, 'member': alan})['created'] is True)
        check('the overview shows the newest code',
              admin.request('/api/system/overview')['joinCode'] == replacement)
        check('the fixed JOIN_CODE still works alongside the generated one',
              anon.request(join, {'joinCode': JOIN_CODE, 'member': ada})['memberId'] == first['memberId'])

        for path in ('/auth/login', '/auth/password', f'/join/{JOIN_CODE}'):
            Client().request(path)
        check('get-started, password fallback and join link are reachable signed out', True)
    finally:
        process.terminate()
        process.wait(timeout=10)

print(f'extension join e2e passed: {len(checks)} checks')
