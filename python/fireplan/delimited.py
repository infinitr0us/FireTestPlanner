"""Strict quoting and delimiter detection shared by both table consumers."""
from ._text import js_trim


def detect_delimiter(text):
    counts = {'\t': 0, ';': 0, ',': 0}
    quoted = nonempty = False
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '"':
            if quoted and text[i + 1:i + 2] == '"':
                i += 1
            else:
                quoted = not quoted
        elif not quoted:
            if ch in '\r\n':
                if nonempty:
                    break
            elif ch in counts:
                counts[ch] += 1
        if js_trim(ch):
            nonempty = True
        i += 1
    separator, best = ',', 0
    for candidate, count in counts.items():
        if count > best:
            separator, best = candidate, count
    return separator


def delimited_rows(text, separator=None, skip_blank=False, max_rows=None):
    text = text.removeprefix('\ufeff')
    separator = detect_delimiter(text) if separator is None else separator
    result, row, cell = [], [], []
    quoted = closed = False

    def push_cell():
        nonlocal cell, closed
        row.append(js_trim(''.join(cell)))
        cell, closed = [], False

    def push_row():
        nonlocal row
        push_cell()
        if not skip_blank or any(row):
            result.append(row)
        row = []
        if max_rows is not None and len(result) > max_rows:
            raise ValueError(f'CSV exceeds {max_rows - 1:,} samples.')

    i = 0
    while i < len(text):
        ch = text[i]
        if quoted:
            if ch == '"':
                if text[i + 1:i + 2] == '"':
                    cell.append('"')
                    i += 1
                else:
                    quoted, closed = False, True
            else:
                cell.append(ch)
        elif ch == separator:
            push_cell()
        elif ch in '\r\n':
            if ch == '\r' and text[i + 1:i + 2] == '\n':
                i += 1
            push_row()
        elif ch == '"' and not js_trim(''.join(cell)) and not closed:
            cell, quoted = [], True
        elif ch == '"' or (closed and js_trim(ch)):
            raise ValueError('Malformed CSV quoting.')
        else:
            cell.append(ch)
        i += 1
    if quoted:
        raise ValueError('CSV has an unclosed quoted field.')
    if cell or row or closed:
        push_row()
    return result
