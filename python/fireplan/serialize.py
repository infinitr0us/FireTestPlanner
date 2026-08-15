"""Canonical JSON writer.

Plans are revised by editing into a new file, so git history is the audit trail and
readable diffs are a feature, not a nicety. This module therefore fixes key order,
rounds floats to 1 um, and keeps coordinate arrays on one line -- so a plan that was
merely re-saved produces an empty diff, and a plan where one camera moved produces a
one-line diff.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List

# 1 um. Finer than any tape measure used on a test site, and coarse enough that
# float round-trip noise never shows up in a diff.
FLOAT_DECIMALS = 6

_TOP = ["format", "version", "meta", "units", "coordinateSystem", "environment", "objects"]
_META = ["title", "testId", "author", "organization", "siteName", "created", "modified", "revision", "notes"]
_UNITS = ["length", "angle", "power", "temperature", "display"]
_UNITS_DISPLAY = ["length", "angle"]
_COORD = ["convention", "origin", "northAzimuth_rad"]
_ENV = ["floorSize_m", "ceilingHeight_m", "ambientTemperature_C", "notes"]

_TRANSFORM = ["position_m", "rotation_quat", "aimTarget_m"]
_DISPLAY = ["color", "visible", "locked"]
_CAMERA_SPEC = [
    "modality", "presetId", "resolution_px", "sensor_mm", "focalLength_mm",
    "principalPoint_px", "distortion", "intrinsicsSource", "spectralBand_um", "framerate_hz",
]
_DISTORTION = ["model", "coefficients"]
_MOUNT = ["type", "height_m"]
_FOOTPRINT = ["shape", "diameter_m", "size_m"]
_FIRE = ["fuel", "hrr_kw", "hrrCurve"]
_DUCT = ["diameter_m", "length_m"]
_OPENING = ["id", "offset_m", "width_m", "height_m", "sillHeight_m"]

_OBJECT_ORDER = {
    "camera": ["id", "type", "name", "transform", "camera", "mount", "recording", "display", "notes"],
    "burner": ["id", "type", "name", "transform", "footprint", "rimHeight_m", "fire", "display", "notes"],
    "hood": ["id", "type", "name", "transform", "opening_m", "height_m", "skirtDepth_m", "duct", "display", "notes"],
    "wall": ["id", "type", "name", "transform", "polyline_m", "height_m", "thickness_m", "baseHeight_m", "openings", "display", "notes"],
}
_OBJECT_FALLBACK = ["id", "type", "name", "transform", "display", "notes"]


def _round_floats(value: Any) -> Any:
    """Round floats, leave ints and bools alone.

    bool is a subclass of int in Python, so it is tested first -- otherwise True
    would serialise as 1.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        r = round(value, FLOAT_DECIMALS)
        # Collapse -0.0 to 0.0 so a mirrored object does not diff against itself.
        return 0.0 if r == 0.0 else r
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
        o["camera"] = spec
        if "mount" in o:
            o["mount"] = _canon_sub(o["mount"], _MOUNT)
    elif kind == "burner":
        if "footprint" in o:
            o["footprint"] = _canon_sub(o["footprint"], _FOOTPRINT)
        if "fire" in o:
            o["fire"] = _canon_sub(o["fire"], _FIRE)
    elif kind == "hood":
        if isinstance(o.get("duct"), dict):
            o["duct"] = _order(o["duct"], _DUCT)
    elif kind == "wall":
        if isinstance(o.get("openings"), list):
            o["openings"] = [_canon_sub(x, _OPENING) for x in o["openings"]]

    return _order(o, _OBJECT_ORDER.get(kind, _OBJECT_FALLBACK))


def canonicalize(data: Dict[str, Any]) -> Dict[str, Any]:
    """Return the plan with canonical key order and rounded floats."""
    d = dict(data)
    if "meta" in d:
        d["meta"] = _canon_sub(d["meta"], _META)
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
        d["objects"] = [_canon_object(o) if isinstance(o, dict) else o for o in d["objects"]]
    return _round_floats(_order(d, _TOP))


# Matches an array whose entire content is numeric -- no quotes, braces or nested
# brackets in the character class, so strings and object arrays never match, and a
# polyline's inner pairs collapse while the outer array stays expanded.
_NUMERIC_ARRAY = re.compile(r"\[[\s0-9eE.,+-]*\]")


def _collapse(match: "re.Match") -> str:
    text = match.group(0)
    # Only collapse arrays json.dumps actually broke across lines. Without this, a
    # numeric-looking substring inside a `notes` string would get its spacing rewritten.
    if "\n" not in text:
        return text
    parts = [p.strip() for p in text[1:-1].split(",") if p.strip()]
    return "[" + ", ".join(parts) + "]"


def dumps(data: Dict[str, Any]) -> str:
    """Serialise a plan to canonical JSON text, newline-terminated."""
    text = json.dumps(canonicalize(data), indent=2, ensure_ascii=False, allow_nan=False)
    return _NUMERIC_ARRAY.sub(_collapse, text) + "\n"
