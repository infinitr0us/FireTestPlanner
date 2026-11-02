"""Cached OOXML cells using zipfile and streaming ElementTree only.

Only the requested worksheet and workbook/shared-string metadata are opened.
Clearing and detaching parsed cells/rows avoids retaining the XML tree.
"""
from __future__ import annotations

from contextlib import contextmanager
import io
import re
from urllib.parse import unquote
import xml.etree.ElementTree as ET
import zipfile

from .tables import Grid, channel_units, numeric_cell

MAX_CELLS = 10_000_000


def _local(tag):
    return tag.rsplit('}', 1)[-1]


@contextmanager
def _archive(raw):
    if raw[:4] == bytes.fromhex('d0cf11e0'):
        raise ValueError('.xls is not supported; save as .xlsx or .csv.')
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if 'mimetype' in archive.namelist() and archive.read('mimetype').decode('utf-8').strip() == 'application/vnd.oasis.opendocument.spreadsheet':
            raise ValueError('.ods is not supported; save as .xlsx or .csv.')
        yield archive


@contextmanager
def _part(archive, name):
    if name not in archive.namelist():
        raise ValueError(f'Workbook is missing {name}.')
    with archive.open(name) as stream:
        yield stream


def _sheets(archive):
    result = []
    with _part(archive, 'xl/workbook.xml') as stream:
        for _, element in ET.iterparse(stream, events=('end',)):
            if _local(element.tag) == 'sheet':
                result.append((element.get('name'), next((v for k, v in element.attrib.items() if _local(k) == 'id'), '')))
            element.clear()
    return result


def list_sheets(raw):
    with _archive(raw) as archive:
        return [name for name, _ in _sheets(archive)]


def _target_part(target):
    target = unquote(target)
    if re.search(r'[\\?#]', target) or re.match(r'[a-z][a-z0-9+.-]*:', target, re.I) or target.startswith('//'):
        raise ValueError('External worksheet relationships are not supported.')
    parts = []
    for segment in (target if target.startswith('/') else 'xl/' + target).split('/'):
        if not segment or segment == '.':
            continue
        if segment == '..':
            if not parts:
                raise ValueError('Invalid worksheet part path.')
            parts.pop()
        else:
            parts.append(segment)
    return '/'.join(parts)


def _rich_text(element):
    if _local(element.tag) == 'rPh':
        return ''
    if _local(element.tag) == 't':
        return element.text or ''
    return ''.join(_rich_text(child) for child in element)


def _shared_strings(archive):
    if 'xl/sharedStrings.xml' not in archive.namelist():
        return []
    result, stack = [], []
    with _part(archive, 'xl/sharedStrings.xml') as stream:
        for event, element in ET.iterparse(stream, events=('start', 'end')):
            if event == 'start':
                stack.append(element)
            else:
                if _local(element.tag) == 'si':
                    result.append(_rich_text(element))
                    element.clear()
                    if len(stack) > 1:
                        stack[-2].remove(element)
                stack.pop()
    return result


def _sheet_grid(stream, shared):
    rows, errors, stack = [], [], []
    row, column, width = 0, -1, 0
    in_data = False

    def extend(r, c):
        nonlocal width
        width = max(width, c + 1)
        if r < 1 or r > 1_048_576 or c < 0 or c >= 16_384 or max(r, len(rows)) * width > MAX_CELLS:
            raise ValueError('Worksheet exceeds the 10,000,000-cell dense grid limit or has invalid coordinates.')
        while len(rows) < r:
            rows.append([])
        rows[r - 1].extend([None] * (c + 1 - len(rows[r - 1])))

    for event, element in ET.iterparse(stream, events=('start', 'end')):
        tag = _local(element.tag)
        if event == 'start':
            stack.append(element)
            if tag == 'sheetData':
                in_data = True
            if tag == 'row' and in_data:
                row = int(element.get('r', row + 1))
                column = -1
                extend(row, 0)
            continue
        if tag == 'c' and in_data:
            ref = element.get('r')
            if ref:
                match = re.fullmatch(r'([A-Za-z]+)([1-9][0-9]*)', ref)
                if not match:
                    raise ValueError('Invalid worksheet cell reference.')
                column = 0
                for ch in match[1].upper():
                    column = column * 26 + ord(ch) - 64
                column -= 1
                row = int(match[2])
            else:
                column += 1
            extend(row, column)
            kind = element.get('t', '')
            value = next((child.text or '' for child in element if _local(child.tag) == 'v'), '')
            cell = None
            if kind == 'e':
                errors.append(dict(row=row, column=column, code=value.strip() or '#ERROR!'))
            elif kind == 'inlineStr':
                cell = _rich_text(element) or None
            elif kind in ('str', 'd'):
                cell = value or None
            elif kind == 's':
                index = numeric_cell(value)
                if index is None or not index.is_integer() or not 0 <= index < len(shared):
                    raise ValueError('Invalid shared string index.')
                cell = shared[int(index)] or None
            elif kind == 'b':
                cell = 1 if value.strip() == '1' else 0 if value.strip() == '0' else None
            else:
                cell = numeric_cell(value)
            rows[row - 1][column] = cell
        # Keep children of cells until the cell closes, then detach it. Other
        # nodes (including empty formatted rows) need not accumulate either.
        if tag in ('c', 'row') or not in_data:
            element.clear()
            if len(stack) > 1:
                stack[-2].remove(element)
        if tag == 'sheetData':
            in_data = False
            element.clear()
        stack.pop()
    errors.sort(key=lambda e: (e['row'], e['column']))
    return Grid(rows, errors)


def _relationships(archive):
    result = {}
    with _part(archive, 'xl/_rels/workbook.xml.rels') as stream:
        for _, element in ET.iterparse(stream, events=('end',)):
            if _local(element.tag) == 'Relationship':
                result[element.get('Id')] = dict(element.attrib)
            element.clear()
    return result


def _read_part(archive, sheet, relationships, shared):
    rel = relationships.get(sheet[1], {})
    if not rel.get('Target'):
        raise ValueError(f'Sheet "{sheet[0]}" has no worksheet relationship.')
    if rel.get('TargetMode') == 'External':
        raise ValueError('External worksheet relationships are not supported.')
    with _part(archive, _target_part(rel['Target'])) as stream:
        return _sheet_grid(stream, shared)


def read_sheet(raw, sheet_name):
    with _archive(raw) as archive:
        sheet = next((s for s in _sheets(archive) if s[0] == sheet_name), None)
        if sheet is None:
            raise ValueError(f'Sheet "{sheet_name}" was not found.')
        relationships = _relationships(archive)
        shared = _shared_strings(archive)
        return _read_part(archive, sheet, relationships, shared)


def workbook_channel_units(raw):
    """Merge metadata tables in sheet order without retaining every sheet grid."""
    with _archive(raw) as archive:
        sheets, relationships, shared = _sheets(archive), _relationships(archive), _shared_strings(archive)
        result = {}
        for sheet in sheets:
            result.update(channel_units(_read_part(archive, sheet, relationships, shared)))
        return result
