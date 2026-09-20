"""Explicit local-file operations for test data. Never run a shell command string."""
from __future__ import annotations

import os
import logging
import re
import subprocess
import sys

SPREADSHEETS = {'.csv', '.tsv', '.xlsx', '.xls', '.ods'}
VIDEOS = {'.mp4', '.m4v', '.mov', '.avi', '.mkv', '.wmv', '.webm', '.mpg', '.mpeg', '.mts', '.m2ts'}
MAX_CSV_BYTES = 5 * 1024 * 1024
#: One reconstructed frame; the fixture's largest is 100 KB, a 200-cubed run's is 50 MB.
MAX_FRAME_BYTES = 512 * 1024 * 1024
#: The pipeline's frame files, and nothing else a folder may hold.
FRAME_NAME = re.compile(r'^t_(\d+(?:\.\d+)?)s\.npz$')


def checked_path(path, kind):
    if kind not in ('spreadsheet', 'video', 'voxelSequence'):
        raise ValueError('Unknown linked file kind.')
    if not isinstance(path, str) or not path.strip() or re.search(r'[\x00-\x1f]', path):
        raise ValueError('Choose a local file first.')
    if not os.path.isabs(path) or re.match(r'^[a-z][a-z0-9+.-]*:', re.sub(r'^[a-z]:[/\\]', '', path, flags=re.I), re.I):
        raise ValueError('Choose a local file; URLs and relative paths cannot be opened here.')
    try:
        resolved = os.path.realpath(path)
    except OSError as exc:
        logging.getLogger(__name__).debug('Could not resolve linked file %r', path, exc_info=True)
        raise FileNotFoundError('Linked file is missing or unavailable. Use Relink to choose its new location: ' + path) from exc
    if kind == 'voxelSequence':
        # A voxel sequence is a folder of frames, not a file.
        if not os.path.isdir(resolved):
            raise FileNotFoundError('The voxel folder is missing. Use Relink to choose its new location: ' + path)
        return os.path.normpath(os.path.abspath(path))
    allowed = VIDEOS if kind == 'video' else SPREADSHEETS
    if os.path.splitext(path)[1].lower() not in allowed or os.path.splitext(resolved)[1].lower() not in allowed:
        raise ValueError('Unsupported file type. Relink a spreadsheet or video file.')
    if not os.path.isfile(resolved):
        raise FileNotFoundError('Linked file is missing. Use Relink to choose its new location: ' + path)
    # Validate the resolved target but preserve the alias the user selected.
    return os.path.normpath(os.path.abspath(path))


def list_frames(folder):
    """The frame files a voxel folder holds, in name order. The folder is checked
    the way a linked file is; anything not named like a frame is not listed."""
    folder = checked_path(folder, 'voxelSequence')
    return sorted(name for name in os.listdir(folder) if FRAME_NAME.match(name))


def read_frame(folder, name):
    """One frame's bytes from a checked folder. The name must be a frame's own --
    no path separators, nothing the pipeline would not have written -- so this
    can serve nothing outside the folder it was asked about."""
    folder = checked_path(folder, 'voxelSequence')
    if not isinstance(name, str) or not FRAME_NAME.match(name):
        raise ValueError('Not a reconstruction frame file: ' + repr(name))
    path = os.path.join(folder, name)
    if not os.path.isfile(path):
        raise FileNotFoundError('Frame is missing: ' + name)
    if os.path.getsize(path) > MAX_FRAME_BYTES:
        raise ValueError('Frame exceeds the {} MB limit: {}'.format(MAX_FRAME_BYTES // (1024 * 1024), name))
    with open(path, 'rb') as fh:
        return fh.read()


def read_csv(path):
    path = checked_path(path, 'spreadsheet')
    if os.path.splitext(path)[1].lower() not in {'.csv', '.tsv'}:
        raise ValueError('Plotting needs CSV or TSV with timestamp_s, volume_m3 and surface_area_m2 columns. Export this workbook as CSV first.')
    with open(path, 'rb') as fh:
        data = fh.read(MAX_CSV_BYTES + 1)
    if len(data) > MAX_CSV_BYTES:
        raise ValueError('CSV exceeds the 5 MiB plot limit.')
    try:
        return data.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise ValueError('CSV must be UTF-8 encoded. Export it as UTF-8 CSV first.') from exc


def launch(path, folder=False):
    """OS association / folder reveal. Call only after checking the target."""
    if sys.platform == 'win32':
        if folder:
            subprocess.Popen(['explorer.exe', '/select,', os.path.normpath(path)])
        else:
            os.startfile(path)
    elif sys.platform == 'darwin':
        subprocess.Popen(['open', '-R', path] if folder else ['open', path])
    else:
        subprocess.Popen(['xdg-open', os.path.dirname(path) if folder else path])
