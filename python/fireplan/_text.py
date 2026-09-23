"""Text rules the web engine gets from JavaScript, spelled out for Python.

The two engines must read the same bytes the same way, and the places they are
most likely not to are the ones each language decides for itself: what counts as
whitespace, what a digit is, and how an integer is read from the front of a string.
Python's `str.strip()` and regex `\\s` include U+001C-U+001F and U+0085 but not
U+FEFF; JavaScript's `trim()` and `\\s` are the reverse. Python's `\\d` and `\\w`
accept every script's digits and letters; JavaScript's are ASCII. Each divergence
was a way for a CSV cell or an FDS record to mean one thing in the editor and
another in `fireplan` (review 2026-09-22, FDSI-8, FDSI-16, SHL-9).
"""

from __future__ import annotations

import re
from typing import Optional

#: ECMAScript WhiteSpace + LineTerminator: exactly what `String.prototype.trim` and
#: a regex `\s` match.
JS_WHITESPACE = (
    "\t\n\x0b\x0c\r \xa0 "
    "           "
    "    　﻿"
)

#: The same set for use inside a regex character class.
JS_WS_CLASS = r"\t\n\x0b\x0c\r \xa0  -     　﻿"

_LEADING_INT = re.compile(r"[+-]?[0-9]+")


def js_trim(text: str) -> str:
    """`String.prototype.trim`."""
    return text.strip(JS_WHITESPACE)


def js_to_fixed(value: float, digits: int) -> str:
    """`Number.prototype.toFixed`: the exact binary value, ties away from zero.
    Python's `format(v, '.1f')` breaks exact ties to even, so 0.25 is '0.2' here
    and '0.3' there."""
    from decimal import ROUND_HALF_UP, Decimal, localcontext
    with localcontext() as ctx:
        ctx.prec = 80
        return str(Decimal(value).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def js_parse_int(text: str) -> Optional[int]:
    """`Number.parseInt(text, 10)`, with NaN as None: optional whitespace, a sign,
    then as many ASCII digits as there are -- `'1_0'` is 1, not 10."""
    match = _LEADING_INT.match(text.lstrip(JS_WHITESPACE))
    return int(match.group()) if match else None
