#!/usr/bin/env python3
"""Server-Timing carries real durations and the app's own spans, on a disposable database, after
cargo build:

* a signed-in /api/auth/me reports non-zero handler and total durations, a `session` span for the
  session lookup and a `db` span for the last-sync query;
* /api/stats/overview splits its queries into `db-posts`, `db-members` and `db-profiles`;
* the reporting API (/api/v1/stats) times its key-or-admin check as `auth`;
* a signed-out /api/auth/me still carries the header (its durations can round to 0.0: it does no
  I/O, which is what production shows for signed-out probes).

Every value is a well-formed `name;dur=<ms>` entry, and the spans fit inside the handler.
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
checks = []


def check(name, condition, detail=''):
    assert condition, f'{name}: {detail}'
    checks.append(name)
    print('PASS:', name, flush=True)


def parse(header):
    """`a;dur=1.2, b;dur=3.0, route;desc="/x"` -> ({'a': 1.2, 'b': 3.0}, 'route desc')."""
    durations, route = {}, None
    for entry in header.split(','):
        entry = entry.strip()
        m = re.fullmatch(r'([A-Za-z0-9_.*/-]+);dur=([0-9]+(?:\.[0-9]+)?)', entry)
        if m:
            assert m.group(1) not in durations, f'duplicate {m.group(1)} in {header}'
            durations[m.group(1)] = float(m.group(2))
            continue
        m = re.fullmatch(r'route;desc="([^"]*)"', entry)
        assert m, f'unexpected Server-Timing entry {entry!r} in {header}'
        route = m.group(1)
    return durations, route


with tempfile.TemporaryDirectory(prefix='server-timing-e2e-') as directory:
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

        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

        def get(path, data=None):
            request = urllib.request.Request(base + path, headers={'Content-Type': 'application/json'},
                                             data=json.dumps(data).encode() if data is not None else None)
            try:
                response = opener.open(request)
            except urllib.error.HTTPError as error:
                response = error
            body = response.read()
            assert response.code == 200, (path, response.code, body[:300])
            header = response.headers.get('Server-Timing')
            assert header, f'{path}: no Server-Timing header'
            return parse(header)

        # Signed out first: the header is there and well-formed. With no cookie there is nothing to
        # look up, so its durations may honestly round to 0.0; this is the production 0.0 case.
        out, route = get('/api/auth/me')
        check('signed out: header present for the route', route == '/api/auth/me', out)
        check('signed out: the usual segments', {'mw', 'handler', 'total'} <= set(out), out)

        get('/api/auth/login', {'email': 'sysadmin@demo.test', 'password': 'demopassword'})

        def timed(path, spans):
            durations, route = get(path)
            for name in ('handler', 'total', *spans):
                check(f'{path}: {name} is non-zero', durations.get(name, 0) > 0, durations)
            for name in spans:
                # Rounded to 0.1 ms each, so allow that much slack per span.
                check(f'{path}: {name} fits in the handler',
                      durations[name] <= durations['handler'] + 0.1 * len(spans), durations)
            check(f'{path}: handler fits in total', durations['handler'] <= durations['total'] + 0.1, durations)
            return durations

        me = timed('/api/auth/me', ['session', 'db'])
        timed('/api/stats/overview', ['session', 'db-posts', 'db-members', 'db-profiles'])
        timed('/api/v1/stats', ['auth', 'db-posts', 'db-members', 'db-profiles'])
        print('sample /api/auth/me:', me, flush=True)
        print(json.dumps({'result': 'PASS', 'checks': len(checks)}), flush=True)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
