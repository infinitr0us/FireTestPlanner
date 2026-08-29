"""Canonical JSON writer. Mirror of web/src/core/serialize.ts.

Plans are revised by editing into a new file, so git history is the audit trail and
readable diffs are a feature, not a nicety. This module therefore fixes key order,
rounds floats to 1 um, and keeps coordinate arrays on one line -- so a plan that was
merely re-saved produces an empty diff, and a plan where one camera moved produces a
one-line diff.

The two writers must agree byte for byte, so this one does its own JSON emission
rather than calling `json.dumps` for the whole document: `json.dumps` renders floats
with `repr`, and `repr` disagrees with `JSON.stringify` about how to spell `1e-6`,
`1e16` and `12.0`. `_js_number` is where that is reconciled; everything else here
reproduces `json.dumps(indent=2, ensure_ascii=False)` verbatim.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Tuple

# 1 um. Finer than any tape measure used on a test site, and coarse enough that
# float round-trip noise never shows up in a diff.
FLOAT_DECIMALS = 6

_TOP = ["format", "version", "meta", "units", "coordinateSystem", "environment", "objects"]
_META = ["title", "testId", "author", "organization", "siteName", "created", "modified", "revision", "notes", "source"]
_SOURCE = ["tool", "file", "chid", "importedAt", "originOffset_m"]
_UNITS = ["length", "angle", "power", "temperature", "display"]
_UNITS_DISPLAY = ["length", "angle"]
_COORD = ["convention", "origin", "northAzimuth_rad"]
_ENV = ["floorSize_m", "ceilingHeight_m", "ambientTemperature_C", "notes"]

_TRANSFORM = ["position_m", "rotation_quat", "aimTarget_m"]
_DISPLAY = ["color", "visible", "locked"]
_CAMERA_SPEC = [
    "modality", "presetId", "resolution_px", "sensor_mm", "focalLength_mm", "zoomFactor",
    "principalPoint_px", "distortion", "intrinsicsSource", "spectralBand_um", "framerate_hz",
]
_DISTORTION = ["model", "coefficients"]
_MOUNT = ["type", "height_m"]
_FOOTPRINT = ["shape", "diameter_m", "size_m"]
_FIRE = ["fuel", "hrr_kw", "radiativeFraction", "hrrCurve"]
_DUCT = ["diameter_m", "length_m"]
_OPENING = ["id", "offset_m", "width_m", "height_m", "sillHeight_m"]
_GAUGE = ["kind", "range_kw_m2", "viewAngle_deg", "waterCooled", "serial"]
_THERMOCOUPLE = ["tcType", "beadDiameter_mm", "sheathed", "maxTemperature_C"]

_OBJECT_ORDER = {
    "camera": ["id", "type", "name", "transform", "camera", "mount", "recording", "display", "notes"],
    "burner": ["id", "type", "name", "transform", "footprint", "rimHeight_m", "fire", "display", "notes"],
    "hood": ["id", "type", "name", "transform", "opening_m", "height_m", "skirtDepth_m", "duct", "display", "notes"],
    "wall": ["id", "type", "name", "transform", "polyline_m", "height_m", "thickness_m", "baseHeight_m", "openings", "display", "notes"],
    "ceiling": ["id", "type", "name", "transform", "polygon_m", "height_m", "thickness_m", "display", "notes"],
    "heatFluxSensor": ["id", "type", "name", "transform", "gauge", "mount", "display", "notes"],
    "thermocouple": ["id", "type", "name", "transform", "beadOffsets_m", "thermocouple", "mount", "display", "notes"],
    "obstruction": ["id", "type", "name", "transform", "size_m", "display", "notes"],
}

#: Object types introduced after format 1.0, and therefore version-bumping.
_TYPES_1_1 = ("heatFluxSensor", "thermocouple")

#: And after 1.1. `meta.source` is deliberately NOT in any of these lists: `meta` is
#: open in every 1.x schema, so a plan imported from FDS that holds nothing past 1.0
#: keeps declaring 1.0.0 and still opens in a 1.0 tool. Provenance is not a feature a
#: reader has to understand in order to read the file correctly.
_TYPES_1_2 = ("obstruction",)

#: Baseline, and the highest this build writes. Mirror of FORMAT_VERSIONS in
#: web/src/core/types.ts.
_VERSION_MIN = "1.0.0"
_VERSION_LATEST = "1.2.0"


def _version_tuple(version: str) -> Tuple[int, ...]:
    """Three components, zero-padded, so comparison means the same thing here as in
    the web writer.

    Without the padding `("1", "0")` sorts below `(1, 0, 0)` and a plan declaring
    "1.0" is rewritten to "1.0.0" by this engine while the web writer leaves it
    alone -- a byte-parity crack, even if such a file is invalid to both validators.
    Mirror of `compareVersions` in web/src/core/types.ts.
    """
    try:
        parts = tuple(int(part) for part in str(version).split("."))
    except (TypeError, ValueError):
        return ()
    return (parts + (0, 0, 0))[:3]


def required_version(data: Dict[str, Any]) -> str:
    """The lowest format version that can describe this document.

    A plan that uses nothing beyond 1.0 keeps saying "1.0.0", so it still opens --
    and still validates -- in a build that predates 1.1. The moment it grows a zoom
    factor, a radiative fraction or a sensor, it says 1.1.0 and means it. Mirror of
    `requiredFormatVersion` in web/src/core/types.ts.
    """
    needed = _VERSION_MIN
    for obj in data.get("objects", []) or []:
        if not isinstance(obj, dict):
            continue
        kind = obj.get("type")
        if kind in _TYPES_1_2:
            return "1.2.0"  # the highest tier there is; nothing can raise it further
        if kind in _TYPES_1_1:
            needed = "1.1.0"
        elif kind == "camera":
            spec = obj.get("camera")
            if isinstance(spec, dict) and spec.get("zoomFactor") is not None:
                needed = "1.1.0"
        elif kind == "burner":
            fire = obj.get("fire")
            if isinstance(fire, dict) and fire.get("radiativeFraction") is not None:
                needed = "1.1.0"
    return needed


def effective_version(data: Dict[str, Any]) -> str:
    """The version to write: whichever of declared and required is higher.

    Only ever upward, and a version this build does not recognise is left alone
    rather than downgraded -- a 2.0 file re-saved here keeps saying 2.0.
    """
    declared = str(data.get("version") or "")
    needed = required_version(data)
    return declared if _version_tuple(declared) >= _version_tuple(needed) else needed


def _round_floats(value: Any) -> Any:
    """Round floats, leave ints and bools alone.

    bool is a subclass of int in Python, so it is tested first -- otherwise True
    would serialise as 1.

    Nothing here has to worry about how the result is spelled: `12.0` reaches the
    file as `12` and `-0.0` as `0` because `_js_number` writes every float the way
    JavaScript would, not the way `repr` would.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return round(value, FLOAT_DECIMALS)
    if isinstance(value, dict):
        return {k: _round_floats(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_round_floats(v) for v in value]
    return value


def _order(d: Dict[str, Any], keys: List[str]) -> Dict[str, Any]:
    """Emit `keys` in order, then any remaining keys in their existing order.

    The tail is what keeps unknown keys from a newer format version alive through a
    load/save cycle.
    """
    out = {k: d[k] for k in keys if k in d}
    out.update({k: v for k, v in d.items() if k not in out})
    return out


def _canon_sub(d: Any, keys: List[str]) -> Any:
    return _order(d, keys) if isinstance(d, dict) else d


def _drop_null_1_1(block: Any, key: str) -> Any:
    """Drop a 1.1-only key that is present but null.

    Null and absent mean the same thing to every reader of this format, and
    `required_version` agrees -- a null zoomFactor does not make a file 1.1. But the
    1.0 schema closes `camera.camera` and `burner.fire` with
    `additionalProperties: false`, so it rejects the KEY, whatever its value. Left
    in place, a hand-edited or third-party plan carrying an explicit null round-trips
    through this writer into a file that declares 1.0.0 and fails its own validator.
    Mirror of `dropNull1_1` in web/src/core/serialize.ts.
    """
    if isinstance(block, dict) and block.get(key, False) is None:
        block.pop(key)
    return block


def _canon_object(obj: Dict[str, Any]) -> Dict[str, Any]:
    o = dict(obj)

    if "transform" in o:
        o["transform"] = _canon_sub(o["transform"], _TRANSFORM)
    if "display" in o:
        o["display"] = _canon_sub(o["display"], _DISPLAY)

    kind = o.get("type")
    if kind == "camera" and isinstance(o.get("camera"), dict):
        spec = _order(o["camera"], _CAMERA_SPEC)
        if isinstance(spec.get("distortion"), dict):
            spec["distortion"] = _order(spec["distortion"], _DISTORTION)
        o["camera"] = _drop_null_1_1(spec, "zoomFactor")
        if "mount" in o:
            o["mount"] = _canon_sub(o["mount"], _MOUNT)
    elif kind == "burner":
        if "footprint" in o:
            o["footprint"] = _canon_sub(o["footprint"], _FOOTPRINT)
        if "fire" in o:
            o["fire"] = _drop_null_1_1(_canon_sub(o["fire"], _FIRE), "radiativeFraction")
    elif kind == "hood":
        if isinstance(o.get("duct"), dict):
            o["duct"] = _order(o["duct"], _DUCT)
    elif kind == "wall":
        if isinstance(o.get("openings"), list):
            o["openings"] = [_canon_sub(x, _OPENING) for x in o["openings"]]
    elif kind == "heatFluxSensor":
        if "gauge" in o:
            o["gauge"] = _canon_sub(o["gauge"], _GAUGE)
        if "mount" in o:
            o["mount"] = _canon_sub(o["mount"], _MOUNT)
    elif kind == "thermocouple":
        if "thermocouple" in o:
            o["thermocouple"] = _canon_sub(o["thermocouple"], _THERMOCOUPLE)
        if "mount" in o:
            o["mount"] = _canon_sub(o["mount"], _MOUNT)

    return _round_floats(_order(o, _OBJECT_ORDER[kind]))


def _canon_unknown_object(obj: Dict[str, Any]) -> Dict[str, Any]:
    """An object whose `type` this version does not recognise.

    Only the two blocks this version genuinely owns are canonicalised: `transform`,
    because the editor can drag an unknown object and would otherwise write float
    noise into it, and `display`, because it can be hidden or locked. Everything else
    -- key order, unknown keys, and full numeric precision -- is re-emitted exactly as
    it arrived. Rounding a coefficient whose meaning we do not know, or reordering
    fields against a schema we have never seen, is data loss dressed up as tidiness,
    and CONVENTIONS.md section 6 promises it will not happen.
    """
    o = dict(obj)
    if isinstance(o.get("transform"), dict):
        o["transform"] = _round_floats(_order(o["transform"], _TRANSFORM))
    if isinstance(o.get("display"), dict):
        o["display"] = _round_floats(_order(o["display"], _DISPLAY))
    return o


def canonicalize(data: Dict[str, Any]) -> Dict[str, Any]:
    """Return the plan with canonical key order and rounded floats."""
    d = dict(data)

    # The declared version tracks what the file actually contains, and only ever
    # upward. A plan that uses nothing past 1.0 keeps saying 1.0.0, so it still
    # opens in a build that predates 1.1; the moment it grows a sensor or a zoom
    # factor it says so, rather than claiming a compatibility it no longer has.
    d["version"] = effective_version(data)

    if "meta" in d:
        meta = _canon_sub(d["meta"], _META)
        if isinstance(meta, dict) and isinstance(meta.get("source"), dict):
            meta["source"] = _order(meta["source"], _SOURCE)
        d["meta"] = meta
    if "units" in d:
        units = _order(d["units"], _UNITS)
        if isinstance(units.get("display"), dict):
            units["display"] = _order(units["display"], _UNITS_DISPLAY)
        d["units"] = units
    if "coordinateSystem" in d:
        d["coordinateSystem"] = _canon_sub(d["coordinateSystem"], _COORD)
    if "environment" in d:
        d["environment"] = _canon_sub(d["environment"], _ENV)
    if isinstance(d.get("objects"), list):
        d["objects"] = [
            (_canon_object(o) if o.get("type") in _OBJECT_ORDER else _canon_unknown_object(o))
            if isinstance(o, dict) else o
            for o in d["objects"]
        ]

    # Objects have already had the rounding their own type warrants; the rest of the
    # document is all format 1.0 and rounds wholesale.
    ordered = _order(d, _TOP)
    return {
        k: (v if k == "objects" else _round_floats(v)) for k, v in ordered.items()
    }


# -- writing -------------------------------------------------------------
#
# The output is JSON, but it is not `json.dumps` output, because `json.dumps` spells
# floats with `repr` and `repr` is not what JavaScript writes. Everything below
# reproduces `json.dumps(indent=2, ensure_ascii=False, allow_nan=False)` exactly,
# except for floats, which go through `_js_number`.

_INDENT = "  "
_INF = float("inf")


def _shortest_digits(value: float) -> Tuple[str, int]:
    """The shortest round-tripping digits of a positive float, and its power of ten.

    `value == int(digits) * 10 ** exponent`. Python's float repr already produces the
    shortest digit string that round-trips -- the same digits V8 produces -- so this
    only has to take the decimal point and any padding zeros back out of it.

    `float.__repr__`, not `repr`, and for the same reason `json` uses it: a float
    subclass gets to override `repr`, and numpy 2 does -- `repr(np.float64(1.5))` is
    `np.float64(1.5)`. A plan holding a stray numpy scalar has to serialise as the
    number it is, not as its Python spelling.
    """
    mantissa, _, exp = float.__repr__(value).partition("e")
    exponent = int(exp) if exp else 0
    whole, _, frac = mantissa.partition(".")
    digits = (whole + frac).lstrip("0")
    exponent -= len(frac)
    trimmed = digits.rstrip("0")
    exponent += len(digits) - len(trimmed)
    return trimmed, exponent


def _js_number(value: float) -> str:
    """Format a float exactly as JavaScript's `JSON.stringify` would.

    Byte parity between this writer and the TypeScript one is a hard requirement
    (CONVENTIONS section 6), and `repr` is not it. The digits always agree -- both
    languages emit the shortest decimal that round-trips -- but the layout does not:

        Python  1.23e-08   1e-06     1e+16                12.0   -0.0
        JS      1.23e-8    0.000001  10000000000000000    12     0

    So the digits come from `repr` and the layout comes from ECMA-262's
    Number::toString, which is the rule below: fixed notation while the decimal
    exponent sits in [-6, 21), exponential outside it.
    """
    if value != value or value == _INF or value == -_INF:
        raise ValueError("Out of range float values are not JSON compliant: {!r}".format(value))
    if value == 0.0:
        return "0"  # including -0.0, which JSON.stringify also writes as 0
    if value < 0:
        return "-" + _js_number(-value)

    digits, exponent = _shortest_digits(value)
    k = len(digits)          # how many digits there are
    n = k + exponent         # where the decimal point goes, counted from the left

    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * -n + digits
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    return "{}e{}{}".format(mantissa, "+" if n - 1 > 0 else "-", abs(n - 1))


def _encode(value: Any, level: int) -> str:
    """One JSON value, indented as `json.dumps(indent=2)` would indent it."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):  # after the bool checks: bool subclasses int
        return int.__repr__(value)  # a subclass's own repr is not a JSON number
    if isinstance(value, float):
        return _js_number(value)

    pad = _INDENT * (level + 1)
    close = "\n" + _INDENT * level
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = []
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("plan keys must be strings, got {!r}".format(key))
            items.append("{}{}: {}".format(
                pad, json.dumps(key, ensure_ascii=False), _encode(item, level + 1)))
        return "{\n" + ",\n".join(items) + close + "}"
    if isinstance(value, (list, tuple)):
        if not value:
            return "[]"
        items = ["{}{}".format(pad, _encode(v, level + 1)) for v in value]
        return "[\n" + ",\n".join(items) + close + "]"

    raise TypeError("Object of type {} is not JSON serializable".format(type(value).__name__))


# Matches an array whose entire content is numeric -- no quotes, braces or nested
# brackets in the character class, so strings and object arrays never match, and a
# polyline's inner pairs collapse while the outer array stays expanded.
_NUMERIC_ARRAY = re.compile(r"\[[\s0-9eE.,+-]*\]")


def _collapse(match: "re.Match") -> str:
    text = match.group(0)
    # Only collapse arrays the writer actually broke across lines. Without this, a
    # numeric-looking substring inside a `notes` string would get its spacing rewritten.
    if "\n" not in text:
        return text
    parts = [p.strip() for p in text[1:-1].split(",") if p.strip()]
    return "[" + ", ".join(parts) + "]"


def dumps(data: Dict[str, Any]) -> str:
    """Serialise a plan to canonical JSON text, newline-terminated."""
    return _NUMERIC_ARRAY.sub(_collapse, _encode(canonicalize(data), 0)) + "\n"
