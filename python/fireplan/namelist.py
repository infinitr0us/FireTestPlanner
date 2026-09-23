"""Fortran namelist reader, as FDS writes them. Mirror of web/src/core/namelist.ts.

FDS input is a sequence of namelist records: ``&GROUP key=value, ... /``. Anything
outside a record is a comment, which is how FDS files carry prose -- and it is also
how a line gets disabled, either by deleting its leading ``&`` or by putting a ``!``
in front of it. Neither point is a curiosity: the sample file in ``fixtures/fds/``
has a ``REAC`` line carrying ``RADIATIVE_FRACTION=0.29`` that FDS never reads, and a
reader that picks it up is quietly wrong about the fire.

Five rules here are the ones a quick regex gets wrong, and the first three are
exercised by that same sample file:

* **A record ends at the first ``/`` that is not inside a string.** The sample's
  ``&HEAD`` title contains ``34.2x1000/300=114s``, so a reader that stops at the
  first ``/`` truncates the very first record in the file.
* **Parameters separate on commas *or* whitespace.** The sample's ``&SURF``,
  ``&MATL`` and ``&PROP`` records use newlines and no commas at all, so a
  comma-splitter silently loses ``HRRPUA`` and a thermocouple's ``DIAMETER``.
* **Subscripted assignments accumulate.** ``MATL_ID(1,1)='X'`` followed by
  ``MATL_ID(2,1)='Y'`` is two writes into one array, not two values of which the
  last wins.
* **``!`` starts a comment, outside a string, anywhere on a line.** That is the
  Fortran namelist rule, and FDS reads these records with Fortran's own namelist
  ``READ``, so it inherits it. Real inputs are full of ``! &OBST ...`` lines the
  author disabled; reading one back as live input puts geometry, devices or a
  reaction into the model that the simulation never had.
* **A record opens only where a line does.** FDS finds a record by scanning a line
  for a leading ``&`` and giving up at the first character that is neither ``&``
  nor a space, so ``&GROUP`` mid-sentence is prose. Searching the whole text for
  the next ``&`` instead does worse than read prose as input: ``R&D`` starts a
  ``&D`` record whose body runs to the next ``/``, swallowing the real record in
  between. A comment can therefore delete an obstruction.

This module is deliberately ignorant of what any of it means: it turns text into
records, and :mod:`fireplan.fds` decides what a record is for.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Sequence

from ._text import JS_WS_CLASS, js_parse_int, js_trim

__all__ = ["Record", "read", "read_one", "strip_comments", "NamelistError"]


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
    #: Where the record sits in the text it was read from: `start` is its ``&`` and
    #: `end` is just past its ``/``. `&CATF` splicing needs to put a whole file in
    #: at exactly that point, and nothing else can tell it where the point is.
    start: int = 0
    end: int = 0

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
        # Finite only, as the web reader has it: IOR=1D400 is infinity, and int()
        # of that raised OverflowError out of the importer.
        return (float(v) if isinstance(v, (int, float)) and not isinstance(v, bool)
                and math.isfinite(v) else default)

    def numbers(self, key: str) -> List[float]:
        return [float(v) for v in self.values(key)
                if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)]

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

_GROUP_NAME = re.compile(r"&([A-Za-z][A-Za-z0-9_]*)")  # ASCII, as JavaScript's \w


def strip_comments(text: str) -> str:
    """`text` with every ``!`` comment blanked out, one character for one character.

    Blanking rather than deleting is what keeps this cheap: every offset in the
    result is the offset in the original, so record positions and line numbers are
    still the file's own and no second mapping has to be carried around.

    Quote state resets at each newline. A namelist string does not span input
    records in any FDS file, and bounding it that way means one unbalanced quote
    costs the line it is on rather than the rest of the file.
    """
    out = list(text)
    quote: Optional[str] = None
    commented = False
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\n":
            quote, commented = None, False
        elif commented:
            out[i] = " "
        elif quote is not None:
            if ch == quote:
                # '' inside a single-quoted string is an escaped quote, not the end.
                if ch == "'" and text[i + 1:i + 2] == "'":
                    i += 1
                else:
                    quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == "!":
            commented = True
            out[i] = " "
        i += 1
    return "".join(out)


def _opens_a_record(scan: str, start: int, resume: int) -> bool:
    """Whether the ``&`` at `start` opens a record rather than sitting in prose.

    FDS's own reader walks a line from its first character and gives up at the
    first one that is neither ``&`` nor a space, so a record opens only where a
    line does. `resume` is where the previous record ended, which allows the one
    case a bare line test would refuse: a second record written after the first
    one's ``/`` on the same line.
    """
    line_start = scan.rfind("\n", 0, start) + 1
    return not js_trim(scan[max(line_start, resume):start])


def _record_spans(text: str) -> Iterator[tuple]:
    """Yield ``(group, body, start, end)`` for every record, in file order.

    The scan is character-by-character rather than a regex because the terminating
    ``/`` has to be recognised outside strings only, and Python's regex engine has
    no way to say that without either a lookbehind that cannot span a string or a
    pattern that has to model the string grammar anyway.

    It runs over the comment-stripped text, so a ``/`` inside a ``!`` comment does
    not end a record and a commented-out record is not a record.
    """
    scan = strip_comments(text)
    i, n = 0, len(scan)
    while i < n:
        start = scan.find("&", i)
        if start < 0:
            return
        match = _GROUP_NAME.match(scan, start)
        if match is None or not _opens_a_record(scan, start, i):
            i = start + 1
            continue

        group = match.group(1).upper()
        j = match.end()
        quote: Optional[str] = None
        while j < n:
            ch = scan[j]
            if ch == "\n":
                quote = None       # a string ends at its line, at the latest
            elif quote is not None:
                if ch == quote:
                    # '' inside a single-quoted string is an escaped quote, not the end.
                    if ch == "'" and scan[j + 1:j + 2] == "'":
                        j += 1
                    else:
                        quote = None
            elif ch in "'\"":
                quote = ch
            elif ch == "/":
                break
            j += 1

        yield group, scan[match.end():j], start, min(j + 1, n)
        if group == "TAIL":
            return  # FDS stops reading here; so does this.
        i = j + 1


# -- 2. splitting a record body into parameters ---------------------------

def _mask_strings(body: str) -> str:
    """`body` with string *contents* replaced by X, so the assignment scan below
    cannot mistake an `=` inside a title for a parameter.

    Same two refinements as the record scan: a doubled quote inside a
    single-quoted string is an escaped quote rather than the end of one, and a
    string ends at its newline at the latest.
    """
    out: List[str] = []
    quote: Optional[str] = None
    i, n = 0, len(body)
    while i < n:
        ch = body[i]
        if ch == "\n":
            out.append(ch)
            quote = None
        elif quote is not None:
            if ch == quote and ch == "'" and body[i + 1:i + 2] == "'":
                out.append("XX")
                i += 1
            else:
                out.append("X" if ch != quote else ch)
                if ch == quote:
                    quote = None
        else:
            out.append(ch)
            if ch in "'\"":
                quote = ch
        i += 1
    return "".join(out)


# The character classes are JavaScript's, not Python's: `\w` and `\s` are
# Unicode-aware here and ASCII / ECMAScript-whitespace there (see _text.py).
_ASSIGNMENT = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)[" + JS_WS_CLASS + r"]*(\([^)]*\))?["
                         + JS_WS_CLASS + r"]*=")

#: One value: a quoted string, or a run of anything that is not a separator.
#: Commas and whitespace are both separators -- see the module docstring.
_VALUE = re.compile(r"""(?:[0-9]+\*)?'(?:[^']|'')*'|(?:[0-9]+\*)?"[^"]*"|[^,"""
                    + JS_WS_CLASS + r"""]+""")

