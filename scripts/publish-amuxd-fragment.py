#!/usr/bin/env python3
"""Upload a standalone amuxd binary to OSS and emit a page fragment.

Publishes the daemon binary (built per platform for the desktop bundle) to
`<prefix>/amuxd/<version>/amuxd-<os>-<arch>[.exe]` so it can be installed on
its own — independent of the TeamClaw desktop app — and writes a small JSON
fragment the `publish-manifest` job folds into the beta install page.

Env:
  BIN            path to the built amuxd binary (required)
  AMUXD_OS       macos | windows | linux (required)
  MATRIX_TARGET  rust target triple, used to derive arch (required)
  TAG            beta tag, e.g. v0.2.20-beta.3 (required)
  OSS_PREFIX     OSS key prefix (default: beta)
  CDN_BASE       public CDN base for URLs (required)
  OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_ENDPOINT / OSS_BUCKET
"""
import hashlib
import json
import os
import sys

import oss2


def filemeta(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return os.path.getsize(p), h.hexdigest()


bin_path = os.environ['BIN']
amuxd_os = os.environ['AMUXD_OS']
target = os.environ['MATRIX_TARGET']
tag = os.environ['TAG']
version = tag[1:] if tag.startswith('v') else tag
prefix = os.environ.get('OSS_PREFIX', 'beta')
cdn = os.environ['CDN_BASE'].rstrip('/')

if not os.path.isfile(bin_path):
    print(f'::error::amuxd binary not found at {bin_path}')
    sys.exit(1)

arch = 'aarch64' if target.startswith('aarch64') else 'x86_64'
ext = '.exe' if amuxd_os == 'windows' else ''
name = f'amuxd-{amuxd_os}-{arch}{ext}'

os_label = {'macos': 'macOS', 'windows': 'Windows', 'linux': 'Linux'}[amuxd_os]
arch_label = 'arm64' if arch == 'aarch64' else 'x64'
if amuxd_os == 'macos':
    label = f"macOS {'Apple Silicon' if arch == 'aarch64' else 'Intel'}"
else:
    label = f'{os_label} ({arch_label})'

auth = oss2.Auth(os.environ['OSS_ACCESS_KEY_ID'], os.environ['OSS_ACCESS_KEY_SECRET'])
endpoint = os.environ['OSS_ENDPOINT']
if not endpoint.startswith('http'):
    endpoint = 'https://' + endpoint
bucket = oss2.Bucket(auth, endpoint, os.environ['OSS_BUCKET'])

key = f'{prefix}/amuxd/{version}/{name}'
print(f'Uploading {name} -> oss://{os.environ["OSS_BUCKET"]}/{key}')
bucket.put_object_from_file(key, bin_path)
url = f'{cdn}/{key}'
size, sha = filemeta(bin_path)
print(f'✅ {url}  ({size} bytes)')

frag = {
    'amuxd': {
        'os': amuxd_os,
        'arch': arch,
        'label': label,
        'sub': f'amuxd · {os_label} {arch_label}',
        'filename': name,
        'url': url,
        'size': size,
        'sha256': sha,
    }
}
os.makedirs('frag', exist_ok=True)
with open(f'frag/amuxd-{amuxd_os}-{arch}.json', 'w') as f:
    json.dump(frag, f)
print('Fragment:', json.dumps(frag))
