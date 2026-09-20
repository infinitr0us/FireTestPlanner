"""Local attachment paths and constraints beyond JSON Schema."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import math
import ntpath
import os
import posixpath
import re

LINK_TYPES = {'burner', 'camera', 'heatFluxSensor', 'thermocouple', 'reconstructedFlame'}
MAX_CSV_BYTES = 5 * 1024 * 1024
MAX_PLOT_SAMPLES = 20_000
#: Also the cap on a voxel sequence's frames: the manifest is one row per frame.
MAX_SEQUENCE_FRAMES = 20_000


def link_kind_for(object_type):
    """The one kind of file each linking type accepts. A flame links a folder of frames."""
    if object_type == 'camera':
        return 'video'
    if object_type == 'reconstructedFlame':
        return 'voxelSequence'
    return 'spreadsheet'


def sequence_problem(sequence):
    """What is wrong with a voxel sequence manifest beyond its schema shape, or None.

    Mirror of `voxelSequenceProblem` in web/src/core/linked-files.ts: strictly
    increasing times, a box whose minimum is its minimum, a pitch no smaller than
    the voxel size (the grid is endpoint-inclusive, so it cannot be).
    """
    grid = sequence.get('grid', {})
    if not all(math.isfinite(grid.get(k, math.nan)) and grid[k] > 0 for k in ('voxelSize_m', 'pitch_m')) or grid['pitch_m'] < grid['voxelSize_m']:
        return 'a voxel sequence needs a positive voxel size and a pitch no smaller than it'
    lo, hi = sequence.get('bounds_m', ([], []))
    if len(lo) != 3 or len(hi) != 3 or not all(math.isfinite(x) for x in (*lo, *hi)) or any(a > b for a, b in zip(lo, hi)):
        return 'a voxel sequence needs finite bounds with the minimum corner first'
    frames = sequence.get('frames', [])
    if not 1 <= len(frames) <= MAX_SEQUENCE_FRAMES:
        return 'a voxel sequence needs 1-20,000 frames'
    previous = -math.inf
    for frame in frames:
        if not math.isfinite(frame[0]) or frame[0] <= previous or frame[1] < 0:
            return 'voxel sequence frames need strictly increasing finite times and non-negative voxel counts'
        previous = frame[0]
    return None


def _csv_rows(text, separator):
    """Mirror the web reader, including strict quoting and blank-row handling."""
    result, row, cell = [], [], ''
    quoted = closed = False

    def push_cell():
        nonlocal cell, closed
        row.append(cell.strip())
        cell, closed = '', False

    def push_row():
        nonlocal row
        push_cell()
        if any(row):
            result.append(row)
        row = []
        if len(result) > MAX_PLOT_SAMPLES + 1:
            raise ValueError('CSV exceeds 20,000 samples.')

    i = 0
    while i < len(text):
        ch = text[i]
        if quoted:
            if ch == '"':
                if text[i + 1:i + 2] == '"':
                    cell += '"'
                    i += 1
                else:
                    quoted, closed = False, True
            else:
                cell += ch
        elif ch == separator:
            push_cell()
        elif ch in '\r\n':
            if ch == '\r' and text[i + 1:i + 2] == '\n':
                i += 1
            push_row()
        elif ch == '"' and not cell.strip() and not closed:
            cell, quoted = '', True
        elif ch == '"' or (closed and ch.strip()):
            raise ValueError('Malformed CSV quoting.')
        else:
            cell += ch
        i += 1
    if quoted:
        raise ValueError('CSV has an unclosed quoted field.')
    if cell or row or closed:
        push_row()
    return result


def parse_reconstruction_csv(text, imported_at=None):
    """Import a UTF-8 CSV string as a snapshot, with the same rules as the editor.

    Refuses the entire import on bad data; callers may keep their previous plot.
    """
    if len(text.encode('utf-8')) > MAX_CSV_BYTES:
        raise ValueError('CSV exceeds the 5 MiB plot limit.')
    text = text.removeprefix('\ufeff')
    header_line = next((line for line in re.split(r'\r?\n', text) if line.strip()), '')
    separator = '\t' if '\t' in header_line else ';' if ';' in header_line and ',' not in header_line else ','
    table = _csv_rows(text, separator)
    headers = [cell.lower() for cell in table.pop(0)] if table else []
    required = ['timestamp_s', 'volume_m3', 'surface_area_m2']
    indices = []
    for name in required:
        if headers.count(name) != 1:
            raise ValueError('CSV needs exactly one "{}" column.'.format(name))
        indices.append(headers.index(name))
    if not table:
        raise ValueError('CSV contains no measurements.')
    samples, previous = [], -math.inf
    for row_number, row in enumerate(table, 2):
        if len(row) != len(headers):
            raise ValueError('CSV row {} has {} fields; expected {}.'.format(row_number, len(row), len(headers)))
        values = []
        for i, column in enumerate(indices):
            cell = row[column]
            if not re.fullmatch(r'[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?', cell, re.I):
                raise ValueError('CSV row {}: {} is not a number.'.format(row_number, required[i]))
            value = float(cell)
            if not math.isfinite(value) or (i > 0 and value < 0):
                raise ValueError('CSV row {}: {} must be finite{}.'.format(row_number, required[i], ' and non-negative' if i > 0 else ''))
            values.append(value)
        if values[0] <= previous:
            raise ValueError('CSV row {}: timestamps must increase strictly.'.format(row_number))
        samples.append(values)
        previous = values[0]
    if imported_at is None:
        imported_at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return {'importedAt': imported_at, 'samples': samples}


def local_path(path):
    return (isinstance(path, str) and bool(path.strip())
            and not re.search(r'[\x00-\x1f]', path)
            and not re.match(r'^[a-z][a-z0-9+.-]*:', re.sub(r'^[a-z]:[/\\]', '', path, flags=re.I), re.I))


def _path_module(*paths):
    if any(ntpath.splitdrive(str(path))[0] for path in paths if path):
        return ntpath
    if any(str(path).startswith('/') for path in paths if path):
        return posixpath
    return os.path  # relative Python inputs use the host's current directory


def resolve_path(path, plan_path=None):
    if not local_path(path):
        raise ValueError('Linked files need local paths, not URLs.')
    path_module = _path_module(path, plan_path)
    if path_module.isabs(path):
        return path_module.normpath(path)
    if not plan_path:
        raise ValueError('A relative link needs a plan loaded from or saved to a file.')
    return path_module.normpath(path_module.join(path_module.dirname(path_module.abspath(str(plan_path))), path))


def for_destination(data, source_path, destination):
    """Rebase a COPY for Save As. No source or attachment bytes are touched."""
    result = deepcopy(data)
    for obj in result.get('objects', []):
        if obj.get('type') not in LINK_TYPES:
            continue
        for link in obj.get('linkedFiles', []):
            absolute = resolve_path(link['path'], source_path or destination)
            module = _path_module(absolute, destination)
            try:
                link['path'] = module.relpath(absolute, module.dirname(module.abspath(str(destination)))).replace('\\', '/')
            except ValueError:  # different Windows drives
                link['path'] = absolute.replace('\\', '/')
    return result


def problems(data):
    """Assumes schema-valid shapes. Strict time order and unique IDs need code."""
    for obj in data.get('objects', []):
        if obj.get('type') not in LINK_TYPES:
            continue
        seen = set()
        for link in obj.get('linkedFiles', []):
            if link['id'] in seen:
                yield '{}: linked file IDs must be unique within their object'.format(obj['id'])
            seen.add(link['id'])
            if not local_path(link['path']):
                yield '{}: linked files need a local path, not a URL'.format(obj['id'])
            if link.get('kind') != link_kind_for(obj.get('type')):
                yield '{}: cameras link videos; burners and sensors link spreadsheets; a reconstructed flame links a voxel sequence'.format(obj['id'])
            if 'timeOffset_s' in link and not (isinstance(link['timeOffset_s'], (int, float)) and not isinstance(link['timeOffset_s'], bool) and math.isfinite(link['timeOffset_s'])):
                yield '{}: a linked file time offset must be a finite number of seconds'.format(obj['id'])
            if 'sequence' in link:
                problem = sequence_problem(link['sequence'])
                if problem:
                    yield '{}: {}'.format(obj['id'], problem)
            previous = -math.inf
            for sample in link.get('plot', {}).get('samples', []):
                if not all(math.isfinite(x) and (i == 0 or x >= 0) for i, x in enumerate(sample)) or sample[0] <= previous:
                    yield '{}: plot samples need finite, non-negative volume and area and strictly increasing finite timestamps'.format(obj['id'])
                    break
                previous = sample[0]
