#!/usr/bin/env python3
"""Deleting and restoring an account from the All users page, on a disposable database, after
cargo build:

* only an admin can delete or restore an account; anonymous callers and non-admins get the usual
  JSON 401, and an unknown id is a 404;
* an admin cannot delete their own account (400), and an account that owns a challenge cannot be
  deleted until the challenge is handed over or removed (409), whether it owns it through an owner
  membership or as the challenge's creator;
* deleting marks the account and closes every way in: password login (the same answer as a wrong
  password), the website session (their own, and one where they were viewing as someone else),
  sync tokens on /api/sync, /api/me/sync-status, /api/link and /api/auth/device/web-session, a
  session token on /api/auth/device/session, "View as", the API key they created, and joining
  again through the company link (403, and no second account is made); signup and invite join
  with their email are refused like any taken address; the admin flag is cleared and cannot be
  granted while deleted;
* a deleted account is refused even where deleting did not remove its access (sessions and tokens
  left in place by hand), so the check is made where members are resolved;
* nothing they recorded is removed: their posts stay in /api/v1/posts for the period, flagged
  `authorDeleted` (and in the CSV), and the rows are counted in the database file;
* they are gone from the leaderboard, /api/v1/members and its sync summary, and the active rows of
  the overview, and listed there with `deletedAt` set;
* deleting again is a no-op success that keeps the date; restoring brings them back: they can join
  again as the same account and are back on the leaderboard with their old posts, without their
  old tokens, API key or admin access.
"""
import csv
import datetime as dt
import io
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
JOIN_CODE = 'e2e-delete-code'
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

