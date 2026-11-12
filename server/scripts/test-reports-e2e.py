#!/usr/bin/env python3
"""Admin post reports and the reporting API, on a disposable database, after cargo build:

* anonymous visitors and non-admins cannot read the report, manage API keys, or use the API;
* an admin can create an API key, it works on /api/v1/posts, and a revoked key stops working;
* a key stops working when the admin who created it is no longer an admin;
* a sync token is refused as an API key, and an API key is refused by /api/sync;
* the date window (days in a fixed offset, UTC by default, or exact timestamps; both ends
  included), minImpressions, minOutOfNetworkImpressions and contains return exactly the expected
  posts; reshares are left out unless includeReposts=true; an unknown out-of-network number never
  matches; a post with no text never matches contains; each number is the newest value read (an
  older reading fills in when the newest one missed it); and the per-person summary is right;
* /api/v1/members lists every account with when it last synced (advancing on every sync, even with
  nothing new), whether a LinkedIn identity is bound, and a sync summary, with no emails;
* posts carry their full text, and the CSV export has the header, one row per post, and survives a
  comma, a quote and a newline in post text.
"""
import csv
import datetime as dt
import http.cookiejar
import io
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
JOIN_CODE = 'e2e-reports-code'
checks = []

def check(name, condition):
    assert condition, name
    checks.append(name)
    print('PASS:', name, flush=True)

