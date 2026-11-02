"""Instrument mappings and calibrated series, mirrored by core/test-data.ts."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import math

import numpy as np

from . import tables, xlsx
from .linked_files import local_path

TARGET_UNITS = {'heatFluxSensor': 'kW/m2', 'thermocouple': '°C', 'burner': 'kW'}


@dataclass
class TestDataSource:
    """A view of a stored source. Edit raw to retain all forward-compatible keys."""
    raw: dict

    @property
    def id(self):
        return self.raw['id']

    @property
    def name(self):
        return self.raw['name']

    @property
    def role(self):
        return self.raw['role']

    @property
    def file(self):
        return self.raw['file']

    @property
    def table(self):
        return self.raw['table']

    @property
    def channels(self):
        return self.raw['channels']

    @property
    def time_offset_s(self):
        return self.raw.get('timeOffset_s', 0)

    @property
    def manifest(self):
        return self.raw['manifest']


@dataclass
class Series:
    source_id: str
    source: str
    role: str
    object_id: str
    bead: int | None
    unit: str
    t: np.ndarray
    values: np.ndarray
    missing: int


def layout(table):
    return tables.Layout(table['shape'], table['headerRow'], table['unitsRow'],
                         table['dataRow'], table['timeColumn'])


def read_source(source, path):
    """Read only on explicit series access. The stored sheet/layout is authoritative."""
    try:
        raw = Path(path).read_bytes()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f'Test data file is missing: {path}') from exc
    suffix = Path(path).suffix.lower()
    table = source.table
    if suffix in ('.xlsx', '.xlsm'):
        if table['sheet'] is None:
            raise ValueError(f'Test data workbook requires a sheet: {path}')
        grid, units = xlsx.read_sheet(raw, table['sheet']), {}
        if 'unitsSheet' in table:
            units = (xlsx.workbook_channel_units(raw) if table['unitsSheet'] is None
                     else tables.channel_units(xlsx.read_sheet(raw, table['unitsSheet'])))
        return grid, units
    if suffix not in ('.csv', '.tsv', '.txt'):
        raise ValueError(f'Unsupported test data file {path}; save as .xlsx or .csv.')
    if table['sheet'] is not None or 'unitsSheet' in table:
        raise ValueError(f'Delimited test data requires sheet: null and no unitsSheet: {path}')
    return tables.read_delimited(raw.decode('utf-8-sig')), {}


def source_series(source, grid, targets, units=None):
    """Return series keyed by (object ID, bead or None), without changing the input."""
    if isinstance(source, dict):
        source = TestDataSource(source)
    channels = {c.name: c for c in tables.extract_series(grid, layout(source.table), units).channels}
    result = {}
    for mapping in source.channels:
        channel = channels.get(mapping['channel'])
        if channel is None:
            raise ValueError(f'Source "{source.name}": mapped channel "{mapping["channel"]}" is missing.')
        key = (mapping['object'], mapping.get('bead'))
        if key in result:
            raise ValueError(f'Source "{source.name}" maps target {key} more than once.')
        unit = targets.get(mapping['object'], '°C' if 'bead' in mapping else None)
        if unit is None:
            raise ValueError(f'Target unit for object "{mapping["object"]}" is required.')
        scale, offset, shift = mapping.get('scale', 1), mapping.get('offset', 0), source.time_offset_s
        if not all(tables.is_number(x) for x in (scale, offset, shift)) or scale == 0:
            raise ValueError('Invalid test data calibration or time offset.')
        with np.errstate(over='ignore', invalid='ignore'):
            t = np.asarray(channel.t, dtype=np.float64) - shift
            values = np.asarray(channel.values, dtype=np.float64) * scale + offset
        if not np.isfinite(t).all() or not np.isfinite(values).all():
            raise ValueError('Test data calibration or time offset overflowed.')
        result[key] = Series(source.id, source.name, source.role, key[0], key[1], unit,
                             t, values, channel.missing)
    return result


def manifest_for(source, grid, file_info):
    if isinstance(source, dict):
        source = TestDataSource(source)
    channels = {c.name: c for c in tables.extract_series(grid, layout(source.table), file_info.get('units')).channels}
    mapped = []
    for name in dict.fromkeys(c['channel'] for c in source.channels):
        c = channels.get(name)
        if c is None:
            raise ValueError(f'Source "{source.name}": mapped channel "{name}" is missing.')
        mapped.append(dict(name=name, unit=c.unit, samples=len(c.t),
                           t0=c.t[0] if c.t else None, t1=c.t[-1] if c.t else None))
    return dict(size=file_info['size'], modified=file_info['modified'], rows=len(grid), channels=mapped)


def manifest_mismatch(manifest, file_info, grid):
    changes = []
    if manifest['size'] != file_info['size']:
        changes.append('File size changed.')
    if manifest['modified'] != file_info['modified']:
        changes.append('File modification time changed.')
    chosen = layout(file_info['table']) if 'table' in file_info else tables.detect_shape(grid)
    channels = {c.name: c for c in tables.extract_series(grid, chosen, file_info.get('units')).channels}
    for old in manifest['channels']:
        c = channels.get(old['name'])
        if c is None:
            changes.append(f'Mapped channel "{old["name"]}" is missing.')
        elif c.unit != old['unit']:
            changes.append(f'Unit of mapped channel "{old["name"]}" changed.')
    return changes


def problems(data):
    """Supplement schema validation with finite numbers, IDs, paths and spans."""
    def finite(value):
        if isinstance(value, dict):
            return all(finite(v) for v in value.values())
        if isinstance(value, list):
            return all(finite(v) for v in value)
        return not isinstance(value, (int, float)) or math.isfinite(value)

    seen = set()
    for source in data.get('testData', []):
        if source['id'] in seen:
            yield 'Test data source IDs must be non-empty and unique.'
        seen.add(source['id'])
        if not finite(source):
            yield 'Test data numbers must be finite.'
        if not local_path(source['file']['path']):
            yield 'Test data needs a local file path, not a URL.'
        names = set()
        for c in source['manifest']['channels']:
            if c['name'] in names:
                yield 'Invalid test data manifest channel.'
            names.add(c['name'])
            if c['samples'] == 0:
                valid = c['t0'] is None and c['t1'] is None
            else:
                valid = tables.is_number(c['t0']) and tables.is_number(c['t1'])
                valid = valid and (c['t0'] == c['t1'] if c['samples'] == 1 else c['t0'] < c['t1'])
            if not valid:
                yield 'Invalid test data manifest channel.'
        if names != {c['channel'] for c in source['channels']}:
            yield 'Test data manifest must describe exactly the mapped channels.'


def checks(data):
    from .plan import Issue
    objects = {o['id']: o for o in data.get('objects', [])}
    issues = []
    for source in data.get('testData', []):
        seen = set()
        for c in source['channels']:
            obj = objects.get(c['object'], {})
            key = (c['object'], c.get('bead'))
            if obj.get('type') == 'thermocouple':
                bead = c.get('bead')
                valid = (tables.is_number(bead) and bead == int(bead)
                         and 0 <= bead < len(obj.get('beadOffsets_m') or [0]))
            else:
                valid = obj.get('type') in ('heatFluxSensor', 'burner') and 'bead' not in c
            if not valid:
                issues.append(Issue('warning', 'test-data-dangling',
                    f'Source "{source["name"]}": channel "{c["channel"]}" targets a missing or incompatible object or bead.', c['object']))
            if key in seen:
                bead = c.get('bead', 'none')
                issues.append(Issue('warning', 'test-data-duplicate',
                    f'Source "{source["name"]}" maps object "{c["object"]}" and bead {bead} more than once.', c['object']))
            seen.add(key)
    return issues