_REPEAT = re.compile(r"^([0-9]+)\*(.*)$")
_LOGICAL = re.compile(r"^\.(TRUE|FALSE|T|F)\.$", re.IGNORECASE)
#: Fortran spells a double-precision exponent with D. `1.2D3` is `1.2e3`; the
#: anchoring keeps it away from an unquoted word that merely contains a D.
_FORTRAN_REAL = re.compile(r"^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)[dD][-+]?[0-9]+$")


#: A Fortran real, spelled out rather than left to `float()`. `float` accepts
#: 'inf', 'nan' and '1_0'; JavaScript's `Number` does not, and a parser that is
#: supposed to agree in both languages cannot differ on what counts as a number.
_REAL = re.compile(r"^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$")


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
            # Fortran's null repeat: n values left as they were, kept as holes so
            # positional lists stay aligned. Mirror of namelist.ts.
            out.extend([None] * count)
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
    head = js_trim(subscript.replace("(", "").replace(")", "").split(",")[0])
    first = js_trim(head.split(":")[0])
    # Number.parseInt, as the web reader has it: '1_0' is 1 and a non-ASCII digit
    # is not a digit, where Python's int() read 10 and any script's digits.
    return js_parse_int(first)


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
        raw = js_trim(body[match.end():end])
        raw = raw[:-1] if raw.endswith(",") else raw
        _assign(params, match.group(1).upper(), match.group(2), _parse_values(raw))
    return params


# -- 3. the public entry points -------------------------------------------

def read(text: str) -> List[Record]:
    """Every namelist record in `text`, in file order.

    The line number is carried forward from the previous record rather than
    recounted from the start of the file: record offsets only ever increase, and a
    20,000-record input is not the place to be quadratic.
    """
    out: List[Record] = []
    line, pos = 1, 0
    for group, body, start, end in _record_spans(text):
        line += text.count("\n", pos, start)
        pos = start
        out.append(Record(group=group, params=_parse_params(body), line=line,
                          start=start, end=end))
    return out


def read_one(text: str) -> Record:
    """Exactly one record, for a line pasted into the editor.

    Raises rather than guessing, because "nothing happened" is the worst possible
    answer to a paste. A missing leading ``&`` is the mistake people actually make --
    it is how an FDS line gets commented out -- so it gets its own message.
    """
    stripped = js_trim(text)
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
