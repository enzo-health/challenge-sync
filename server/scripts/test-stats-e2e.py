#!/usr/bin/env python3
"""The company stats overview (the landing page) and challenges being admin-only, on a disposable
database, after cargo build:

* posts and people who posted for 7, 30 and 90 days, reshares left out;
* impressions gained = last known reading before the period ended minus the last known before it
  began: a post published before the period that gains inside it, a post with a single reading
  inside the period, a reading that missed a number, a number that went down (never negative),
  and a post published more than 45 days before the period (no longer refreshed) left out;
* the previous-period comparison, including nothing to compare against (change is null);
* daily buckets for 7 and 30 days and weekly for 90, each adding up to the headline number;
* the time zone offset moving a late-evening post to its own day;
* a deleted author still counted in the totals but listed as "Former member", not by name;
* the viewer's own share (`you`): equal to their subset, shares adding up, buckets adding up, zeros
  and a "not synced" flag for someone with no posts; /api/v1/stats?memberId= returns the same;
* a stale notice flag once nobody has synced for more than two days;
* anonymous visitors get 401 or the sign-in page; /api/v1/stats needs an API key or an admin;
* a regular member gets the overview, My posts and their APIs, and is sent to / or refused on
  every challenge page and API, while a system admin still reaches them.

Reading times cannot be set through /api/sync (the server stamps them), so the test syncs the posts,
stops the server, and rewrites their readings in the SQLite file, as test-snapshot-dedupe-e2e does.
The demo seed's own posts are removed at that point so the company numbers are exactly this test's.
"""
import contextlib
import datetime as dt
import http.cookiejar
import json
import math
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
DAY = 86400
METRICS = ['impressions', 'reactions', 'comments', 'reposts', 'sends', 'saves', 'impressions_in_network',
           'impressions_out_of_network', 'members_reached', 'profile_viewers_from_post', 'followers_from_post']
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