with tempfile.TemporaryDirectory(prefix='delete-member-e2e-') as directory:
    db_path = f'{directory}/test.db'
    server = {}

    def start_server():
        log_path = Path(directory) / 'server.log'
        with log_path.open('w') as log:
            process = subprocess.Popen([str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
                env={**os.environ, 'DATABASE_URL': f'turso:{db_path}', 'SEED_DEMO': '1', 'PORT': '0',
                     'JOIN_CODE': JOIN_CODE},
                stdout=log, stderr=log)
        server['process'] = process
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
        server['base'] = 'http://127.0.0.1:' + match[1]

    def stop_server():
        process = server.pop('process', None)
        if process:
            process.terminate()
            process.wait(timeout=10)

    def database():
        return sqlite3.connect(db_path)

    class Client:
        """Holds one website session cookie by hand, so a test can carry a raw session token."""
        def __init__(self, email=None, cookie=None, password='demopassword'):
            self.cookie = cookie
            if email:
                self.request('/api/auth/login', {'email': email, 'password': password})
        def raw(self, path, data=None, method=None, token=None):
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            if self.cookie:
                headers['Cookie'] = 'session=' + self.cookie
            request = urllib.request.Request(server['base'] + path, headers=headers, method=method,
                data=json.dumps(data).encode() if data is not None else None)
            try:
                response = urllib.request.urlopen(request)
            except urllib.error.HTTPError as error:
                response = error
            for value in response.headers.get_all('Set-Cookie') or []:
                found = re.match(r'session=([^;]*)', value)
                if found:
                    self.cookie = found[1] or None
            return response.code, response.headers, response.read()
        def request(self, path, data=None, method=None, token=None, status=200):
            code, headers, body = self.raw(path, data, method, token)
            assert code == status, (path, code, status, body)
            return json.loads(body) if headers.get_content_type() == 'application/json' else body.decode()

    try:
        start_server()
        anon = Client()
        admin = Client('sysadmin@demo.test')
        owner = Client('admin@demo.test')
        ada = Client('ada@demo.test')

        overview = admin.request('/api/system/overview')
        ids = {m['email']: m['id'] for m in overview['members'] if m['email']}
        admin_id, owner_id, ada_id, ben_id = (ids['sysadmin@demo.test'], ids['admin@demo.test'],
                                              ids['ada@demo.test'], ids['ben@demo.test'])
        board = ada.request('/api/leaderboard')
        challenge_id = board['competition']['id']
        today = dt.datetime.now(dt.timezone.utc).date()
        window = {'since': (today - dt.timedelta(days=60)).isoformat(), 'until': today.isoformat()}

        def report(client=admin, token=None, status=200, **params):
            query = urllib.parse.urlencode({**window, **params})
            return client.request('/api/v1/posts?' + query, token=token, status=status)

        def standings():
            return {row['memberId']: row for row in
                    ada.request(f'/api/leaderboard?challengeId={challenge_id}')['standings']}

        def overview_rows():
            return {m['id']: m for m in admin.request('/api/system/overview')['members']}

        def active_overview_ids():
            # What the page lists by default: rows without `deletedAt`.
            return {id for id, m in overview_rows().items() if m['deletedAt'] is None}

        def members_api():
            return admin.request('/api/v1/members')

        # --- someone with everything recorded: Dora joins with the extension on two devices ---
        dora = {'memberUrn': 'urn:li:fsd_profile:DORA1', 'publicIdentifier': 'dora-departing',
                'firstName': 'Dora', 'lastName': 'Departing',
                'profileUrl': 'https://www.linkedin.com/in/dora-departing'}
        join = '/api/auth/extension/join'
        first = anon.request(join, {'joinCode': JOIN_CODE, 'member': dora})
        second = anon.request(join, {'joinCode': JOIN_CODE, 'member': dora})
        dora_id, device_one, device_two = first['memberId'], first['syncToken'], second['syncToken']
        assert second['memberId'] == dora_id

        posted = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
        def post(urn, comment_urn):
            return {'urn': urn, 'permalink': f'https://www.linkedin.com/feed/update/{urn}/', 'createdAt': posted,
                    'textPreview': 'Dora e2e', 'isRepost': False,
                    'metrics': {'impressions': 900, 'reactions': 12, 'comments': 1},
                    'comments': [{'urn': comment_urn, 'commenterUrn': 'urn:li:member:999', 'commenterName': 'Someone'}]}
        dora_posts = [post('urn:li:activity:dora1', 'urn:li:comment:(activity:dora1,1)'),
                      post('urn:li:activity:dora2', 'urn:li:comment:(activity:dora2,1)')]
        def sync(token, status=200):
            return anon.request('/api/sync', {'profile': {'followerCount': 321}, 'posts': dora_posts},
                                token=token, status=status)
        sync(device_one)
        sync(device_two)

        dora_web = Client(cookie=anon.request('/api/auth/device/web-session', method='POST',
                                              token=device_one)['sessionToken'])
        assert dora_web.request('/api/auth/me')['memberId'] == dora_id

        # Dora is an admin: she made an API key and the current join link, and is viewing as Ada.
        admin.request(f'/api/system/members/{dora_id}/admin', {'isAdmin': True}, method='PUT')
        dora_key = dora_web.request('/api/system/api-keys', {'name': "Dora's script"}, method='POST')['key']
        dora_code = dora_web.request('/api/system/join-link', method='POST')['joinCode']
        dora_viewing = Client(cookie=dora_web.cookie)
        dora_viewing.request('/api/system/impersonate', {'memberId': ada_id}, method='POST')
        viewing = dora_viewing.request('/api/auth/me')
        assert viewing['memberId'] == ada_id and viewing['impersonatedBy'] == 'Dora Departing'
        # A second website session for Dora, kept as a raw token for /api/auth/device/session.
        dora_session_token = anon.request('/api/auth/device/web-session', method='POST',
                                          token=device_two)['sessionToken']

        # Eve signs up with a password, so the email routes can be tried on a deleted account.
        eve = Client()
        eve.request('/api/auth/signup', {'name': 'Eve Leaving', 'email': 'eve.leaving@enzo.health',
                                         'password': 'evepassword'})
        eve_id = eve.request('/api/auth/me')['memberId']
        eve_invite = owner.request(f'/api/challenges/{challenge_id}/invites',
                                   {'emails': ['eve.leaving@enzo.health'], 'role': 'participant'},
                                   method='POST')['codes'][0]

        dora_post_ids = [p['postId'] for p in report(memberId=dora_id)['posts']]
        before_members = members_api()
        check('before deleting, Dora is in the overview, the leaderboard, /api/v1/members and the post report',
              dora_id in active_overview_ids() and dora_id in standings() and len(dora_post_ids) == 2
              and dora_id in {m['memberId'] for m in before_members['members']}
              and report(token=dora_key)['postCount'] > 0
              and all(p['authorDeleted'] is False for p in report(memberId=dora_id)['posts']))

        # Note Dora's legacy token hash while the server is stopped, to see it replaced later.
        stop_server()
        with database() as conn:
            dora_hash_before = conn.execute('SELECT api_token_hash FROM members WHERE id = ?', (dora_id,)).fetchone()[0]
        conn.close()
        start_server()

        # --- who may delete or restore --------------------------------------------------------
        target = f'/api/system/members/{dora_id}'
        for client in (anon, ada):
            other_code, _, other_body = client.raw('/api/system/overview')
            for path, method in ((target, 'DELETE'), (target + '/restore', 'POST')):
                code, _, body = client.raw(path, method=method)
                assert code == other_code == 401 and body == other_body, (path, code, body, other_body)
        check('anonymous callers and non-admins get the same 401 as the other system routes, for delete and restore', True)
        check('nothing was deleted by the refused calls', dora_id in active_overview_ids())

        missing = admin.request('/api/system/members/987654321', method='DELETE', status=404)
        missing_restore = admin.request('/api/system/members/987654321/restore', method='POST', status=404)
        check('an unknown id is a 404 with a message, for delete and restore',
              missing['error'] == missing_restore['error'] == 'no such member')

        own = admin.request(f'/api/system/members/{admin_id}', method='DELETE', status=400)
        check('an admin cannot delete their own account', own['error'] == 'you cannot delete your own account')

        refused = admin.request(f'/api/system/members/{owner_id}', method='DELETE', status=409)
        check('a challenge owner cannot be deleted, and the message names the challenge and what to do',
              'Autumn Posting Sprint' in refused['error'] and 'hand it to someone else or remove it' in refused['error'])
        check('the refused owner is still there', owner_id in active_overview_ids())

        check('restoring an account that is not deleted changes nothing',
              admin.request(target + '/restore', method='POST') == {'ok': True}
              and overview_rows()[dora_id]['deletedAt'] is None)

        # --- delete Dora and Eve ----------------------------------------------------------------
        check('an admin can delete the account', admin.request(target, method='DELETE') == {'ok': True})
        admin.request(f'/api/system/members/{eve_id}', method='DELETE')

        sync(device_one, status=401)
        sync(device_two, status=401)
        for token in (device_one, device_two):
            anon.request('/api/me/sync-status', token=token, status=401)
            anon.request('/api/link', {'member': dora}, method='POST', token=token, status=401)
            anon.request('/api/auth/device/web-session', method='POST', token=token, status=401)
        check('both sync tokens are refused by /api/sync, /api/me/sync-status, /api/link and /api/auth/device/web-session', True)
        anon.request('/api/auth/device/session', {'sessionToken': dora_session_token}, method='POST', status=401)
        check('a website session token cannot be swapped for a new sync token', True)
        check('their website session is signed out', dora_web.request('/api/auth/me')['signedIn'] is False)
        check('the session where they were viewing as someone else is signed out too',
              dora_viewing.request('/api/auth/me')['signedIn'] is False)
        check('the deleted person cannot reach admin routes with their old cookie',
              dora_web.raw('/api/system/overview')[0] == 401)
        report(anon, token=dora_key, status=401)
        check('the API key they created stops working', True)

        rejoin = anon.request(join, {'joinCode': JOIN_CODE, 'member': dora}, status=403)
        check('joining again through the company link is refused with a clear message',
              rejoin['error'] == 'this account has been removed; ask an admin to restore it')
        rejoin = anon.request(join, {'joinCode': dora_code, 'member': dora}, status=403)
        check('the same with the generated link', 'ask an admin to restore it' in rejoin['error'])
        wrong_code = anon.request(join, {'joinCode': 'nope', 'member': dora}, status=403)
        check('a wrong code still gets the join-code message, saying nothing about the account',
              wrong_code['error'] == 'open your company\'s invite link first')

        viewing_refused = admin.request('/api/system/impersonate', {'memberId': dora_id}, method='POST', status=400)
        check('"View as" a deleted account is refused', viewing_refused['error'] == 'this account has been deleted')
        admin_refused = admin.request(f'{target}/admin', {'isAdmin': True}, method='PUT', status=400)
        check('a deleted account cannot be made an admin', 'restore it first' in admin_refused['error'])

        wrong_code, _, wrong_body = anon.raw('/api/auth/login', {'email': 'eve.leaving@enzo.health', 'password': 'not-her-password'})
        code, _, body = anon.raw('/api/auth/login', {'email': 'eve.leaving@enzo.health', 'password': 'evepassword'})
        check('password login with the right password gets the same 401 as a wrong one',
              code == wrong_code == 401 and body == wrong_body and json.loads(body)['error'] == 'invalid email or password')
        check('their password session is signed out', eve.request('/api/auth/me')['signedIn'] is False)
        signup = anon.request('/api/auth/signup', {'name': 'Eve Again', 'email': 'Eve.Leaving@enzo.health',
                                                   'password': 'evepassword'}, status=409)
        check('signing up again with their email is refused like any taken address',
              signup['error'] == 'an account with that email already exists')
        invite_join = anon.request('/api/auth/join', {'inviteCode': eve_invite, 'name': 'Eve',
                                                      'email': 'eve.leaving@enzo.health',
                                                      'password': 'evepassword'}, status=409)
        check('redeeming an invite with their email is refused the same way',
              invite_join['error'] == 'an account with that email already exists')

        # --- what others see ----------------------------------------------------------------
        rows = overview_rows()
        check('they are gone from the default overview list, and listed with deletedAt and no admin flag',
              dora_id not in active_overview_ids() and rows[dora_id]['deletedAt'] is not None
              and rows[dora_id]['isSystemAdmin'] is False and rows[eve_id]['deletedAt'] is not None)
        check('they are gone from the leaderboard standings', dora_id not in standings() and eve_id not in standings())
        code, _, _ = ada.raw(f'/api/members/{dora_id}?challengeId={challenge_id}')
        check('their member detail page is a 404', code == 404)
        after_members = members_api()
        check('they are gone from /api/v1/members and its sync summary',
              dora_id not in {m['memberId'] for m in after_members['members']}
              and after_members['sync']['totalMembers'] == before_members['sync']['totalMembers'] - 2
              and after_members['sync']['membersSyncedLast24h'] == before_members['sync']['membersSyncedLast24h'] - 1)
        posts = report(memberId=dora_id)
        authors = {a['memberId']: a for a in report()['authors']}
        check('their posts stay in the post report for the period, flagged authorDeleted',
              sorted(p['postId'] for p in posts['posts']) == sorted(dora_post_ids)
              and all(p['authorDeleted'] is True for p in posts['posts'])
              and authors[dora_id]['deleted'] is True and authors[dora_id]['postsInPeriod'] == 2
              and all(a['deleted'] is False for id, a in authors.items() if id != dora_id))
        text = admin.request('/api/v1/posts?' + urllib.parse.urlencode({**window, 'format': 'csv'}))
        table = list(csv.reader(io.StringIO(text.lstrip('﻿'), newline='')))
        header, table = table[0], table[1:]
        flags = {row[header.index('author_member_id')]: row[header.index('author_deleted')] for row in table}
        check('the CSV has an author_deleted column, true for their posts only',
              header[-1] == 'author_deleted' and flags[str(dora_id)] == 'true'
              and all(value == 'false' for id, value in flags.items() if id != str(dora_id)))

        check('the join link they generated is still the one to share',
              admin.request('/api/system/overview')['joinCode'] == dora_code)
        newcomer = anon.request(join, {'joinCode': dora_code, 'member': {
            'memberUrn': 'urn:li:fsd_profile:NEW1', 'publicIdentifier': 'nia-newcomer',
            'firstName': 'Nia', 'lastName': 'Newcomer'}})
        check('the join link they generated still lets other people join', newcomer['created'] is True)

        deleted_at = overview_rows()[dora_id]['deletedAt']
        check('deleting the same account again is a no-op success that keeps the date',
              admin.request(target, method='DELETE') == {'ok': True}
              and overview_rows()[dora_id]['deletedAt'] == deleted_at)

        # --- the check is where members are resolved, not only in what deleting removes -------
        # Ben gets a website session and a sync token; then he is marked deleted by hand, leaving
        # both in place, as if a delete had stopped right after setting the mark.
        ben = Client('ben@demo.test')
        ben_token = anon.request('/api/auth/device/session', {'sessionToken': ben.cookie}, method='POST')['syncToken']
        assert ben.request('/api/auth/me')['memberId'] == ben_id
        anon.request('/api/me/sync-status', token=ben_token)
        stop_server()
        with database() as conn:
            conn.execute('UPDATE members SET deleted_at = 1 WHERE id = ?', (ben_id,))
            # Take away the owner's owner membership, so only `creator_id` still makes them one.
            conn.execute("UPDATE challenge_memberships SET role = 'participant' WHERE member_id = ?", (owner_id,))
            left = conn.execute('SELECT (SELECT COUNT(*) FROM admin_sessions WHERE admin_id = ?) + '
                                '(SELECT COUNT(*) FROM device_tokens WHERE member_id = ?)', (ben_id, ben_id)).fetchone()[0]
        conn.close()
        start_server()
        assert left >= 2, left
        check('a session left in place for a deleted account reads as signed out',
              ben.request('/api/auth/me')['signedIn'] is False)
        anon.request('/api/me/sync-status', token=ben_token, status=401)
        anon.request('/api/auth/device/web-session', method='POST', token=ben_token, status=401)
        check('a sync token left in place for a deleted account is refused', True)
        Client().request('/api/auth/login', {'email': 'ben@demo.test', 'password': 'demopassword'}, status=401)
        check('a deleted account cannot log in with its password', True)
        check('a deleted account is not on the board even before its access is cleared', ben_id not in standings())

        refused = admin.request(f'/api/system/members/{owner_id}', method='DELETE', status=409)
        check('the creator of a challenge cannot be deleted even without an owner membership',
              'Autumn Posting Sprint' in refused['error'])

        # --- restore Dora ----------------------------------------------------------------------
        check('an admin can restore the account', admin.request(target + '/restore', method='POST') == {'ok': True})
        check('restored, she is back in the default overview list, still not an admin',
              dora_id in active_overview_ids() and overview_rows()[dora_id]['isSystemAdmin'] is False)
        sync(device_one, status=401)
        check('the old sync tokens stay refused after a restore', True)
        report(anon, token=dora_key, status=401)
        check('the old API key stays refused after a restore', True)
        check('the old website session stays signed out', dora_web.request('/api/auth/me')['signedIn'] is False)
        back = anon.request(join, {'joinCode': JOIN_CODE, 'member': dora})
        check('joining again signs in to the same account, not a new one',
              back['memberId'] == dora_id and back['created'] is False)
        session = Client(cookie=anon.request('/api/auth/device/web-session', method='POST',
                                             token=back['syncToken'])['sessionToken'])
        me = session.request('/api/auth/me')
        check('she can use the website again, without admin access',
              me['memberId'] == dora_id and me['isSystemAdmin'] is False)
        board = standings()
        check('she is back on the leaderboard with her old posts',
              dora_id in board and board[dora_id]['totalPosts'] == 2)
        check('and in /api/v1/members, and her posts are no longer flagged',
              dora_id in {m['memberId'] for m in members_api()['members']}
              and all(p['authorDeleted'] is False for p in report(memberId=dora_id)['posts']))
        sync(back['syncToken'])
        check('she can sync again', report(memberId=dora_id)['postCount'] == 2)
    finally:
        stop_server()

    # --- count what is left in the database file, now that the server has let go of it ------------
    with database() as conn:
        def count(sql, *args):
            return conn.execute(sql, args).fetchone()[0]
        marks = ','.join('?' * len(dora_post_ids))
        kept = {
            'posts': count('SELECT COUNT(*) FROM posts WHERE member_id = ?', dora_id),
            'post_snapshots': count(f'SELECT COUNT(*) FROM post_snapshots WHERE post_id IN ({marks})', *dora_post_ids),
            'post_comments': count(f'SELECT COUNT(*) FROM post_comments WHERE post_id IN ({marks})', *dora_post_ids),
            'profile_snapshots': count('SELECT COUNT(*) FROM profile_snapshots WHERE member_id = ?', dora_id),
            'challenge_memberships': count('SELECT COUNT(*) FROM challenge_memberships WHERE member_id = ?', dora_id),
        }
        check(f'everything Dora recorded is still in the database: {kept}', all(kept.values()))
        check('only one account has her LinkedIn identity (rejoining never made a second one)',
              count("SELECT COUNT(*) FROM members WHERE linkedin_urn = 'urn:li:fsd_profile:DORA1'") == 1)
        check('her API key was deleted, and so were the old device tokens (only the new one is left)',
              count('SELECT COUNT(*) FROM api_keys WHERE created_by = ?', dora_id) == 0
              and count('SELECT COUNT(*) FROM device_tokens WHERE member_id = ?', dora_id) == 1)
        check('her legacy sync token hash was replaced',
              count('SELECT COUNT(*) FROM members WHERE id = ? AND api_token_hash = ?', dora_id, dora_hash_before) == 0)
        check('the restored account has no deleted mark; Eve and Ben keep theirs',
              count('SELECT COUNT(*) FROM members WHERE id = ? AND deleted_at IS NULL', dora_id) == 1
              and count('SELECT COUNT(*) FROM members WHERE id IN (?, ?) AND deleted_at IS NOT NULL', eve_id, ben_id) == 2)
        check('Eve\'s account row and her invite are kept',
              count("SELECT COUNT(*) FROM members WHERE email = 'eve.leaving@enzo.health'") == 1
              and count("SELECT COUNT(*) FROM invites WHERE email = 'eve.leaving@enzo.health'") == 1)
        check('the join link row they created is kept',
              count('SELECT COUNT(*) FROM join_links WHERE created_by = ? AND code = ?', dora_id, dora_code) == 1)
    conn.close()

print(f'delete member e2e passed: {len(checks)} checks')
