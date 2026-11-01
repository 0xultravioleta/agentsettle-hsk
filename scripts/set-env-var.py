#!/usr/bin/env python3
"""Sets VAR=value in an env file atomically: a temp file in the same directory (mode 600), fsync, then os.replace.
A crash midway leaves the old file whole; it never truncates the only copy of the keys.

    python3 scripts/set-env-var.py .env RECEIPTS_ADDRESS_MAINNET 0x...
"""
import os
import re
import sys
import tempfile

path, var, value = sys.argv[1], sys.argv[2], sys.argv[3]
if not re.fullmatch(r'[A-Z][A-Z0-9_]*', var) or '\n' in value:
    sys.exit(f'refusing to write {var!r}')
with open(path) as f:
    text = f.read()
line = f'{var}={value}'
pattern = re.compile(rf'^{re.escape(var)}=.*$', re.M)
text = pattern.sub(lambda _: line, text) if pattern.search(text) else text + ('' if text.endswith('\n') or not text else '\n') + line + '\n'
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix='.env.', suffix='.tmp')
try:
    with os.fdopen(fd, 'w') as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
except BaseException:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise
