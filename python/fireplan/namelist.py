"""Fortran namelist reader, as FDS writes them. Mirror of web/src/core/namelist.ts.

FDS input is a sequence of namelist records: ``&GROUP key=value, ... /``. Anything
outside a record is a comment, which is how FDS files carry prose -- and it is also
how a line gets disabled, by deleting its leading ``&``. That last point is not a
curiosity: the sample file in ``fixtures/fds/`` has a ``REAC`` line carrying
``RADIATIVE_FRACTION=0.29`` that FDS never reads, and a reader that picks it up is
quietly wrong about the fire.

Three rules here are the ones a quick regex gets wrong, and all three are exercised
by that same sample file:

* **A record ends at the first ``/`` that is not inside a string.** The sample's
  ``&HEAD`` title contains ``34.2x1000/300=114s``, so a reader that stops at the
  first ``/`` truncates the very first record in the file.
* **Parameters separate on commas *or* whitespace.** The sample's ``&SURF``,
  ``&MATL`` and ``&PROP`` records use newlines and no commas at all, so a
  comma-splitter silently loses ``HRRPUA`` and a thermocouple's ``DIAMETER``.
* **Subscripted assignments accumulate.** ``MATL_ID(1,1)='X'`` followed by
  ``MATL_ID(2,1)='Y'`` is two writes into one array, not two values of which the
  last wins.

This module is deliberately ignorant of what any of it means: it turns text into
records, and :mod:`fireplan.fds` decides what a record is for.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Sequence

__all__ = ["Record", "read", "read_one", "NamelistError"]


class NamelistError(ValueError):
    """Raised when text cannot be read as namelist records at all."""


@dataclass
class Record:
    """One ``&GROUP ... /`` record.

    ``params`` is keyed by the parameter name upper-cased and *without* its
    subscript, so ``SURF_ID6`` and ``SURF_ID`` stay distinct while
    ``THICKNESS(1:2)`` and ``THICKNESS`` are the same parameter.
    """

    group: str
    params: Dict[str, List[Any]] = field(default_factory=dict)
    line: int = 0

    # -- typed accessors, all tolerant of a missing key ------------------

    def has(self, key: str) -> bool:
        return key.upper() in self.params

    def values(self, key: str) -> List[Any]:
        return self.params.get(key.upper(), [])

    def value(self, key: str, default: Any = None) -> Any:
        vals = self.values(key)
        return vals[0] if vals else default

    def number(self, key: str, default: Optional[float] = None) -> Optional[float]:
        v = self.value(key)
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default

    def numbers(self, key: str) -> List[float]:
        return [float(v) for v in self.values(key)
                if isinstance(v, (int, float)) and not isinstance(v, bool)]

    def string(self, key: str, default: Optional[str] = None) -> Optional[str]:
        v = self.value(key)
        return v if isinstance(v, str) else default

    def strings(self, key: str) -> List[Optional[str]]:
        """String values, keeping ``None`` holes so positional lists stay aligned.

        ``SURF_ID6`` is read by face index, so a gap has to stay a gap.
        """
        return [v if isinstance(v, str) else None for v in self.values(key)]

    def boolean(self, key: str, default: Optional[bool] = None) -> Optional[bool]:
        v = self.value(key)
        return v if isinstance(v, bool) else default

    def __repr__(self) -> str:
        return "<&{} {} at line {}>".format(
            self.group, " ".join(sorted(self.params)), self.line)


# -- 1. carving the text into records -------------------------------------

_GROUP_NAME = re.compile(r"&([A-Za-z]\w*)")


def _record_spans(text: str) -> Iterator[tuple]:
    """Yield ``(group, body, offset)`` for every record, in file order.

    The scan is character-by-character rather than a regex because the terminating
    ``/`` has to be recognised outside strings only, and Python's regex engine has
    no way to say that without either a lookbehind that cannot span a string or a
    pattern that has to model the string grammar anyway.
    """
    i, n = 0, len(text)
    while i < n:
        start = text.find("&", i)
        if start < 0:
            return
        match = _GROUP_NAME.match(text, start)
        if match is None:
            i = start + 1
            continue

        group = match.group(1).upper()
        j = match.end()
        quote: Optional[str] = None
        while j < n:
            ch = text[j]
            if quote is not None:
                if ch == quote:
                    # '' inside a single-quoted string is an escaped quote, not the end.
                    if ch == "'" and text[j + 1:j + 2] == "'":
                        j += 1
                    else:
                        quote = None
            elif ch in "'\"":
                quote = ch
            elif ch == "/":
                break
            j += 1

        yield group, text[match.end():j], start
        if group == "TAIL":
            return  # FDS stops reading here; so does this.
        i = j + 1


# -- 2. splitting a record body into parameters ---------------------------

def _mask_strings(body: str) -> str:
    """`body` with string *contents* replaced by X, so the assignment scan below
    cannot mistake an `=` inside a title for a parameter."""
    out: List[str] = []
    quote: Optional[str] = None
    for ch in body:
        if quote is not None:
            out.append("X" if ch != quote else ch)
            if ch == quote:
                quote = None
        else:
            out.append(ch)
            if ch in "'\"":
                quote = ch
    return "".join(out)


_ASSIGNMENT = re.compile(r"([A-Za-z_]\w*)\s*(\([^)]*\))?\s*=")

#: One value: a quoted string, or a run of anything that is not a separator.
#: Commas and whitespace are both separators -- see the module docstring.
_VALUE = re.compile(r"""'(?:[^']|'')*'|"[^"]*"|[^,\s]+""")

