"""Pure measured-table interpretation; mirror of web/src/core/tables.ts.

Rows in Layout and error metadata are 1-based, columns 0-based. Samples retain
their supplied units and precision. No formulas, interpolation or calibration.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
import re
from typing import Optional, Union

from ._text import JS_WS_CLASS, js_trim
from .delimited import delimited_rows

Cell = Union[float, str, None]


class Grid(list):
    """Dense Cell[][] with separate error metadata; JSON still sees an array."""
    def __init__(self, rows=(), errors=()):
        super().__init__(rows)
        width = max((len(row) for row in self), default=0)
        for row in self:
            row.extend([None] * (width - len(row)))
        self.errors = list(errors)


@dataclass(frozen=True)
class Layout:
    shape: str
    header_row: int
    units_row: Optional[int]
    data_row: int
    time_column: Optional[int]


@dataclass
class Channel:
    name: str
    unit: Optional[str]
    raw_unit: Optional[str]
    column: int
    t: list[float]
    values: list[float]
    missing: int


@dataclass
class Extraction:
    channels: list[Channel]
    warnings: list[str]


@dataclass(frozen=True)
class CalibrationHint:
    scale: float
    unit: str
    input_unit: str


@dataclass(frozen=True)
class TimeShiftHint:
    seconds: float
    row: int
    column: int


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _text(value):
    return js_trim(value) if isinstance(value, str) else ''


def numeric_cell(value):
    value = js_trim(value)
    if not re.fullmatch(r'[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?', value, re.I):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def read_delimited(text):
    def cell(value):
        if value == '':
            return None
        number = numeric_cell(value)
        return value if number is None else number
    return Grid([[cell(value) for value in row] for row in delimited_rows(text)])


def column_name(column):
    name = ''
    column += 1
    while column:
        column, rem = divmod(column - 1, 26)
        name = chr(65 + rem) + name
    return name


def _at(grid, row, column):
    return grid[row][column] if 0 <= row < len(grid) and 0 <= column < len(grid[row]) else None


def _pairs(row):
    result, c = [], 0
    while c + 1 < len(row):
        match = re.fullmatch(r'(.*)_Time\*?', _text(row[c]), re.I)
        if match and match[1] and match[1].lower() == _text(row[c + 1]).lower():
            result.append((c, c + 1))
            c += 1
        c += 1
    return result


_UNIT_TOKEN = re.compile(r'(?:s|sec|secs|second|seconds|min|mins|minutes|C|°C|ºC|K|kW|W|kW/m[2²]|W/m[2²]|MJ|V|Volt|Volts|mV|A|mA|%|%Vol|m/s|m|Pa|kPa|kg/s)', re.I | re.ASCII)
_BRACKETED = re.compile(r'\[[^\[\]]+\]')


def _unit_like(value):
    value = _text(value)
    return bool(_BRACKETED.fullmatch(value) or _UNIT_TOKEN.fullmatch(value))


def _unit(value):
    value = _text(value)
    token = js_trim(value[1:-1]) if _BRACKETED.fullmatch(value) else value
    return {'volt': 'V', 'volts': 'V', 'c': '°C', 'ºc': '°C', 'sec': 's'}.get(token.lower(), token or None)


def _is_units(row):
    cells = [v for v in row if v is not None and v != '']
    return bool(cells) and sum(_unit_like(v) for v in cells) > len(cells) / 2


def _note(value):
    return bool(re.fullmatch(r'\([\s\S]*\)', value)) or value.lower() == 'calculated'


def _fillers(row):
    counts = {}
    for value in map(_text, row):
        if value and not _unit_like(value):
            counts[value] = counts.get(value, 0) + 1
    return {value for value, count in counts.items() if count >= 3}


def _column_headers(grid, layout):
    """Shared by detection/extraction so both see the same names and units."""
    headers = [dict(name='', unit=None, raw_unit=None) for _ in range(max((len(row) for row in grid), default=0))]
    if layout.shape != 'processed':
        for c, header in enumerate(headers):
            raw = None if layout.units_row is None else _at(grid, layout.units_row - 1, c)
            header.update(name=_text(_at(grid, layout.header_row - 1, c)), unit=_unit(raw), raw_unit=raw if _text(raw) else None)
        return headers
    for row in grid[:layout.data_row - 1]:
        filler = _fillers(row)
        for c, raw in enumerate(row):
            value, header = _text(raw), headers[c]
            if not value or value in filler or _note(value):
                continue
            if _unit_like(value):
                if header['raw_unit'] is None:
                    header.update(raw_unit=raw, unit=_unit(value))
            elif not header['name']:
                header['name'] = value
    return headers


def channel_units(grid):
    """Find Channel/Unit tables; later nonempty entries win, raw unit text kept."""
    result, r = {}, 0
    while r < len(grid):
        header = [_text(v).lower() for v in grid[r]]
        if 'channel' not in header or 'unit' not in header:
            r += 1
            continue
        name_column, unit_column = header.index('channel'), header.index('unit')
        r += 1
        while r < len(grid) and any(is_number(v) or _text(v) for v in grid[r]):
            name, raw = _text(_at(grid, r, name_column)), _at(grid, r, unit_column)
            if name and _text(raw):
                result[name] = raw
            r += 1
        r += 1
    return result


def _seconds(header, units):
    return bool(re.search(r'(?:^|[^a-z])(?:s|sec|secs|second|seconds)(?:$|[^a-z])', f'{_text(header)} {_unit(units) or ""}', re.I))


def _time_column(grid, layout):
    headers = _column_headers(grid, layout)
    candidates = []
    for c, header in enumerate(headers):
        if 'time' not in header['name'].lower() and not _seconds(header['name'], header['unit']):
            continue
        first = None
        for r in range(layout.data_row - 1, len(grid)):
            value = _at(grid, r, c)
            if not is_number(value):
                continue
            if first is not None:
                if value > first:
                    candidates.append(c)
                break
            first = value
        else:
            if first is not None:
                candidates.append(c)
    return next((c for c in candidates if _seconds(headers[c]['name'], headers[c]['unit'])), candidates[0] if candidates else 0)


def detect_shape(grid):
    numeric = next((r for r, row in enumerate(grid) if len(row) >= 2 and is_number(row[0]) and is_number(row[1])), -1)
    for r in range(len(grid) if numeric < 0 else numeric):
        paired = _pairs(grid[r])
        if paired and len(paired) * 2 > sum(bool(_text(v)) for v in grid[r]) / 2:
            units = r + 2 if r + 1 < len(grid) and _is_units(grid[r + 1]) else None
            return Layout('paired-time', r + 1, units, (units or r + 1) + 1, None)
    if _text(_at(grid, 0, 0)).lower() == 's' and _text(_at(grid, 1, 0)).lower() == 'time':
        return Layout('fds', 2, 1, 3, 0)
    header, units, data, shape = 1, None, 2, 'plain'
    if numeric > 1:
        shape, data, best = 'processed', numeric + 1, -1
        for r in range(numeric):
            if _is_units(grid[r]):
                continue
            filler = _fillers(grid[r])
            score = len({_text(v) for v in grid[r] if _text(v) and _text(v) not in filler and not _unit_like(v) and not _note(_text(v))})
            if score > best:
                best, header = score, r + 1
        rows = [r + 1 for r in range(numeric) if r + 1 != header and _is_units(grid[r])]
        rows.sort(key=lambda r: (abs(r - header), -r))
        units = rows[0] if rows else None
        if numeric == 2 and header == 1 and units == 2:
            shape = 'plain'
    elif len(grid) > 1 and any(_text(v) for v in grid[1]) and all(v is None or isinstance(v, str) for v in grid[1]):
        units, data = 2, 3
    layout = Layout(shape, header, units, data, 0)
    return Layout(shape, header, units, data, _time_column(grid, layout))


_SHIFT_LABEL = re.compile(r'sh(i)?ft|ignition\s+at|offset'.replace(r'\s', '[' + JS_WS_CLASS + ']'), re.I | re.ASCII)


def time_shift_hint(grid):
    has_data = any(len(row) >= 2 and is_number(row[0]) and is_number(row[1]) for row in grid)
    end = detect_shape(grid).data_row - 1 if has_data else len(grid)
    candidates = []
    for r in range(end):
        for c, value in enumerate(grid[r]):
            if not _SHIFT_LABEL.search(_text(value)):
                continue
            for rr, cc in [(r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)]:
                if rr < 0 or rr >= end or cc < 0:
                    continue
                number = _at(grid, rr, cc)
                if is_number(number):
                    candidates.append(TimeShiftHint(number, rr + 1, cc))
    if len({c.seconds for c in candidates}) != 1:
        return None
    return min(candidates, key=lambda c: (c.row, c.column))


def extract_series(grid, layout, units_map=None):
    header, units, data = layout.header_row, layout.units_row, layout.data_row
    def integer(v, minimum):
        return is_number(v) and v == int(v) and v >= minimum
    if (not all(integer(v, 1) for v in (header, data)) or (units is not None and not integer(units, 1))
            or (layout.shape != 'paired-time' and not integer(layout.time_column, 0))):
        raise ValueError('Invalid table layout.')
    warnings = [f'Cell {column_name(e["column"])}{e["row"]}: {e["code"]} treated as missing.' for e in sorted(getattr(grid, 'errors', []), key=lambda e: (e['row'], e['column']))]
    names = grid[header - 1] if header <= len(grid) else []
    headers = _column_headers(grid, layout)
    selected = _pairs(names) if layout.shape == 'paired-time' else [(layout.time_column, c) for c in range(len(headers)) if c != layout.time_column and (headers[c]['name'] or any(_at(grid, r, c) is not None for r in range(data - 1, len(grid))))]
    ends = {}
    for time_column, _ in selected:
        if time_column in ends:
            continue
        previous, end = -math.inf, len(grid)
        for r in range(data - 1, len(grid)):
            t = _at(grid, r, time_column)
            if not is_number(t):
                continue
            if t <= previous:
                end = r
                warnings.append(f'Time column {column_name(time_column)} stops increasing at sheet row {r + 1}; series ended.')
                break
            previous = t
        ends[time_column] = end
    base_names = [headers[c]['name'] or f'Column {column_name(c)}' for _, c in selected]
    channel_headers, unit_groups = [], {}
    for (_, c), base in zip(selected, base_names):
        raw = headers[c]['raw_unit']
        if raw is None:
            raw = (units_map or {}).get(base)
        channel_headers.append(dict(unit=_unit(raw), raw_unit=raw if _text(raw) else None))
        unit_groups.setdefault(base, set()).add(_unit(raw))
    stems = [f'{base} [{h["unit"] or "unknown"}]' if len(unit_groups[base]) > 1 else base for base, h in zip(base_names, channel_headers)]
    reserved, original, used, channels = set(base_names + stems), set(base_names), set(), []
    for (time_column, c), base, stem, h in zip(selected, base_names, stems, channel_headers):
        name, suffix = stem, 2
        if name in used or (stem != base and stem in original):
            while True:
                name = f'{stem}#{suffix}'
                suffix += 1
                if name not in used and name not in reserved:
                    break
        if name != base:
            warnings.append(f'Duplicate channel name "{base}" renamed to "{name}".')
        used.add(name)
        channel = Channel(name, h['unit'], h['raw_unit'], c, [], [], 0)
        for r in range(data - 1, ends[time_column]):
            t, value = _at(grid, r, time_column), _at(grid, r, c)
            if not is_number(t) or not is_number(value):
                channel.missing += 1
                continue
            channel.t.append(t)
            channel.values.append(value)
        if channel.t:
            channels.append(channel)
        else:
            warnings.append(f'Channel "{name}" has no numeric samples and was dropped.')
    return Extraction(channels, warnings if channels else ['No time series on this sheet.'])


_CALIBRATION = re.compile(
    r'(?:^|[^a-z0-9.+-])([+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+))\s*kW\s*/\s*m[2²]\s*per\s*mV(?=$|[^a-z0-9])'.replace(r'\s', '[' + JS_WS_CLASS + ']'),
    re.I | re.ASCII,
)


def calibration_hint(name, unit):
    """Unknown units assume V; known non-voltage units refuse calibration."""
    source = (_unit(unit) or 'V').lower()
    if source not in ('v', 'mv'):
        return None
    match = _CALIBRATION.search(name)
    if match:
        scale = float(match[1]) * (1 if source == 'mv' else 1000)
        if math.isfinite(scale) and scale > 0:
            return CalibrationHint(scale, 'kW/m2', 'mV' if source == 'mv' else 'V')
    return None