with tempfile.TemporaryDirectory(prefix='reports-e2e-') as directory:
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

        class Response:
            def __init__(self, code, headers, body, url):
                self.code, self.headers, self.body, self.url = code, headers, body, url
            def json(self):
                return json.loads(self.body)

        class Client:
            def __init__(self, email=None, cookie=None):
                self.jar = http.cookiejar.CookieJar()
                self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
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
                return Response(response.code, response.headers, response.read(), response.geturl())
            def request(self, path, data=None, method=None, token=None, status=200):
                response = self.raw(path, data, method, token)
                assert response.code == status, (path, response.code, status, response.body)
                if response.headers.get_content_type() == 'application/json':
                    return response.json()
                return response.body.decode()

        def report(client, token=None, status=200, **params):
            query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
            return client.request('/api/v1/posts' + ('?' + query if query else ''), token=token, status=status)

        anon = Client()
        admin = Client('sysadmin@demo.test')
        member = Client('ada@demo.test')

        # Two fresh people, joined the way the extension joins, so the test owns their posts.
        def join(urn, first, last):
            joined = anon.request('/api/auth/extension/join', {'joinCode': JOIN_CODE, 'member': {
                'memberUrn': urn, 'publicIdentifier': f'{first}-{last}'.lower(), 'firstName': first,
                'lastName': last, 'profileUrl': f'https://www.linkedin.com/in/{first}-{last}'.lower()}})
            return joined['memberId'], joined['syncToken']
        rita_id, rita_token = join('urn:li:fsd_profile:RITA1', 'Rita', 'Report')
        sam_id, sam_token = join('urn:li:fsd_profile:SAM1', 'Sam', 'Sample')

        def post(urn, created, impressions, out_of_network, text='e2e post', is_repost=False):
            return {'urn': urn, 'permalink': f'https://www.linkedin.com/feed/update/{urn}/',
                    'createdAt': created, 'textPreview': text, 'isRepost': is_repost,
                    'metrics': {'impressions': impressions, 'impressionsInNetwork':
                                None if out_of_network is None else impressions - out_of_network,
                                'impressionsOutOfNetwork': out_of_network, 'reactions': 7, 'comments': 2}}
        def sync(token, posts, status=200):
            return anon.request('/api/sync', {'profile': {'followerCount': 100}, 'posts': posts},
                                token=token, status=status)

        # Longer than any preview, so the test sees the whole text come back.
        tricky = 'Hello, "world"\nsecond line, proud of Enzo. ' + 'More words. ' * 60
        sync(rita_token, [
            post('urn:li:activity:r1', '2025-03-03T00:00:00Z', 5000, 3500, text=tricky),
            post('urn:li:activity:r2', '2025-03-09T23:59:59Z', 2000, 3000, text='Big news from ENZO'),
            post('urn:li:activity:r3', '2025-03-10T00:00:00Z', 9000, 9000),
            post('urn:li:activity:r4', '2025-03-02T23:59:59Z', 9000, 9000),
            post('urn:li:activity:r5', '2025-03-05T12:00:00Z', 8000, None, text=None),
            # No creation time from LinkedIn: dated by its first snapshot, i.e. today.
            post('urn:li:activity:r6', None, 100, 10),
        ])
        sync(sam_token, [
            post('urn:li:activity:s1', '2025-03-06T08:00:00Z', 1200, 400, text='=1+1 is not a formula'),
            post('urn:li:activity:s2', '2025-03-07T08:00:00Z', 100, 50),
            post('urn:li:activity:s3', '2025-03-08T08:00:00Z', 3100, 3100, text='Reposting industry news',
                 is_repost=True),
        ])
        # A later reading of s2: the report must use this one, not the first.
        sync(sam_token, [post('urn:li:activity:s2', '2025-03-07T08:00:00Z', 4000, 2999,
                              text='Thoughts on the industry at enzo.health')])

        # Jason's draw week: Friday 2025-03-28 through Thursday 2025-04-03, Mountain daylight time
        # (-06:00). r7 went up Thursday 21:30 there, already Friday in UTC; r8 went up Thursday
        # 23:00 the week before there, already Friday in UTC.
        sync(rita_token, [
            post('urn:li:activity:r7', '2025-04-04T03:30:00Z', 1000, 100),
            post('urn:li:activity:r8', '2025-03-28T05:00:00Z', 1000, 100),
        ])
        # s9 passed 3,000 out of network, then a later read missed the analytics: the report must
        # keep 3,200 rather than drop the post.
        sync(sam_token, [post('urn:li:activity:s9', '2025-04-01T12:00:00Z', 5000, 3200)])
        first_read = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        time.sleep(1.1)
        sync(sam_token, [post('urn:li:activity:s9', '2025-04-01T12:00:00Z', 5600, None)])

        week = {'since': '2025-03-03', 'until': '2025-03-09'}
        urns = lambda result: [p['postUrl'].rsplit(':', 1)[1].rstrip('/') for p in result['posts']]

        # --- who can read it ---------------------------------------------------------------
        for name, response in [('anonymous', anon.raw('/api/v1/posts')),
                               ('a non-admin session', member.raw('/api/v1/posts')),
                               ('a made-up key', anon.raw('/api/v1/posts', token='csk_not-a-real-key'))]:
            assert response.code == 401 and 'error' in response.json(), (name, response.code, response.body)
        check('the API refuses anonymous callers, non-admins and made-up keys with a JSON 401', True)

        for client in (anon, member):
            client.request('/api/system/api-keys', status=401)
            client.request('/api/system/api-keys', {'name': 'sneaky'}, method='POST', status=401)
            client.request('/api/system/api-keys/1', method='DELETE', status=401)
        check('anonymous callers and non-admins cannot list, create or revoke API keys', True)

        page = member.raw('/reports')
        check('a non-admin is sent away from the reports page', not page.url.endswith('/reports'))
        page = admin.raw('/reports')
        check('an admin can open the reports page', page.code == 200 and page.url.endswith('/reports'))

        # --- API keys ----------------------------------------------------------------------
        admin.request('/api/system/api-keys', {'name': '  '}, method='POST', status=400)
        created = admin.request('/api/system/api-keys', {'name': "Jason's agent"}, method='POST')
        key = created['key']
        check('an admin can create a key, shown with its csk_ prefix',
              key.startswith('csk_') and len(key) > 40 and created['name'] == "Jason's agent")
        listed = admin.request('/api/system/api-keys')['keys']
        check('the key list shows the name but never the key',
              [k['name'] for k in listed] == ["Jason's agent"] and key not in json.dumps(listed)
              and listed[0]['lastUsedAt'] is None and listed[0]['createdByName'])

        by_key = report(anon, token=key, **week)
        check('the key works on /api/v1/posts', by_key['postCount'] == 5)
        check('using the key records when it was last used',
              admin.request('/api/system/api-keys')['keys'][0]['lastUsedAt'] is not None)
        check('an admin website session also works, for the reports page',
              report(admin, **week)['postCount'] == 5)

        report(anon, token=rita_token, status=401)
        check('a sync token is refused as an API key', True)
        sync(key, [], status=401)
        anon.request('/api/me/sync-status', token=key, status=401)
        check('an API key is refused by the sync endpoints', True)

        # --- the report itself -------------------------------------------------------------
        check('the window includes both end days and nothing outside them (UTC); reshares left out',
              sorted(urns(by_key)) == ['r1', 'r2', 'r5', 's1', 's2']
              and by_key['filters']['includeReposts'] is False)
        everyone = {a['memberId']: a for a in by_key['authors']}
        check('with no minimum, the summary is who posted original posts and how often',
              set(everyone) == {rita_id, sam_id}
              and everyone[rita_id]['postsInPeriod'] == 3 and everyone[rita_id]['matchingPosts'] == 3
              and everyone[sam_id]['postsInPeriod'] == 2 and everyone[sam_id]['matchingPosts'] == 2)
        s2 = next(p for p in by_key['posts'] if p['postUrl'].endswith('s2/'))
        check('numbers come from the latest snapshot',
              s2['impressions'] == 4000 and s2['impressionsOutOfNetwork'] == 2999)
        r5 = next(p for p in by_key['posts'] if p['postUrl'].endswith('r5/'))
        check('an unknown out-of-network number is null, not zero', r5['impressionsOutOfNetwork'] is None)
        r1 = next(p for p in by_key['posts'] if p['postUrl'].endswith('r1/'))
        check('each post carries its author, link, time and full text',
              r1['memberId'] == rita_id and r1['authorName'] == 'Rita Report'
              and r1['authorPublicIdentifier'] == 'rita-report'
              and r1['postedAt'] == '2025-03-03T00:00:00Z' and r1['text'] == tricky
              and r1['reactions'] == 7 and r1['comments'] == 2)
        with_reshares = report(anon, token=key, includeReposts='true', **week)
        s3 = next(p for p in with_reshares['posts'] if p['postUrl'].endswith('s3/'))
        sam = next(a for a in with_reshares['authors'] if a['memberId'] == sam_id)
        check('includeReposts=true brings reshares back, flagged, and counts them',
              s3['isRepost'] is True and with_reshares['postCount'] == 6 and sam['postsInPeriod'] == 3
              and with_reshares['filters']['includeReposts'] is True)
        result = report(anon, token=key, includeReposts='true', minOutOfNetworkImpressions=3000, **week)
        check('with reshares, a reshare can match the filters too', urns(result) == ['r1', 's3', 'r2'])

        result = report(anon, token=key, minImpressions=3000, **week)
        check('minImpressions keeps posts at or above it, highest impressions first',
              urns(result) == ['r5', 'r1', 's2'] and result['sortedBy'] == 'impressions')

        result = report(anon, token=key, minOutOfNetworkImpressions=3000, **week)
        check('minOutOfNetworkImpressions keeps posts at or above it, highest first; unknown never matches',
              urns(result) == ['r1', 'r2'] and result['sortedBy'] == 'impressionsOutOfNetwork')
        summary = {a['memberId']: (a['postsInPeriod'], a['matchingPosts']) for a in result['authors']}
        check('the summary counts every original post in the period and the ones that matched',
              summary == {rita_id: (3, 2), sam_id: (2, 0)}
              and [a['memberId'] for a in result['authors']] == [rita_id, sam_id])

        result = report(anon, token=key, minImpressions=3000, minOutOfNetworkImpressions=3000, **week)
        check('both minimums together must both hold', urns(result) == ['r1'])

        result = report(anon, token=key, contains='enzo', **week)
        check('contains finds the word in any case and inside enzo.health, highest impressions first',
              urns(result) == ['r1', 's2', 'r2'])
        check('contains ignores the case of the search text too',
              urns(report(anon, token=key, contains='ENZO', **week)) == ['r1', 's2', 'r2'])
        check('a post with no stored text never matches contains',
              'r5' in urns(by_key) and next(p for p in by_key['posts'] if p['postUrl'].endswith('r5/'))['text'] is None
              and 'r5' not in urns(report(anon, token=key, contains='e', **week)))
        result = report(anon, token=key, contains='enzo', minOutOfNetworkImpressions=3000, **week)
        summary = {a['memberId']: (a['postsInPeriod'], a['matchingPosts']) for a in result['authors']}
        check('contains combines with the impression filters',
              urns(result) == ['r1', 'r2'] and summary == {rita_id: (3, 2), sam_id: (2, 0)}
              and result['filters']['contains'] == 'enzo')

        result = report(anon, token=key, memberId=sam_id, **week)
        check('memberId narrows the report to one person',
              sorted(urns(result)) == ['s1', 's2'] and [a['memberId'] for a in result['authors']] == [sam_id])

        result = report(anon, token=key, since='2025-03-09', until='2025-03-09')
        check('a one-day window covers that whole UTC day', urns(result) == ['r2'])

        # --- time zones and exact instants ------------------------------------------------
        draw = {'since': '2025-03-28', 'until': '2025-04-03'}
        result = report(anon, token=key, timezone='-06:00', **draw)
        check('dates are read in the given offset: a Thursday-evening Mountain post stays in its week',
              sorted(urns(result)) == ['r7', 's9'])
        check('the resolved period is echoed as exact instants with the offset',
              result['filters']['since'] == '2025-03-28T00:00:00-06:00'
              and result['filters']['until'] == '2025-04-03T23:59:59-06:00'
              and result['filters']['timezone'] == '-06:00' and result['timezone'] == '-06:00')
        r7 = next(p for p in result['posts'] if p['postUrl'].endswith('r7/'))
        check('each post also carries its time in the requested offset',
              r7['postedAt'] == '2025-04-04T03:30:00Z' and r7['postedAtLocal'] == '2025-04-03T21:30:00-06:00')
        check('the same dates in UTC (the default) cover a different week',
              sorted(urns(report(anon, token=key, **draw))) == ['r8', 's9'])
        exact = report(anon, token=key, since='2025-03-28T00:00:00-06:00', until='2025-04-03T23:59:59-06:00')
        check('exact timestamps give the same week as dates with an offset',
              sorted(urns(exact)) == ['r7', 's9'] and exact['filters']['since'] == '2025-03-28T06:00:00+00:00')
        check('a timestamp until is inclusive to the second',
              'r7' in urns(report(anon, token=key, since='2025-04-01', until='2025-04-04T03:30:00Z'))
              and 'r7' not in urns(report(anon, token=key, since='2025-04-01', until='2025-04-04T03:29:59Z')))
        # An agent that forgets to encode `+` in a URL sends a space; it still means +.
        raw = anon.request('/api/v1/posts?since=2025-04-04T04:30:00+01:00&until=2025-04-04&timezone=+01:00', token=key)
        check('an unencoded + in a timestamp or offset still works',
              urns(raw) == ['r7'] and raw['filters']['timezone'] == '+01:00')

        # --- last known numbers -------------------------------------------------------------
        result = report(anon, token=key, timezone='-06:00', minOutOfNetworkImpressions=3000, **draw)
        s9 = result['posts'][0] if result['posts'] else {}
        check('a number the newest reading missed falls back to the last one read, and still matches',
              urns(result) == ['s9'] and s9['impressionsOutOfNetwork'] == 3200 and s9['impressions'] == 5600)
        check('metricsCapturedAt is the newest reading, not the one the number came from',
              s9['metricsCapturedAt'] is not None and s9['metricsCapturedAt'] > first_read)

        result = report(anon, token=key)
        today = dt.datetime.now(dt.timezone.utc).date()
        check('with no dates the window is today and the six days before (UTC)',
              result['filters']['until'] == today.isoformat() + 'T23:59:59+00:00'
              and result['filters']['since'] == (today - dt.timedelta(days=6)).isoformat() + 'T00:00:00+00:00')
        # The demo seed dates posts relative to startup: Dev, Ben and Erin posted 4–6 days ago,
        # Ada 8 days ago. r6 had no creation time, so it counts from its first snapshot (today).
        names = sorted(a['displayName'] for a in result['authors'])
        check('the default window holds this week\'s posts and nothing older',
              names == ['Ben Cho', 'Dev Patel', 'Erin Wong', 'Rita Report'] and result['postCount'] == 4
              and 'r6' in urns(result))

        for params in ({'since': '2025-02-30'}, {'since': '2025-03-09', 'until': '2025-03-01'},
                       {'minImpressions': 'lots'}, {'minImpressions': '-5'}, {'format': 'xml'},
                       {'timezone': 'America/Denver'}, {'timezone': '-7'}, {'since': '2025-03-28T00:00:00'},
                       {'includeReposts': 'maybe'}):
            assert 'error' in report(anon, token=key, status=400, **params), params
        check('invalid parameters get a JSON 400', True)

        # --- CSV ---------------------------------------------------------------------------
        response = anon.raw('/api/v1/posts?' + urllib.parse.urlencode({**week, 'format': 'csv'}),
                            token=key)
        text = response.body.decode('utf-8')
        check('the CSV is served as a named download',
              response.code == 200 and response.headers.get_content_type() == 'text/csv'
              and 'filename="posts-2025-03-03-to-2025-03-09.csv"' in response.headers['Content-Disposition'])
        check('the CSV starts with a byte order mark for Excel, then a plain header row',
              text.startswith('\ufeffposted_date,posted_at_utc,posted_at_local,author_name,author_member_id,'))
        rows = list(csv.reader(io.StringIO(text.lstrip('\ufeff'), newline='')))
        header, rows = rows[0], rows[1:]
        check('the CSV has one row per post', len(rows) == 5 and len(set(map(len, rows))) == 1
              and len(header) == len(rows[0]))
        by_url = {row[header.index('post_url')]: dict(zip(header, row)) for row in rows}
        r1_row = by_url['https://www.linkedin.com/feed/update/urn:li:activity:r1/']
        check('post text with a comma, a quote and a newline survives the CSV',
              r1_row['text'] == tricky and r1_row['posted_date'] == '2025-03-03'
              and r1_row['posted_at_utc'] == '2025-03-03T00:00:00Z'
              and r1_row['posted_at_local'] == '2025-03-03T00:00:00+00:00' and r1_row['impressions'] == '5000')
        check('an unknown number is an empty cell',
              by_url['https://www.linkedin.com/feed/update/urn:li:activity:r5/']['impressions_out_of_network'] == '')
        check('post text cannot run as a spreadsheet formula',
              by_url['https://www.linkedin.com/feed/update/urn:li:activity:s1/']['text'] == "'=1+1 is not a formula")
        response = anon.raw('/api/v1/posts?' + urllib.parse.urlencode(
            {**week, 'format': 'csv', 'minOutOfNetworkImpressions': 3000}), token=key)
        rows = list(csv.reader(io.StringIO(response.body.decode('utf-8').lstrip('\ufeff'), newline='')))[1:]
        check('the CSV holds exactly the filtered rows, in the same order',
              [row[header.index('post_url')].rsplit(':', 1)[1].rstrip('/') for row in rows] == ['r1', 'r2'])
        response = anon.raw('/api/v1/posts?' + urllib.parse.urlencode({**draw, 'format': 'csv', 'timezone': '-06:00'}), token=key)
        rows = list(csv.DictReader(io.StringIO(response.body.decode('utf-8').lstrip('\ufeff'), newline='')))
        r7_row = next(row for row in rows if row['post_url'].endswith('r7/'))
        check('the CSV follows the offset: local time column, local day, and the file name',
              r7_row['posted_at_local'] == '2025-04-03T21:30:00-06:00' and r7_row['posted_date'] == '2025-04-03'
              and r7_row['posted_at_utc'] == '2025-04-04T03:30:00Z'
              and 'filename="posts-2025-03-28-to-2025-04-03.csv"' in response.headers['Content-Disposition'])
        response = anon.raw('/api/v1/posts?' + urllib.parse.urlencode(
            {**week, 'format': 'csv', 'contains': 'Enzo', 'minOutOfNetworkImpressions': 3000}), token=key)
        rows = list(csv.reader(io.StringIO(response.body.decode('utf-8').lstrip('\ufeff'), newline='')))[1:]
        check('the CSV applies contains too',
              [row[header.index('post_url')].rsplit(':', 1)[1].rstrip('/') for row in rows] == ['r1', 'r2'])
        check('an admin session can download the CSV too (the Export button)',
              admin.raw('/api/v1/posts?format=csv').code == 200)

        # --- members and sync health -------------------------------------------------------
        for name, response in [('anonymous', anon.raw('/api/v1/members')),
                               ('a non-admin session', member.raw('/api/v1/members')),
                               ('a sync token', anon.raw('/api/v1/members', token=rita_token))]:
            assert response.code == 401 and 'error' in response.json(), (name, response.code, response.body)
        check('/api/v1/members refuses callers without a key or an admin session', True)

        gina_id, _ = join('urn:li:fsd_profile:GINA1', 'Gina', 'Newhire')
        raw = anon.raw('/api/v1/members', token=key)
        members = raw.json()
        by_id = {m['memberId']: m for m in members['members']}
        check('a member who has synced shows when', by_id[rita_id]['lastSyncedAt'] is not None
              and by_id[rita_id]['linked'] is True and isinstance(by_id[rita_id]['lastSyncedAtUnix'], int))
        check('a member who joined but never synced is linked with no sync time',
              by_id[gina_id]['linked'] is True and by_id[gina_id]['lastSyncedAt'] is None
              and by_id[gina_id]['postCount'] == 0 and by_id[gina_id]['newestPostAt'] is None)
        sysadmin = next(m for m in members['members'] if m['displayName'] == admin.request('/api/auth/me')['displayName'])
        check('an account with a placeholder LinkedIn identity is not linked', sysadmin['linked'] is False)
        check('post counts are original posts only, with the newest post time',
              by_id[sam_id]['postCount'] == 3 and by_id[sam_id]['newestPostAt'] == '2025-04-01T12:00:00Z'
              and by_id[rita_id]['profileUrl'] == 'https://www.linkedin.com/in/rita-report'
              and by_id[rita_id]['publicIdentifier'] == 'rita-report')
        now_unix = time.time()
        synced = [m['lastSyncedAtUnix'] for m in members['members'] if m['lastSyncedAtUnix'] is not None]
        summary = members['sync']
        check('the sync summary counts are right',
              summary['totalMembers'] == len(members['members'])
              and summary['membersSyncedLast24h'] == len([t for t in synced if t >= now_unix - 86400 - 5]) == 7
              and summary['membersSyncedLast7d'] == 7
              and summary['linkedMembersNeverSynced'] == 1
              and summary['newestSyncAt'] == max(m['lastSyncedAt'] for m in members['members'] if m['lastSyncedAt']))
        check('no email appears anywhere in the members response',
              '@' not in raw.body.decode() and 'email' not in raw.body.decode().lower())

        before = by_id[rita_id]['lastSyncedAtUnix']
        time.sleep(1.1)
        sync(rita_token, [post('urn:li:activity:r7', '2025-04-04T03:30:00Z', 1000, 100)])
        after = {m['memberId']: m for m in anon.request('/api/v1/members', token=key)['members']}[rita_id]
        check('a sync with nothing new still advances lastSyncedAt', after['lastSyncedAtUnix'] > before)

        response = anon.raw('/api/v1/members?format=csv', token=key)
        text = response.body.decode('utf-8')
        rows = list(csv.DictReader(io.StringIO(text.lstrip('\ufeff'), newline='')))
        check('the members list downloads as CSV with the same conventions',
              response.headers.get_content_type() == 'text/csv' and text.startswith('\ufeffmember_id,display_name,')
              and 'filename="members-' in response.headers['Content-Disposition']
              and len(rows) == len(members['members']) and '@' not in text
              and next(r for r in rows if r['member_id'] == str(gina_id))['last_synced_at_utc'] == '')
        check('an admin session can read the members list too', admin.raw('/api/v1/members').code == 200)

        # --- revoking ----------------------------------------------------------------------
        key_id = created['id']
        admin.request(f'/api/system/api-keys/{key_id}', method='DELETE')
        report(anon, token=key, status=401, **week)
        check('a revoked key stops working at once', admin.request('/api/system/api-keys')['keys'] == [])
        admin.request(f'/api/system/api-keys/{key_id}', method='DELETE', status=404)
        check('revoking a key that does not exist is a 404', True)

        # A key carries its creator's access: once they are not an admin, it stops working.
        session = anon.request('/api/auth/device/web-session', method='POST', token=rita_token)['sessionToken']
        rita = Client(cookie=session)
        admin.request(f'/api/system/members/{rita_id}/admin', {'isAdmin': True}, method='PUT')
        rita_key = rita.request('/api/system/api-keys', {'name': 'Rita script'}, method='POST')['key']
        report(anon, token=rita_key, **week)
        admin.request(f'/api/system/members/{rita_id}/admin', {'isAdmin': False}, method='PUT')
        report(anon, token=rita_key, status=401, **week)
        check('a key stops working when its creator is no longer an admin', True)
    finally:
        process.terminate()
        process.wait(timeout=10)

print(f'reports e2e passed: {len(checks)} checks')