_REPEAT = re.compile(r"^(\d+)\*(.*)$")
_LOGICAL = re.compile(r"^\.(TRUE|FALSE|T|F)\.$", re.IGNORECASE)
#: Fortran spells a double-precision exponent with D. `1.2D3` is `1.2e3`; the
#: anchoring keeps it away from an unquoted word that merely contains a D.
_FORTRAN_REAL = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)[dD][-+]?\d+$")


#: A Fortran real, spelled out rather than left to `float()`. `float` accepts
#: 'inf', 'nan' and '1_0'; JavaScript's `Number` does not, and a parser that is
#: supposed to agree in both languages cannot differ on what counts as a number.
_REAL = re.compile(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$")


def _scalar(token: str) -> Any:
    if token[:1] in ("'", '"'):
        return token[1:-1].replace("''", "'")
    if _LOGICAL.match(token):
        return token[1:2].upper() == "T"
    if _FORTRAN_REAL.match(token):
        return float(token.replace("D", "e").replace("d", "e"))
    if _REAL.match(token):
        return float(token)
    return token  # an unquoted word; FDS accepts these for some parameters


def _parse_values(raw: str) -> List[Any]:
    out: List[Any] = []
    for token in _VALUE.findall(raw):
        repeat = _REPEAT.match(token)
        count, body = (int(repeat.group(1)), repeat.group(2)) if repeat else (1, token)
        if not body:
            continue
        out.extend([_scalar(body)] * count)
    return out


def _first_index(subscript: Optional[str]) -> Optional[int]:
    """The 1-based start index of a subscript like ``(2)``, ``(1:2,1)`` or ``(3,1)``.

    Only the first dimension is honoured. FDS's genuinely two-dimensional parameters
    (``MATL_ID(layer, component)``) are material data this format has no use for, and
    flattening them onto the first index keeps the layer order -- which is the part a
    reader might want to show -- rather than refusing the record.
    """
    if not subscript:
        return None
    head = subscript.strip("()").split(",")[0].strip()
    first = head.split(":")[0].strip()
    try:
        return int(first)
    except ValueError:
        return None


def _assign(params: Dict[str, List[Any]], key: str, subscript: Optional[str],
            values: Sequence[Any]) -> None:
    """Write `values` into `params[key]`, honouring a subscript as a 1-based offset.

    Without the offset, ``THICKNESS(1)=0.1`` followed by ``THICKNESS(2)=0.2`` would
    leave 0.2 alone in the list and lose the first layer.
    """
    index = _first_index(subscript)
    if index is None:
        # An unsubscripted write replaces the whole value, as Fortran does.
        params[key] = list(values)
        return
    slot = params.setdefault(key, [])
    start = max(index - 1, 0)
    while len(slot) < start:
        slot.append(None)
    slot[start:start + len(values)] = list(values)


def _parse_params(body: str) -> Dict[str, List[Any]]:
    masked = _mask_strings(body)
    hits = list(_ASSIGNMENT.finditer(masked))
    params: Dict[str, List[Any]] = {}
    for k, match in enumerate(hits):
        end = hits[k + 1].start() if k + 1 < len(hits) else len(body)
        raw = body[match.end():end].strip().rstrip(",")
        _assign(params, match.group(1).upper(), match.group(2), _parse_values(raw))
    return params


# -- 3. the public entry points -------------------------------------------

def read(text: str) -> List[Record]:
    """Every namelist record in `text`, in file order."""
    out: List[Record] = []
    for group, body, offset in _record_spans(text):
        out.append(Record(group=group, params=_parse_params(body),
                          line=text.count("\n", 0, offset) + 1))
    return out


def read_one(text: str) -> Record:
    """Exactly one record, for a line pasted into the editor.

    Raises rather than guessing, because "nothing happened" is the worst possible
    answer to a paste. A missing leading ``&`` is the mistake people actually make --
    it is how an FDS line gets commented out -- so it gets its own message.
    """
    stripped = text.strip()
    if not stripped:
        raise NamelistError("nothing to read")
    records = read(stripped)
    if not records:
        if _ASSIGNMENT.search(_mask_strings(stripped)):
            raise NamelistError(
                "no '&' to start the record -- FDS reads only lines that begin with "
                "&GROUP, so this one is a comment. Try &OBST {} /".format(stripped))
        raise NamelistError("no namelist record found; expected something like "
                            "&OBST XB=0,1,0,1,0,2 /")
    if len(records) > 1:
        raise NamelistError(
            "{} records here, and this takes one at a time: {}".format(
                len(records), ", ".join("&" + r.group for r in records[:4])))
    if not records[0].params:
        raise NamelistError("&{} has no parameters".format(records[0].group))
    return records[0]
