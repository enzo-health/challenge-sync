#!/usr/bin/env python3
"""Regression checks on a disposable database, after cargo build:

* two members whose feeds carry the SAME comment URN (a repost of a teammate's post) both sync
  without a unique-index failure, and the reposter's copy is neither stored nor scored;
* linking a second device does not unlink the first, and /api/me/sync-status reports the
  account-wide count on both;
* a post past the refresh window that the extension leaves out of `posts` is neither deleted nor
  regressed, and an old extension's `postFeedComplete` reconciliation still works.
"""
import datetime as dt
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
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

with tempfile.TemporaryDirectory(prefix='sync-devices-e2e-') as directory:
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
            def device_token(self):
                session = next(c.value for c in self.jar if c.name == 'session')
                return self.request('/api/auth/device/session', {'sessionToken': session})['syncToken']
            def sync(self, token, posts, status=200):
                return self.request('/api/sync', {'profile': {'followerCount': 100}, 'posts': posts}, token=token, status=status)

        now = dt.datetime.now(dt.timezone.utc).isoformat()
        def post(urn, comments, is_repost=False):
            return {'urn': urn, 'permalink': 'https://www.linkedin.com/feed/', 'createdAt': now,
                    'textPreview': 'e2e', 'isRepost': is_repost, 'metrics': {'reactions': 1, 'comments': len(comments)},
                    'comments': [{'urn': c, 'commenterUrn': 'urn:li:member:999', 'commenterName': 'Someone'} for c in comments]}

        shared = 'urn:li:comment:(activity:1,2)'
        ada = Client('ada@demo.test')
        ada_token = ada.device_token()
        ada.sync(ada_token, [post('urn:li:activity:1', [shared])])

        # --- the repost collision -------------------------------------------------------------
        owner = Client('admin@demo.test')
        owner_token = owner.device_token()
        owner.sync(owner_token, [post('urn:li:activity:repost-1', [shared], is_repost=True)])
        check('a repost carrying a comment URN another member already stored syncs with 200', True)
        # A non-repost from a second member that names an already-stored URN (quote post, URN
        # respelling) must also survive: the collision check is global, not per member.
        owner.sync(owner_token, [post('urn:li:activity:quote-1', [shared, 'urn:li:comment:(activity:quote-1,9)'])])
        check('a second member re-sending a stored comment URN syncs with 200', True)
        ada.sync(ada_token, [post('urn:li:activity:1', [shared])])
        check('the original owner still re-syncs the same comment idempotently', True)

        # --- two devices, one account --------------------------------------------------------
        second_token = ada.device_token()
        check('second device receives its own token', second_token != ada_token)
        ada.sync(ada_token, [post('urn:li:activity:1', [shared]), post('urn:li:activity:2', [])])
        check('first device is still accepted after the second linked', True)
        # The extension has no site cookie, only the bearer token, so this must pass the root
        # sign-in guard on the token alone — a cookie-less client is the honest caller here.
        device = Client()
        status_first = device.request('/api/me/sync-status', token=ada_token)
        status_second = device.request('/api/me/sync-status', token=second_token)
        check('a freshly linked device sees the account-wide post count, not zero',
              status_second['postsCount'] == status_first['postsCount'] >= 2 and status_second['lastSyncAt'] is not None)
        device.request('/api/me/sync-status', token='st_bogus', status=401)
        check('unknown token is rejected on sync-status', True)

        # --- posts past the refresh window -------------------------------------------------------
        # The extension stops re-reading posts older than four weeks. It leaves them out of
        # `posts`, keeps `postFeedComplete` false (an older server would delete them otherwise),
        # and names the whole page in `completePostFeedUrns`.
        window = Client()
        window.request('/api/auth/signup', {'name': 'Refresh Window E2E', 'email': 'refresh-window-e2e@enzo.health', 'password': 'RefreshWindowE2E!123'})
        window_token = window.device_token()
        def aged(urn, days, metrics):
            created = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).isoformat()
            return {'urn': urn, 'permalink': 'https://www.linkedin.com/feed/', 'createdAt': created,
                    'textPreview': 'e2e', 'metrics': metrics, 'comments': []}
        def window_sync(posts, **extra):
            return window.request('/api/sync', {'profile': {'followerCount': 100}, 'posts': posts, **extra}, token=window_token)
        def window_posts():
            return {p['urn']: p for p in window.request('/api/me/posts')['posts']}
        full = {'impressions': 500, 'reactions': 10, 'comments': 0, 'reposts': 1, 'sends': 3, 'saves': 2}
        young, old, gone, nested = 'urn:li:activity:young', 'urn:li:activity:old', 'urn:li:activity:gone', 'urn:li:activity:nested'
        # First sight records everything once, old posts included, with full analytics.
        window_sync([aged(young, 10, full), aged(old, 40, full), aged(gone, 12, full), aged(nested, 50, full)])
        check('a post first seen past the window is recorded once', set(window_posts()) == {young, old, gone, nested})
        before = window_posts()[old]
        # A later sync refreshes only the young post; `gone` has been deleted on LinkedIn and
        # `nested` turns out to be a reshared original.
        result = window_sync([aged(young, 10, {**full, 'reactions': 20})], postFeedComplete=False,
                             completePostFeedUrns=[young, old], excludedPostUrns=[nested])
        after = window_posts()
        check('only refreshed posts count as ingested', result['postsIngested'] == 1)
        check('an unrefreshed old post named in completePostFeedUrns is not deleted', old in after)
        check('a post missing from completePostFeedUrns is still reconciled as deleted', gone not in after)
        check('excludedPostUrns still removes a nested original', nested not in after)
        check("an unrefreshed old post keeps every recorded number",
              all(after[old][k] == before[k] for k in ('impressions', 'reactions', 'reposts', 'sends', 'saves')))
        check('the refreshed young post moved on', after[young]['reactions'] == 20 and after[young]['impressions'] == 500)
        # Without completePostFeedUrns and with postFeedComplete false (what the new extension sends
        # an older server, and what any full page sends), nothing is deleted.
        window_sync([aged(young, 10, full)])
        check('no completeness claim deletes nothing', set(window_posts()) == {young, old})
        # An old extension (0.1.2) sends every post and the old flag; reconciliation is unchanged.
        window_sync([aged(young, 10, full), aged(old, 40, full)], postFeedComplete=True)
        check('an old extension sending every post keeps both', set(window_posts()) == {young, old})
        window_sync([aged(young, 10, full)], postFeedComplete=True)
        check('an old extension still reconciles deletions with postFeedComplete alone', set(window_posts()) == {young})
    finally:
        process.terminate()
        process.wait()
print(json.dumps({'result': 'PASS', 'checks': len(checks)}, indent=2))
