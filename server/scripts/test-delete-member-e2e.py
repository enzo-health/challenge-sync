#!/usr/bin/env python3
"""Deleting an account from the All users page, on a disposable database, after cargo build:

* only an admin can delete an account; anonymous callers and non-admins get the usual JSON 401,
  and an unknown id is a 404;
* an admin cannot delete their own account (400), and an account that owns a challenge cannot be
  deleted until the challenge is handed over or removed (409), whether it owns it through an owner
  membership or as the challenge's creator;
* deleting removes the person's posts with their snapshots and comments, profile snapshots, device
  tokens, website sessions (their own and ones where they were viewing as someone else),
  challenge memberships, invites addressed to their email, and API keys they created, then the
  account itself; the rows are counted in the database file once the server has stopped;
* afterwards their sync tokens are refused, their website session is signed out, their API key
  stops working, and they are gone from the overview, the leaderboard and the post report;
* the join link they generated keeps working, and is still the one the overview shows;
* a delete that stopped part-way can simply be run again, and deleting a deleted account is a 404;
* the same LinkedIn identity joining again gets a brand new, empty account and can sync the same
  posts again.
"""
import datetime as dt
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
        def __init__(self, email=None, cookie=None):
            self.cookie = cookie
            if email:
                self.request('/api/auth/login', {'email': email, 'password': 'demopassword'})
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

        def standings_ids():
            return {row['memberId'] for row in ada.request(f'/api/leaderboard?challengeId={challenge_id}')['standings']}

        def overview_ids():
            return {m['id'] for m in admin.request('/api/system/overview')['members']}

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

        dora_post_ids = [p['postId'] for p in report(memberId=dora_id)['posts']]
        check('before deleting, Dora is in the overview, the leaderboard and the post report',
              dora_id in overview_ids() and dora_id in standings_ids() and len(dora_post_ids) == 2
              and report(token=dora_key)['postCount'] > 0)

        # --- who may delete -----------------------------------------------------------------
        target = f'/api/system/members/{dora_id}'
        for client in (anon, ada):
            code, _, body = client.raw(target, method='DELETE')
            other_code, _, other_body = client.raw('/api/system/overview')
            assert code == other_code == 401 and body == other_body, (code, body, other_body)
        check('anonymous callers and non-admins get the same 401 as the other system routes', True)
        check('nothing was deleted by the refused calls', dora_id in overview_ids())

        missing = admin.request('/api/system/members/987654321', method='DELETE', status=404)
        check('an unknown id is a 404 with a message', missing['error'] == 'no such member')

        own = admin.request(f'/api/system/members/{admin_id}', method='DELETE', status=400)
        check('an admin cannot delete their own account', own['error'] == 'you cannot delete your own account')

        refused = admin.request(f'/api/system/members/{owner_id}', method='DELETE', status=409)
        check('a challenge owner cannot be deleted, and the message names the challenge and what to do',
              'Autumn Posting Sprint' in refused['error'] and 'hand it to someone else or remove it' in refused['error'])
        check('the refused owner is still there', owner_id in overview_ids())

        # --- delete Dora --------------------------------------------------------------------
        check('an admin can delete the account', admin.request(target, method='DELETE') == {'ok': True})

        sync(device_one, status=401)
        sync(device_two, status=401)
        anon.request('/api/me/sync-status', token=device_one, status=401)
        anon.request('/api/me/sync-status', token=device_two, status=401)
        check('both of their sync tokens are refused by /api/sync and /api/me/sync-status', True)
        check('their website session is signed out', dora_web.request('/api/auth/me')['signedIn'] is False)
        check('the session where they were viewing as someone else is signed out too',
              dora_viewing.request('/api/auth/me')['signedIn'] is False)
        report(anon, token=dora_key, status=401)
        check('the API key they created stops working', True)
        check('they are gone from the overview', dora_id not in overview_ids())
        check('they are gone from the leaderboard standings', dora_id not in standings_ids())
        check('their posts are gone from the post report',
              all(p['memberId'] != dora_id for p in report()['posts']) and report(memberId=dora_id)['postCount'] == 0)

        check('the join link they generated is still the one to share',
              admin.request('/api/system/overview')['joinCode'] == dora_code)
        newcomer = anon.request(join, {'joinCode': dora_code, 'member': {
            'memberUrn': 'urn:li:fsd_profile:NEW1', 'publicIdentifier': 'nia-newcomer',
            'firstName': 'Nia', 'lastName': 'Newcomer'}})
        check('the join link they generated still lets people join', newcomer['created'] is True)

        again = admin.request(target, method='DELETE', status=404)
        check('deleting the same account again is a 404, not an error', again['error'] == 'no such member')

        # --- a delete that stops part-way can be run again ----------------------------------
        # Ben has seeded posts and history; he signs in on the website and has a pending invite.
        ben = Client('ben@demo.test')
        assert ben.request('/api/auth/me')['memberId'] == ben_id
        owner.request(f'/api/challenges/{challenge_id}/invites',
                      {'emails': ['ben@demo.test', 'keep.me@demo.test'], 'role': 'participant'}, method='POST')
        ben_post_ids = [p['postId'] for p in report(memberId=ben_id)['posts']]
        assert len(ben_post_ids) >= 2

        # Stop the server and do the first part of a delete by hand, as if it had failed half way.
        # Also take away the owner's owner membership, so only `creator_id` still makes them one.
        stop_server()
        with database() as conn:
            # The counts at the end are only meaningful if these rows were really there.
            before = [conn.execute(sql, (ben_id,)).fetchone()[0] for sql in (
                'SELECT COUNT(*) FROM posts WHERE member_id = ?',
                'SELECT COUNT(*) FROM post_snapshots WHERE post_id IN (SELECT id FROM posts WHERE member_id = ?)',
                'SELECT COUNT(*) FROM profile_snapshots WHERE member_id = ?',
                'SELECT COUNT(*) FROM admin_sessions WHERE admin_id = ?',
                'SELECT COUNT(*) FROM challenge_memberships WHERE member_id = ?',
            )]
            before.append(conn.execute("SELECT COUNT(*) FROM invites WHERE email = 'ben@demo.test'").fetchone()[0])
            check(f'the database file shows Ben\'s rows before the delete: {before}', all(before))
            conn.execute('DELETE FROM admin_sessions WHERE admin_id = ?', (ben_id,))
            conn.execute('DELETE FROM post_snapshots WHERE post_id = ?', (ben_post_ids[0],))
            conn.execute("UPDATE challenge_memberships SET role = 'participant' WHERE member_id = ?", (owner_id,))
        conn.close()
        start_server()

        check('a half-deleted account is still listed', ben_id in overview_ids())
        refused = admin.request(f'/api/system/members/{owner_id}', method='DELETE', status=409)
        check('the creator of a challenge cannot be deleted even without an owner membership',
              'Autumn Posting Sprint' in refused['error'])
        check('running the delete again finishes it',
              admin.request(f'/api/system/members/{ben_id}', method='DELETE') == {'ok': True})
        check('and then it is a 404', admin.request(f'/api/system/members/{ben_id}', method='DELETE',
                                                    status=404)['error'] == 'no such member')
        invites = owner.request(f'/api/challenges/{challenge_id}/invites')['invites']
        check('invites addressed to the deleted person are gone, others are kept',
              {i['email'] for i in invites} >= {'keep.me@demo.test'}
              and 'ben@demo.test' not in {i['email'] for i in invites})

        # --- the same LinkedIn identity joins again --------------------------------------------
        rejoined = anon.request(join, {'joinCode': JOIN_CODE, 'member': dora})
        new_id = rejoined['memberId']
        check('joining again with the same LinkedIn identity makes a new account',
              rejoined['created'] is True and new_id != dora_id)
        status = anon.request('/api/me/sync-status', token=rejoined['syncToken'])
        check('the new account is linked and starts empty',
              status['linked'] is True and report(memberId=new_id)['postCount'] == 0)
        session = Client(cookie=anon.request('/api/auth/device/web-session', method='POST',
                                             token=rejoined['syncToken'])['sessionToken'])
        me = session.request('/api/auth/me')
        check('the new account is not an admin', me['memberId'] == new_id and me['isSystemAdmin'] is False)
        sync(rejoined['syncToken'])
        check('the new account can sync the same posts again',
              report(memberId=new_id)['postCount'] == 2 and new_id in standings_ids())
    finally:
        stop_server()

    # --- count what is left in the database file, now that the server has let go of it ------------
    with database() as conn:
        def count(sql, *args):
            return conn.execute(sql, args).fetchone()[0]
        for name, member_id, post_ids in (('Dora', dora_id, dora_post_ids), ('Ben', ben_id, ben_post_ids)):
            marks = ','.join('?' * len(post_ids))
            left = {
                'members': count('SELECT COUNT(*) FROM members WHERE id = ?', member_id),
                'posts': count('SELECT COUNT(*) FROM posts WHERE member_id = ?', member_id),
                'posts by id': count(f'SELECT COUNT(*) FROM posts WHERE id IN ({marks})', *post_ids),
                'post_snapshots': count(f'SELECT COUNT(*) FROM post_snapshots WHERE post_id IN ({marks})', *post_ids),
                'post_comments': count(f'SELECT COUNT(*) FROM post_comments WHERE post_id IN ({marks})', *post_ids),
                'profile_snapshots': count('SELECT COUNT(*) FROM profile_snapshots WHERE member_id = ?', member_id),
                'device_tokens': count('SELECT COUNT(*) FROM device_tokens WHERE member_id = ?', member_id),
                'admin_sessions': count('SELECT COUNT(*) FROM admin_sessions WHERE admin_id = ? OR impersonator_id = ?',
                                        member_id, member_id),
                'challenge_memberships': count('SELECT COUNT(*) FROM challenge_memberships WHERE member_id = ?', member_id),
                'api_keys': count('SELECT COUNT(*) FROM api_keys WHERE created_by = ?', member_id),
            }
            check(f'no rows are left for {name} in any table: {left}', not any(left.values()))
        check('no invite is left addressed to the deleted person',
              count("SELECT COUNT(*) FROM invites WHERE email = 'ben@demo.test'") == 0
              and count("SELECT COUNT(*) FROM invites WHERE email = 'keep.me@demo.test'") == 1)
        check('the join link row they created is kept',
              count('SELECT COUNT(*) FROM join_links WHERE created_by = ? AND code = ?', dora_id, dora_code) == 1)
        check('the rejoined account owns the re-synced posts',
              count("SELECT COUNT(*) FROM posts WHERE member_id = ? AND urn LIKE 'urn:li:activity:dora%'", new_id) == 2)
    conn.close()

print(f'delete member e2e passed: {len(checks)} checks')