with tempfile.TemporaryDirectory(prefix='stats-e2e-') as directory:
    db_path = Path(directory) / 'test.db'
    log_path = Path(directory) / 'server.log'
    state = {}

    def start():
        log = log_path.open('a')
        state['process'] = subprocess.Popen([str(ROOT / 'target/debug/linkedin-challenge-server')], cwd=ROOT,
            env={**os.environ, 'DATABASE_URL': f'turso:{db_path}', 'SEED_DEMO': '1', 'PORT': '0'},
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
        # sqlite3's own context manager commits but leaves the file open (and locked for Turso).
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
            self.plain = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
            if email:
                self.request('/api/auth/login', {'email': email, 'password': password})
        def raw(self, path, data=None, method=None, token=None, follow=True):
            headers = {'Content-Type': 'application/json'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            request = urllib.request.Request(state['base'] + path, headers=headers, method=method,
                data=json.dumps(data).encode() if data is not None else None)
            try:
                response = (self.opener if follow else self.plain).open(request)
            except urllib.error.HTTPError as error:
                response = error
            return response.code, response.headers, response.read()
        def request(self, path, data=None, method=None, token=None, status=200):
            code, headers, body = self.raw(path, data, method, token)
            assert code == status, (path, code, status, body[:300])
            return json.loads(body) if headers.get_content_type() == 'application/json' else body.decode()
        def page(self, path):
            """Status and redirect target of a page load, without following the redirect."""
            code, headers, _ = self.raw(path, follow=False)
            return code, headers.get('Location')

    def stats(client, days=None, timezone='-07:00', status=200, path='/api/stats/overview', token=None, **extra):
        params = {'days': days, 'timezone': timezone, **extra}
        query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
        return client.request(f'{path}?{query}', token=token, status=status)

    # --- times, in a fixed -07:00 offset ------------------------------------------------------------
    OFFSET = -7 * 3600
    now = int(time.time())
    today = (now + OFFSET) // DAY * DAY - OFFSET  # local midnight starting today
    def local(days_ago, hour, minute=0):
        return today - days_ago * DAY + hour * 3600 + minute * 60
    def iso(unix):
        return dt.datetime.fromtimestamp(unix, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    def local_date(unix, offset=OFFSET):
        return dt.datetime.fromtimestamp(unix + offset, dt.timezone.utc).strftime('%Y-%m-%d')

    start()
    try:
        anon = Client()
        admin = Client('sysadmin@demo.test')

        def person(first):
            client = Client()
            client.request('/api/auth/signup', {'name': f'{first} Stats', 'email': f'{first.lower()}-stats-e2e@enzo.health',
                                                'password': 'StatsE2E!pass123'})
            session = next(c.value for c in client.jar if c.name == 'session')
            token = client.request('/api/auth/device/session', {'sessionToken': session})['syncToken']
            return client, token, client.request('/api/auth/me')['memberId']
        ann, ann_token, ann_id = person('Ann')
        bob, bob_token, bob_id = person('Bob')
        cat, cat_token, cat_id = person('Cat')
        dan, _, dan_id = person('Dan')  # signs up, never syncs, never posts

        def post(urn, created, text='e2e post', is_repost=False):
            return {'urn': urn, 'permalink': f'https://www.linkedin.com/feed/update/{urn}/', 'createdAt': iso(created),
                    'textPreview': text, 'isRepost': is_repost, 'metrics': {'impressions': 1}, 'comments': []}
        def sync(token, posts):
            anon.request('/api/sync', {'profile': {'followerCount': 100}, 'posts': posts}, token=token)

        sync(ann_token, [
            post('urn:li:activity:a1', local(3, 12), text="\nAnn's launch post\nwith a second line"),
            post('urn:li:activity:a2', local(20, 12)),   # before the 7-day period, gains inside it
            post('urn:li:activity:a3', local(2, 12), is_repost=True),
            post('urn:li:activity:a4', local(60, 12)),   # more than 45 days before the 7-day period
        ])
        sync(bob_token, [
            post('urn:li:activity:b1', local(2, 22, 30), text='Late evening in Denver'),
            post('urn:li:activity:b2', local(10, 12)),   # previous 7-day period; its number goes down
        ])
        sync(cat_token, [post('urn:li:activity:c1', local(1, 12), text='Cat goes big')])

        # --- set the readings ------------------------------------------------------------------
        stop()
        R = {}
        with sql() as db:
            post_ids = dict(db.execute("SELECT urn, id FROM posts WHERE urn NOT LIKE 'urn:li:activity:demo%'").fetchall())
            db.execute("DELETE FROM post_snapshots WHERE post_id IN (SELECT id FROM posts WHERE urn LIKE 'urn:li:activity:demo%')")
            db.execute("DELETE FROM post_comments WHERE post_id IN (SELECT id FROM posts WHERE urn LIKE 'urn:li:activity:demo%')")
            db.execute("DELETE FROM posts WHERE urn LIKE 'urn:li:activity:demo%'")
            db.execute('DELETE FROM post_snapshots')
            def reading(urn, at, **metrics):
                columns = ['post_id', 'captured_at', *METRICS]
                db.execute(f"INSERT INTO post_snapshots ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
                           [post_ids['urn:li:activity:' + urn], at, *(metrics.get(m) for m in METRICS)])
            # a1: read twice in the period; the second reading missed the comment count.
            reading('a1', local(3, 13), impressions=100, impressions_out_of_network=30, reactions=5, comments=1)
            reading('a1', local(1, 12), impressions=250, impressions_out_of_network=60, reactions=8)
            # a2: 1,000 before the 7-day period, 1,300 inside it; never an out-of-network number.
            reading('a2', local(15, 12), impressions=1000)
            reading('a2', local(2, 12), impressions=1300)
            # a3: a reshare with a big number that must not count.
            reading('a3', local(2, 13), impressions=5000, impressions_out_of_network=5000, reactions=99, comments=9)
            # a4: published 60 days ago; it still "gains" 100 two days ago, which the 7-day view
            # leaves out (the extension stopped refreshing it after 45 days) and 30 days counts.
            reading('a4', local(59, 12), impressions=500)
            reading('a4', local(50, 12), impressions=800)
            reading('a4', local(2, 12), impressions=900)
            # b1: one reading, inside the period.
            reading('b1', local(1, 12), impressions=70, impressions_out_of_network=20, reactions=3, comments=0)
            # b2: 900 in the previous period, then 850: never a negative gain.
            reading('b2', local(9, 12), impressions=900)
            reading('b2', local(2, 12), impressions=850)
            # c1: Cat's one big post, read once.
            reading('c1', local(1, 13), impressions=5000, impressions_out_of_network=1000, reactions=50, comments=10)
            active = db.execute('SELECT count(*) FROM members WHERE deleted_at IS NULL').fetchone()[0]
        start()

        # --- headline numbers --------------------------------------------------------------------
        week = stats(ann)
        c = week['company']
        check('7 days: original posts only (the reshare is left out)', c['posts']['value'] == 3)
        check('7 days: people who posted, out of every active account',
              c['people']['value'] == 3 and c['activeMembers'] == active)
        check('7 days: impressions gained = last known before the end minus last known before the start',
              c['impressions']['value'] == 250 + 300 + 70 + 5000)
        check('7 days: out-of-network gained, a post never read for it adds nothing',
              c['outOfNetworkImpressions']['value'] == 60 + 20 + 1000)
        check('7 days: reactions + comments gained; a reading that missed comments keeps the last known',
              c['engagement']['value'] == (8 + 1) + (3 + 0) + (50 + 10))
        check('7 days: compared with the previous 7 days', c['posts']['previous'] == 1 and c['people']['previous'] == 1
              and c['impressions']['previous'] == 900 and math.isclose(c['posts']['change'], 2.0)
              and math.isclose(c['impressions']['change'], (5620 - 900) / 900))
        check('nothing to compare against gives a null change, not Infinity',
              c['outOfNetworkImpressions']['previous'] == 0 and c['outOfNetworkImpressions']['change'] is None)
        check('the period is the past 7 days in the offset asked for',
              week['period']['since'] == local_date(today - 6 * DAY) + 'T00:00:00-07:00'
              and week['period']['until'] == local_date(today) + 'T23:59:59-07:00' and week['period']['bucket'] == 'day')

        month = stats(ann, days=30)['company']
        check('30 days: posts and people', month['posts']['value'] == 5 and month['people']['value'] == 3)
        check('30 days: a post published 60 days ago counts once the period reaches back to it, '
              'a number that fell counts its last value, never below 0',
              month['impressions']['value'] == 250 + 1300 + 100 + 70 + 850 + 5000)
        check('30 days: no posts in the previous 30 days gives a null change',
              month['posts']['previous'] == 0 and month['posts']['change'] is None
              and month['impressions']['previous'] == 800)

        quarter = stats(ann, days=90)
        q = quarter['company']
        check('90 days: posts and impressions', q['posts']['value'] == 6 and q['impressions']['value'] == 250 + 1300 + 900 + 70 + 850 + 5000)

        # --- buckets -----------------------------------------------------------------------------
        for name, view in [('7 days', week), ('30 days', stats(ann, days=30)), ('90 days', quarter)]:
            series = view['series']
            for key in ['posts', 'impressions', 'outOfNetworkImpressions', 'engagement']:
                assert sum(b['company'][key] for b in series) == view['company'][key]['value'], (name, key)
                assert sum(b['you'][key] for b in series) == view['you'][key]['value'], (name, key)
            check(f'{name}: every column of the series adds up to its headline number, for the company and for you', True)
        check('7 and 30 days are daily, 90 days weekly (13 weeks, the last one 6 days)',
              len(week['series']) == 7 and len(stats(ann, days=30)['series']) == 30
              and quarter['period']['bucket'] == 'week' and len(quarter['series']) == 13
              and [b['days'] for b in quarter['series']] == [7] * 12 + [6])
        by_day = {b['start'][:10]: b['company'] for b in week['series']}
        check('a gain is counted on the day it was read',
              by_day[local_date(local(3, 0))]['impressions'] == 100 and by_day[local_date(local(2, 0))]['impressions'] == 300
              and by_day[local_date(local(1, 0))]['impressions'] == 150 + 70 + 5000)

        # --- time zone ---------------------------------------------------------------------------
        b1_local = local_date(local(2, 22, 30))
        b1_utc = local_date(local(2, 22, 30), 0)
        utc = {b['start'][:10]: b['company']['posts'] for b in stats(ann, timezone='+00:00')['series']}
        mountain = {b['start'][:10]: b['company']['posts'] for b in week['series']}
        check('a 22:30 post in -07:00 is on its own day there and on the next day in UTC',
              b1_utc != b1_local and mountain[b1_local] == 1 and utc.get(b1_utc) == 2
              and stats(ann, timezone='+00:00')['period']['timezone'] == '+00:00')

        # --- you ---------------------------------------------------------------------------------
        you = week['you']
        check('you = your own subset (Ann: a1 published; a1 and a2 gained)',
              you['memberId'] == ann_id and you['posts']['value'] == 1 and you['impressions']['value'] == 250 + 300
              and you['outOfNetworkImpressions']['value'] == 60 and you['engagement']['value'] == 9
              and you['posted'] and you['hasSynced'])
        check('your shares are your number over the company number',
              math.isclose(you['shareOfPosts'], 1 / 3) and math.isclose(you['shareOfImpressions'], 550 / 5620)
              and math.isclose(you['shareOfOutOfNetworkImpressions'], 60 / 1080) and math.isclose(you['shareOfEngagement'], 9 / 72))
        check('your rank among everyone who posted (most posts, then most impressions gained)',
              you['rank'] == 2 and you['posterCount'] == 3)
        everyone = [stats(admin, path='/api/v1/stats', memberId=m)['you'] for m in (ann_id, bob_id, cat_id)]
        for key in ['posts', 'impressions', 'outOfNetworkImpressions', 'engagement']:
            assert sum(y[key]['value'] for y in everyone) == c[key]['value'], key
        check('the three authors\' numbers add up to the company\'s', True)
        check('their shares add up to 1',
              math.isclose(sum(y['shareOfImpressions'] for y in everyone), 1) and math.isclose(sum(y['shareOfPosts'] for y in everyone), 1))
        v1_ann = stats(admin, path='/api/v1/stats', memberId=ann_id)
        check('/api/v1/stats?memberId= returns the same `you` and series as that member sees',
              v1_ann['you'] == you and [b['you'] for b in v1_ann['series']] == [b['you'] for b in week['series']]
              and v1_ann['company'] == c)
        nobody = stats(dan)['you']
        check('someone with no posts gets zeros, no rank, and the not-synced flag',
              nobody['memberId'] == dan_id and not nobody['posted'] and not nobody['hasSynced'] and nobody['rank'] is None
              and all(nobody[k]['value'] == 0 and nobody[k]['change'] is None for k in ['posts', 'impressions', 'engagement'])
              and nobody['shareOfPosts'] == 0 and all(b['you']['posts'] == 0 for b in stats(dan)['series']))
        check('without memberId the API has no `you`',
              stats(admin, path='/api/v1/stats')['you'] is None and all(b['you'] is None for b in stats(admin, path='/api/v1/stats')['series']))
        stats(admin, path='/api/v1/stats', memberId=987654321, status=404)
        check('an unknown memberId is a 404', True)

        # --- lists -------------------------------------------------------------------------------
        check('top posters: most posts, then most impressions gained',
              [(r['displayName'], r['posts'], r['impressionsGained']) for r in week['topPosters']]
              == [('Cat Stats', 1, 5000), ('Ann Stats', 1, 550), ('Bob Stats', 1, 70)]
              and [r['isYou'] for r in week['topPosters']] == [False, True, False])
        check('top posts by impressions gained, with the first line of text and a link',
              [(p['postId'], p['impressionsGained']) for p in week['topPosts']]
              == [(post_ids['urn:li:activity:c1'], 5000), (post_ids['urn:li:activity:a2'], 300),
                  (post_ids['urn:li:activity:a1'], 250), (post_ids['urn:li:activity:b1'], 70)]
              and week['topPosts'][2]['firstLine'] == "Ann's launch post"
              and week['topPosts'][2]['postUrl'].endswith('urn:li:activity:a1/'))
        check('no emails anywhere in the overview', 'enzo.health' not in json.dumps(week) and 'demo.test' not in json.dumps(week))

        # --- a deleted author --------------------------------------------------------------------
        admin.request(f'/api/system/members/{cat_id}', method='DELETE')
        after = stats(ann)
        check('a deleted author\'s posts still count in the totals and the previous period',
              {k: v for k, v in after['company'].items() if k != 'activeMembers'}
              == {k: v for k, v in c.items() if k != 'activeMembers'} and after['company']['activeMembers'] == active - 1)
        former = after['topPosters'][0]
        check('...but they are listed as "Former member", with no id or name',
              former['displayName'] == 'Former member' and former['formerMember'] and former['memberId'] is None
              and after['topPosts'][0]['authorName'] == 'Former member' and after['topPosts'][0]['memberId'] is None
              and 'Cat Stats' not in json.dumps(after) and 'Cat Stats' not in json.dumps(stats(admin, path='/api/v1/stats')))

        # --- access ------------------------------------------------------------------------------
        anon.request('/api/stats/overview', status=401)
        check('anonymous: the overview API is a 401', True)
        code, location = anon.page('/')
        check('anonymous: the overview page sends you to sign in', code in (302, 303, 307) and location == '/auth/login')
        stats(anon, path='/api/v1/stats', status=401)
        stats(ann, path='/api/v1/stats', status=401)
        check('/api/v1/stats refuses no key and a regular member\'s session', True)
        key = admin.request('/api/system/api-keys', {'name': 'stats e2e'})['key']
        by_key = stats(anon, path='/api/v1/stats', token=key)
        check('/api/v1/stats answers an API key with the same company numbers', by_key['company'] == after['company'])
        stats(anon, path='/api/v1/stats', token='csk_wrong', status=401)
        check('...and refuses a wrong key', True)
        check('a period other than 7, 30 or 90 days is a 400',
              'days' in stats(ann, days=14, status=400)['error'] and 'timezone' in stats(ann, timezone='Denver', status=400)['error'])

        # --- challenges are admin-only for now ---------------------------------------------------
        challenge_id = admin.request('/api/challenges', {'name': 'Stats e2e challenge', 'start': local_date(today - 5 * DAY),
                                                         'end': local_date(today + 5 * DAY), 'config': {}})['id']
        for path in ['/', '/me', '/account']:
            code, _ = ann.page(path)
            assert code == 200, (path, code)
        ann.request('/api/me/posts')
        ann.request('/api/stats/overview')
        ann.request('/api/auth/me')
        check('a regular member gets the overview, My posts, the account page and their APIs', True)
        pages = ['/challenges', '/challenges/mine', '/challenges/new', f'/challenges/{challenge_id}',
                 f'/challenges/{challenge_id}/scoring', f'/challenges/{challenge_id}/invites',
                 f'/challenges/{challenge_id}/settings', '/admin', '/admin/challenges', f'/members/{bob_id}', '/rules']
        for path in pages:
            code, location = ann.page(path)
            assert code in (302, 303, 307) and location == '/', (path, code, location)
        check('a regular member is sent to / from every challenge page', True)
        apis = [('GET', '/api/challenges', None), ('POST', '/api/challenges', {'name': 'x', 'start': '2026-01-01', 'end': '2026-02-01', 'config': {}}),
                ('PUT', f'/api/challenges/{challenge_id}', {'name': 'x', 'start': '2026-01-01', 'end': '2026-02-01', 'isActive': True, 'config': {}}),
                ('PUT', f'/api/challenges/{challenge_id}/favorite', {'favorite': True}),
                ('GET', f'/api/challenges/{challenge_id}/invites', None),
                ('POST', f'/api/challenges/{challenge_id}/invites', {'emails': ['x@enzo.health'], 'role': 'participant'}),
                ('GET', '/api/leaderboard', None), ('GET', f'/api/leaderboard?challengeId={challenge_id}', None),
                ('GET', f'/api/admin/aggregate?challengeId={challenge_id}', None), ('GET', '/api/admin/overview', None),
                ('GET', f'/api/members/{ann_id}', None), ('GET', f'/api/members/{bob_id}?challengeId={challenge_id}', None),
                ('GET', '/api/me/invites', None), ('POST', '/api/invites/not-a-code/accept', None)]
        for method, path, body in apis:
            code, _, _ = ann.raw(path, body, method=method)
            assert code == 401, (method, path, code)
        check('a regular member is refused (401) by every challenge API', True)
        for path in pages[:5] + ['/admin', '/rules']:
            code, _ = admin.page(path)
            assert code == 200, (path, code)
        admin.request('/api/challenges')
        admin.request(f'/api/leaderboard?challengeId={challenge_id}')
        admin.request('/api/admin/overview')
        admin.request('/api/me/invites')
        check('a system admin still reaches the challenge pages and APIs', True)

        # --- stale --------------------------------------------------------------------------------
        check('fresh syncs: not stale', not after['sync']['stale'] and after['sync']['lastSyncAtUnix'] >= now - 60)
        stop()
        with sql() as db:
            db.execute('UPDATE profile_snapshots SET captured_at = captured_at - ?', (5 * DAY,))
            newest = db.execute('SELECT max(p.captured_at) FROM profile_snapshots p JOIN members m ON m.id = p.member_id '
                                'WHERE m.deleted_at IS NULL').fetchone()[0]
        start()
        stale = stats(ann)['sync']
        check('nobody synced for more than two days: stale, with the date of the last sync',
              stale['stale'] and stale['lastSyncAtUnix'] == newest and stale['lastSyncAt'].startswith(dt.datetime.fromtimestamp(newest, dt.timezone.utc).strftime('%Y-%m-%d')))
        print(json.dumps({'result': 'PASS', 'checks': len(checks)}), flush=True)
    finally:
        if state['process'].poll() is None:
            stop()
