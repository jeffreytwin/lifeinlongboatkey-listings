#!/usr/bin/env python3
"""Verify the live site serves every URL recorded in a NeighborhoodsCondos export.

Usage: python3 check-live-urls.py <export.csv | url-list.txt>

Pass either a collection export CSV or a plain text file with one URL per
line (see audit/live-urls.txt for a pre-built list). Checks, with 8
concurrent requests (stdlib only, no pip installs needed):
  - every 'Neighborhood Pages Main' URL returns 200
  - every 'Neighborhood Homes for Sale Pages' URL returns 200
  - every 'Nearby Neighborhood N Link' returns 200
  - the known retired URLs 301/308-redirect to their replacements

Exit code 0 when everything passes, 1 when anything fails.
"""
import csv
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = 'https://www.lifeinlongboatkey.com'

# Old paths retired on 2026-07-27; each should permanently redirect to its successor.
OLD_REDIRECTS = {
    '/neighborhood/sea-horse': '/neighborhood/seahorse-beach-resort',
    '/neighborhood-homes-for-sale/the-pierre': '/neighborhood-homes-for-sale/pierre',
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(url, follow=True):
    """Return (status, location) for a GET; location only when not following."""
    handlers = [] if follow else [NoRedirect()]
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (link check)'})
    try:
        with opener.open(req, timeout=20) as resp:
            return resp.status, ''
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('Location', '')
    except Exception as e:
        return 0, str(e)


def main(src_path):
    if src_path.endswith('.txt'):
        with open(src_path, encoding='utf-8') as f:
            urls = {u.strip(): 'from url list' for u in f if u.strip()}
    else:
        with open(src_path, encoding='utf-8-sig', newline='') as f:
            rows = list(csv.DictReader(f))
        urls = {}
        for r in rows:
            name = r['Neighborhood Name']
            for col, kind in (('Neighborhood Pages Main', 'main page'),
                              ('Neighborhood Homes for Sale Pages', 'homes-for-sale page')):
                path = r[col].strip()
                if path:
                    urls.setdefault(BASE + path, f'{name} {kind}')
            for n in '1234':
                link = r[f'Nearby Neighborhood {n} Link'].strip()
                if link:
                    urls.setdefault(link, f'{name} nearby link {n}')

    print(f'checking {len(urls)} unique urls...')
    failures = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for url, (status, _) in zip(urls, pool.map(fetch, urls)):
            if status != 200:
                failures.append((url, status, urls[url]))
                print(f'  FAIL {status or "ERR":>4} {url}  ({urls[url]})')
    print(f'{len(urls) - len(failures)}/{len(urls)} urls returned 200')

    print(f'\nchecking {len(OLD_REDIRECTS)} retired urls for redirects...')
    for old, new in OLD_REDIRECTS.items():
        status, location = fetch(BASE + old, follow=False)
        target = location.replace(BASE, '')
        # Wix serves redirects it doesn't know as 404s; anything but a permanent
        # redirect to the successor means the redirect rule is missing or wrong.
        if status in (301, 308) and target.split('?')[0] == new:
            print(f'  OK   {status} {old} -> {target}')
        else:
            failures.append((BASE + old, status, f'expected redirect to {new}, got {location or "none"}'))
            print(f'  FAIL {status or "ERR":>4} {old} -> {location or "(no redirect)"} (expected {new})')

    print(f'\n{"ALL CHECKS PASSED" if not failures else f"{len(failures)} FAILURES"}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
