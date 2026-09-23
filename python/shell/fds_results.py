"""Read-only bounded ranges from a result folder explicitly selected by the user."""
from __future__ import annotations

import os
from pathlib import Path
import re
import secrets
from typing import Any, Dict

MAX_READ = 64 * 1024 * 1024
EXTENSIONS = {'.smv', '.sf', '.bf', '.s3d', '.sz', '.csv', '.bnd'}
MAX_FILES = 20000
#: Sidecars FDS writes beside a listed output without naming them in the .smv.
SIDECARS = ('', '.bnd', '.sz')


def result_name(line: str):
    """A result path as the page spells it, or None when it is not a safe relative one.

    Mirror of `safeResultPath` in web/src/core/fds-results.ts: forward slashes,
    repeated separators collapsed (FDS appends '/' to a RESULTS_DIR that may already
    end in '\\'), and nothing absolute, drive-qualified, dotted or empty.
    """
    path = re.sub(r'/+', '/', line.strip().replace('\\', '/'))
    if not path or path.startswith('/') or ':' in path or '\x00' in path:
        return None
    if any(part in ('', '.', '..') for part in path.split('/')):
        return None
    return path


class ResultFiles:
    def __init__(self) -> None:
        self.sessions: Dict[str, Any] = {}

    def open(self, smv_path: str) -> Dict[str, Any]:
        smv = Path(smv_path).resolve(strict=True)
        if smv.suffix.lower() != '.smv' or not smv.is_file():
            raise ValueError('Choose a Smokeview metadata (.smv) file.')
        root = smv.parent
        files = {}

        def offer(name: str, p: Path) -> None:
            if p.suffix.lower() not in EXTENSIONS or p.is_symlink() or not p.is_file():
                return
            resolved = p.resolve(strict=True)
            if not resolved.is_relative_to(root):
                return
            stat = p.stat()
            files[name] = (p, stat.st_size, stat.st_mtime_ns)
            if len(files) > MAX_FILES:
                raise ValueError('Result folder exceeds {} files.'.format(MAX_FILES))

        for p in root.iterdir():
            offer(p.name, p)
        # FDS writes the .smv and the CSVs beside the input, but with RESULTS_DIR
        # every binary output goes into that folder and the .smv names it with the
        # prefix (`out/CHID_1_1.sf`). Offer exactly the subfolder paths the .smv
        # references, and their sidecars -- not a recursive walk of the folder.
        with smv.open('r', encoding='utf-8', errors='replace') as stream:
            for line in stream:
                name = result_name(line)
                if name is None or '/' not in name or Path(name).suffix.lower() not in EXTENSIONS:
                    continue
                for suffix in SIDECARS:
                    candidate = name + suffix
                    if candidate not in files:
                        offer(candidate, root.joinpath(*candidate.split('/')))
        token = secrets.token_urlsafe(24)
        if len(self.sessions) >= 4:
            self.sessions.pop(next(iter(self.sessions)))  # release abandoned/reloaded pages
        self.sessions[token] = (root, files)
        return {'token': token, 'smv': smv.name, 'files': [
            {'name': name, 'size': item[1]} for name, item in files.items()
        ]}

    def close(self, token: str) -> None:
        self.sessions.pop(token, None)

    def read(self, token: str, name: str, offset: int, length: int) -> bytes:
        # One lookup: a close on another request thread between a membership test
        # and an index raised a KeyError the route does not catch.
        session = self.sessions.get(token)
        if session is None:
            raise ValueError('Unknown or closed results session.')
        root, files = session
        if name not in files:
            raise ValueError('File was not selected with this results folder.')
        if (type(offset) is not int or type(length) is not int or offset < 0
                or length < 0 or length > MAX_READ):
            raise ValueError('Invalid result byte range (maximum 64 MiB).')
        path, size, modified = files[name]
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(root) or path.is_symlink():
            raise ValueError('Result path left the selected folder.')
        with resolved.open('rb') as stream:
            stat = os.fstat(stream.fileno())
            if stat.st_size != size or stat.st_mtime_ns != modified:
                raise ValueError('Result file changed; reopen the completed simulation.')
            if offset + length > size:
                raise ValueError('Result byte range extends past the file.')
            stream.seek(offset)
            data = stream.read(length)
        if len(data) != length:
            raise ValueError('Truncated result read.')
        return data
