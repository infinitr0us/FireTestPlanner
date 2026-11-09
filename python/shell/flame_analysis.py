"""Read-only whole files from a flame analysis folder the user opened.

The page names files by their '/' path inside the folder that holds the picked
`analysis.json` (CONVENTIONS.md section 13). A token stands for that folder, and
every read is confined to it: no absolute, drive-qualified, dotted or empty
segment, no link that leads out, regular files only, and a size cap.
"""
from __future__ import annotations

import os
from pathlib import Path
import secrets
import stat
from typing import Any, Dict

MAX_FILE = 64 * 1024 * 1024
MAX_SESSIONS = 4


def analysis_path(name: str):
    """A path as the page spells it, or None unless it is a safe relative one.
    The same rule as `pathProblem` in web/src/core/flame-analysis.ts."""
    if not isinstance(name, str) or not name or name.startswith('/'):
        return None
    if any(ch in '\\:{}' or ord(ch) < 32 or ord(ch) == 127 for ch in name):
        return None
    if any(part in ('', '.', '..') for part in name.split('/')):
        return None
    return name


class AnalysisFolders:
    def __init__(self) -> None:
        self.sessions: Dict[str, Path] = {}

    def open(self, manifest: str) -> Dict[str, Any]:
        path = Path(manifest).resolve(strict=True)
        if path.name.lower() != 'analysis.json' or not path.is_file():
            raise ValueError('Choose the analysis.json of a flame analysis folder.')
        token = secrets.token_urlsafe(24)
        if len(self.sessions) >= MAX_SESSIONS:
            self.sessions.pop(next(iter(self.sessions)))  # release abandoned or reloaded pages
        self.sessions[token] = path.parent
        return {'token': token, 'name': path.parent.name}

    def close(self, token: str) -> None:
        self.sessions.pop(token, None)

    def read(self, token: str, name: str) -> bytes:
        root = self.sessions.get(token)
        if root is None:
            raise ValueError('Unknown or closed flame analysis session.')
        relative = analysis_path(name)
        if relative is None:
            raise ValueError('Not a path inside the analysis folder: {!r}'.format(name))
        path = root.joinpath(*relative.split('/'))
        with path.open('rb') as stream:
            # Bind the confinement check to the same handle that supplies the bytes.
            resolved = path.resolve(strict=True)
            if not resolved.is_relative_to(root):
                raise ValueError('{} leads out of the analysis folder.'.format(relative))
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode):
                raise ValueError('{} is not a file.'.format(relative))
            if not os.path.samestat(opened, os.stat(resolved)):
                raise ValueError('{} changed while opening the file.'.format(relative))
            if opened.st_size > MAX_FILE:
                raise ValueError('{} exceeds the 64 MiB limit.'.format(relative))
            data = stream.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise ValueError('{} exceeds the 64 MiB limit.'.format(relative))
        return data
