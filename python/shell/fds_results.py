"""Read-only bounded ranges from a result folder explicitly selected by the user."""
from __future__ import annotations

import os
from pathlib import Path
import secrets
from typing import Any, Dict

MAX_READ = 64 * 1024 * 1024
EXTENSIONS = {'.smv', '.sf', '.bf', '.s3d', '.sz', '.csv', '.bnd'}


class ResultFiles:
    def __init__(self) -> None:
        self.sessions: Dict[str, Any] = {}

    def open(self, smv_path: str) -> Dict[str, Any]:
        smv = Path(smv_path).resolve(strict=True)
        if smv.suffix.lower() != '.smv' or not smv.is_file():
            raise ValueError('Choose a Smokeview metadata (.smv) file.')
        root = smv.parent
        files = {}
        for directory, dirs, names in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if not Path(directory, d).is_symlink()
                       and Path(directory, d).resolve().is_relative_to(root)]
            for name in names:
                p = Path(directory, name)
                if p.suffix.lower() not in EXTENSIONS or p.is_symlink():
                    continue
                resolved = p.resolve(strict=True)
                if not resolved.is_relative_to(root):
                    continue
                stat = p.stat()
                files[p.relative_to(root).as_posix()] = (p, stat.st_size, stat.st_mtime_ns)
                if len(files) > 20000:
                    raise ValueError('Result folder exceeds 20000 files.')
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
        if token not in self.sessions:
            raise ValueError('Unknown or closed results session.')
        root, files = self.sessions[token]
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
