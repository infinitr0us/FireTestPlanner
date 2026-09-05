"""Explicit local-file operations for test data. Never run a shell command string."""
from __future__ import annotations

import os
import re
import subprocess
import sys

SPREADSHEETS = {'.csv', '.tsv', '.xlsx', '.xls', '.ods'}
VIDEOS = {'.mp4', '.m4v', '.mov', '.avi', '.mkv', '.wmv', '.webm', '.mpg', '.mpeg', '.mts', '.m2ts'}
MAX_CSV_BYTES = 5 * 1024 * 1024


def checked_path(path, kind):
    if kind not in ('spreadsheet', 'video'):
        raise ValueError('Unknown linked file kind.')
    if not isinstance(path, str) or not path.strip() or re.search(r'[\x00-\x1f]', path):
        raise ValueError('Choose a local file first.')
    if not os.path.isabs(path) or re.match(r'^[a-z][a-z0-9+.-]*:', re.sub(r'^[a-z]:[/\\]', '', path, flags=re.I), re.I):
        raise ValueError('Choose a local file; URLs and relative paths cannot be opened here.')
    allowed = VIDEOS if kind == 'video' else SPREADSHEETS
    resolved = os.path.realpath(path)
    if os.path.splitext(path)[1].lower() not in allowed or os.path.splitext(resolved)[1].lower() not in allowed:
        raise ValueError('Unsupported file type. Relink a spreadsheet or video file.')
    if not os.path.isfile(resolved):
        raise FileNotFoundError('Linked file is missing. Use Relink to choose its new location: ' + path)
    return resolved


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
