#!/usr/bin/env python3
"""Exercise real auth, sync, scoring and follower APIs on a disposable database.
Run after cargo build. --keep retains the server for browser verification until Ctrl-C.
"""
import argparse
import datetime as dt
import http.cookiejar
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--keep', action='store_true')
args = parser.parse_args()
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

with tempfile.TemporaryDirectory(prefix='followers-e2e-') as directory:
    log_path = Path(directory) / 'server.log'
    with log_path.open('w') as log:
        process = subprocess.Popen([str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
            env={**os.environ, 'DATABASE_URL': f'turso:{directory}/test.db', 'SEED_DEMO': '1', 'PORT': '0'},
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
            def __init__(self, email=None, password='demopassword'):
                self.jar = http.cookiejar.CookieJar()
                self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
                if email:
                    self.request('/api/auth/login', {'email': email, 'password': password})
            def request(self, path, data=None, method=None, token=None, status=200):
                headers = {'Content-Type': 'application/json'}
                if token:
                    headers['Authorization'] = 'Bearer ' + token
                request = urllib.request.Request(base + path, headers=headers, method=method,
                    data=json.dumps(data).encode() if data is not None else None)
                try:
                    response = self.opener.open(request)
                except urllib.error.HTTPError as error:
                    response = error
                body = response.read()
                assert response.code == status, (path, response.code, status, body)
                return json.loads(body) if response.headers.get_content_type() == "application/json" else body.decode()
            def sync(self, count, posts=None):
                if not hasattr(self, 'token'):
                    session = next(c.value for c in self.jar if c.name == 'session')
                    self.token = self.request('/api/auth/device/session', {'sessionToken': session})['syncToken']
                return self.request('/api/sync', {'profile': {'followerCount': count}, 'posts': posts or []}, token=self.token)

        user = Client('ada@demo.test')
        admin = Client('sysadmin@demo.test')
        owner = Client('admin@demo.test')
        uid = user.request('/api/auth/me')['memberId']
        # Challenges are open to system admins only for now (`auth::can_use_challenges`), so the
        # people this test drives through a challenge are made admins first. Ada is checked as an
        # ordinary member before that.
        user.request('/api/system/overview', status=401)
        user.request('/api/challenges', status=401)
        check('an ordinary member cannot read the system panel or challenges', True)
        def make_admin(client):
            admin.request(f"/api/system/members/{client.request('/api/auth/me')['memberId']}/admin", {'isAdmin': True}, method='PUT')
        make_admin(owner)
        make_admin(user)
        challenge = next(c for c in owner.request('/api/challenges')['challenges'] if c['name'] == 'Autumn Posting Sprint')
        cid = challenge['id']
        def detail():
            return user.request(f'/api/members/{uid}?challengeId={cid}')
        def system_count():
            return next(m['followerCount'] for m in admin.request('/api/system/overview')['members'] if m['id'] == uid)
        check('initial count agrees across personal results, member results and All users',
            user.request('/api/me/posts')['followerCount'] == detail()['followerCount'] == system_count() == 4460)
        board = user.request(f'/api/leaderboard?challengeId={cid}')
        teammate = next(s for s in board['standings'] if s['memberId'] != uid)
        check('a participant (not the owner) can inspect a teammate in the same challenge',
            user.request(f"/api/members/{teammate['memberId']}?challengeId={cid}")['standing'] == teammate)
        Client().request(f'/api/members/{uid}?challengeId={cid}', status=401)
        check('anonymous member reads rejected', True)
        user.request(f"/api/members/{teammate['memberId']}", status=404)
        check('another member requires explicit shared challenge context', True)
        check('never-synced counts remain null', next(m['followerCount'] for m in admin.request('/api/system/overview')['members'] if m['displayName'] == 'Demo Admin') is None)
        # Rapid syncs intentionally exercise multiple snapshots sharing the server's one-second timestamp.
        sync_times = []
        for count in [2000, 3000, 0, None, 4000, None]:
            user.sync(count)
            if count is not None:
                expected = count
            sync_times.append(next(m['lastSyncedAt'] for m in admin.request('/api/system/overview')['members'] if m['id'] == uid))
            actual = (user.request('/api/me/posts')['followerCount'], detail()['followerCount'], system_count())
            check(f'sync {count!r}: latest known count is {expected} on every surface', actual == (expected,) * 3)
        check('rapid-sync regression actually exercised a same-second timestamp tie', len(set(sync_times)) < len(sync_times))
        standing = detail()['standing']
        check('known reading is not marked unknown', not standing['followersUnknown'])
        # A controlled one-post fixture provides an independent scoring oracle.
        fixture = Client()
        fixture.request('/api/auth/signup', {'name': 'Follower E2E', 'email': 'followers-e2e@enzo.health', 'password': 'FollowerE2E!123'})
        fid = fixture.request('/api/auth/me')['memberId']
        make_admin(fixture)
        today = dt.datetime.now(dt.timezone.utc).date()
        start, end = str(today - dt.timedelta(days=2)), str(today + dt.timedelta(days=2))
        fc = fixture.request('/api/challenges', {'name': 'Follower adjustment evidence', 'start': start, 'end': end, 'config': {}})['id']
        fixture.sync(None, [{'urn': 'urn:li:activity:follower-e2e', 'permalink': 'https://www.linkedin.com/feed/', 'createdAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'textPreview': 'Controlled test: 100 reactions and 40 comments.', 'metrics': {'reactions': 100, 'comments': 40}}])
        missing = fixture.request(f'/api/members/{fid}?challengeId={fc}')['standing']
        check('unknown follower count leaves engagement unscaled', missing['followersUnknown'] and missing['engagementPoints'] == 185)
        fixture.sync(0)
        zero = fixture.request(f'/api/members/{fid}?challengeId={fc}')['standing']
        check('known zero stays zero and avoids division by zero', not zero['followersUnknown'] and zero['followerCount'] == 0 and zero['engagementPoints'] == 185)
        fixture.sync(2000)
        scored = fixture.request(f'/api/members/{fid}?challengeId={fc}')['standing']
        # 100*.2 + 40*5 = 220 raw; cap gives 150 + 70*.5 = 185; factor .5 => 92.5.
        check('independent scoring oracle: 185 capped engagement × 0.5 = 92.5', math.isclose(scored['engagementPoints'], 92.5))
        check('posting and consistency remain 10 and 20; total is 122.5', (scored['showUpPoints'], scored['consistencyPoints'], scored['total']) == (10, 20, 122.5))
        fixture.request(f'/api/challenges/{fc}', {'name': 'Follower adjustment evidence', 'start': start, 'end': end, 'isActive': True, 'config': {'normalizeByFollowers': False}}, method='PUT')
        unscaled = fixture.request(f'/api/members/{fid}?challengeId={fc}')['standing']
        check('normalization disabled: engagement 185, total 215', (unscaled['engagementPoints'], unscaled['total']) == (185, 215))
        # Historical window excludes today's sync but retains the seeded in-window profile reading.
        owner.request(f'/api/challenges/{cid}', {'name': challenge['name'], 'start': str(today-dt.timedelta(days=25)), 'end': str(today-dt.timedelta(days=1)), 'isActive': True, 'config': challenge['config']}, method='PUT')
        historical = detail()
        check('historical results distinguish latest audience from window scoring count', historical['followerCount'] == 4000 and historical['standing']['followerCount'] == 4200)
        fixture.request(f'/api/challenges/{fc}', {'name': 'Follower adjustment evidence', 'start': start, 'end': end, 'isActive': True, 'config': {}}, method='PUT')
        print(json.dumps({'result': 'PASS', 'checks': len(checks), 'base': base, 'historicalMember': f'/members/{uid}?challengeId={cid}', 'fixtureMember': f'/members/{fid}?challengeId={fc}'}, indent=2), flush=True)
        if args.keep:
            print('Ready for browser verification; Ctrl-C cleans up the isolated server and database.', flush=True)
            while True:
                time.sleep(1)
    finally:
        process.terminate()
        process.wait(timeout=10)
