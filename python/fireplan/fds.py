"""Convert an FDS input file into a fire test plan. Mirror of web/src/core/fds.ts.

An FDS input describes a simulation; a fire test plan describes what will be built
and where the instruments go. The overlap is real but partial, and this module is
deliberately about the overlap only: geometry, the fire, and the devices that
correspond to instruments someone has to physically mount. Materials, reaction
chemistry, meshes, slice files and output control have no counterpart here and are
reported as skipped rather than smuggled into the plan.

Three things are worth knowing before reading further.

**The origin moves.** This format's origin is the burner centre at floor level
(CONVENTIONS section 1); an FDS file's origin is wherever the author put it. So an
import always translates, and records the translation in ``meta.source
.originOffset_m`` -- the position of the plan origin in the source file's
coordinates -- so a reader can put a number back into the frame the ``.fds`` file
uses and compare. That offset is what the editor's FDS coordinate view is built on.

**Nothing is guessed that the file does not say.** ``RADIATIVE_FRACTION`` is
imported only when ``&REAC`` states it, never defaulted to FDS's own default,
because a wrong radiative fraction silently changes every predicted heat flux in
the plan. The same goes for a gauge's range, which FDS has no concept of: it is
left null, and the gauge checks say so, rather than inventing 50 kW/m2.

**Everything not imported is reported.** :class:`FdsImport` carries an issue list
covering every record the mapping dropped and every judgement call it made -- which
obstruction became a wall rather than a box, which heat-release surface was taken
to be the burner. An import that quietly loses half a model is worse than one that
refuses, so this one neither loses nor refuses: it converts and then says what it
did.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from . import namelist
from .namelist import Record
from .plan import Issue, Plan, PlanError

__all__ = [
    "FdsImport",
    "DeviceGroup",
    "ImportOptions",
    "load",
    "to_plan",
    "obstruction_from_record",
    "device_from_record",
    "GAUGE_QUANTITIES",
    "GAS_TC_QUANTITIES",
    "SURFACE_TC_QUANTITIES",
]

Xb = List[float]

# -- tunables -------------------------------------------------------------

#: A box is a horizontal slab when its height is at most this fraction of its
#: smaller plan dimension, and a wall when its thin plan dimension is at most this
#: fraction of both its length and its height. Anything else is a solid block.
#: 0.5 is loose on purpose: a 0.1 m wall 2.6 m long and a 0.15 m slab 3 m across
#: both clear it by a wide margin, while a 2.0 x 0.9 x 0.8 m couch fails it as a
#: wall (0.9 is not <= 0.4) and becomes the obstruction it is.
SLAB_ASPECT = 0.5
WALL_ASPECT = 0.5

#: Coordinates closer than this are the same coordinate. FDS input is written to a
#: few decimals by hand or by a mesh generator; 0.1 mm is finer than either.
TOL_M = 1e-4

#: A burner standing more than this above the detected floor is worth mentioning:
#: either it is on a platform, or the floor was detected wrongly, and the reader is
#: better placed to tell which.
BURNER_PLATFORM_TOL_M = 0.05

#: Quantities that correspond to an instrument someone has to mount. A DEVC is not
#: automatically an instrument -- an FDS model is full of numerical probes -- so the
#: mapping is an allow-list, and anything outside it is reported, not imported.
GAUGE_QUANTITIES = frozenset({
    "GAUGE HEAT FLUX", "INCIDENT HEAT FLUX", "RADIATIVE HEAT FLUX",
    "CONVECTIVE HEAT FLUX", "NET HEAT FLUX", "HEAT FLUX",
    "RADIOMETER", "RADIATIVE HEAT FLUX GAS",
})
GAS_TC_QUANTITIES = frozenset({"THERMOCOUPLE", "TEMPERATURE"})
SURFACE_TC_QUANTITIES = frozenset({
    "WALL TEMPERATURE", "INSIDE WALL TEMPERATURE", "BACK WALL TEMPERATURE",
    "ADIABATIC SURFACE TEMPERATURE",
})

#: FDS's named colours, restricted to the ones that actually turn up in inputs.
#: Anything else falls back to the type colour the editor already uses.
FDS_COLORS = {
    "RED": "#ff0000", "GREEN": "#008000", "BLUE": "#0000ff", "YELLOW": "#ffff00",
    "CYAN": "#00ffff", "MAGENTA": "#ff00ff", "WHITE": "#ffffff", "BLACK": "#000000",
    "GRAY": "#808080", "GREY": "#808080", "SILVER": "#c0c0c0", "ORANGE": "#ffa500",
    "PURPLE": "#800080", "BROWN": "#a52a2a", "PINK": "#ffc0cb", "GOLD": "#ffd700",
    "BEIGE": "#f5f5dc", "TAN": "#d2b48c", "NAVY": "#000080", "TEAL": "#008080",
    "OLIVE": "#808000", "MAROON": "#800000", "INVISIBLE": None,
}

#: The six faces of an FDS box, in `SURF_ID6` order.
FACES = ("-x", "+x", "-y", "+y", "-z", "+z")

#: `IOR` is the direction the mounting surface faces, which is exactly the outward
#: normal a heat flux gauge in this format stores.
IOR_NORMAL = {
    1: (1.0, 0.0, 0.0), -1: (-1.0, 0.0, 0.0),
    2: (0.0, 1.0, 0.0), -2: (0.0, -1.0, 0.0),
    3: (0.0, 0.0, 1.0), -3: (0.0, 0.0, -1.0),
}


# -- results --------------------------------------------------------------

@dataclass
class DeviceGroup:
    """One `&DEVC` quantity found in the file, and what it was turned into.

    The import preview lists these so the choice is visible before anything is
    created: an FDS model routinely carries hundreds of devices, most of which are
    numerical probes rather than hardware.
    """

    quantity: Optional[str]
    count: int
    mapped_to: Optional[str]        # 'thermocouple' | 'heatFluxSensor' | None
    objects: int = 0                # how many plan objects it produced
    note: str = ""


@dataclass
class FdsImport:
    """The plan, and a full account of how it was arrived at."""

    plan: Plan
    issues: List[Issue] = field(default_factory=list)
    devices: List[DeviceGroup] = field(default_factory=list)
    #: Position of the plan origin in the source file's coordinates.
    origin_m: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    #: The heat-release surface taken to be the burner, if any.
    burner_surf: Optional[str] = None
    burner_candidates: List[str] = field(default_factory=list)
    source_file: Optional[str] = None

    @property
    def counts(self) -> Dict[str, int]:
        out: Dict[str, int] = {}
        for obj in self.plan.data.get("objects", []):
            out[obj["type"]] = out.get(obj["type"], 0) + 1
        return out

    @property
    def errors(self) -> List[Issue]:
        return [i for i in self.issues if i.severity == "error"]

    def summary(self) -> str:
        parts = ["{} {}".format(n, k) for k, n in sorted(self.counts.items())]
        return "{} -> {}".format(self.source_file or "FDS input",
                                 ", ".join(parts) if parts else "nothing")


@dataclass
class ImportOptions:
    """Everything the caller may want to overrule.

    Defaults are what the import preview shows first; the dialog writes back into
    this and re-runs, so the preview and the committed import cannot disagree.
    """

    #: Plan origin in FDS coordinates. None means detect it from the burner and floor.
    origin_m: Optional[Sequence[float]] = None
    #: Floor level in FDS coordinates. None means detect it.
    floor_z_m: Optional[float] = None
    #: `SURF` id of the heat-release surface to treat as the burner. None means the
    #: most compact horizontal one, which is the ignition source in every input that
    #: also has a burning lining.
    burner_surf: Optional[str] = None
    #: Collapse a vertical run of same-quantity devices into one rake object.
    group_rakes: bool = True
    #: Quantity -> plan type, overriding the built-in allow-list. A value of None
    #: suppresses that quantity.
    device_map: Optional[Dict[str, Optional[str]]] = None
    #: Import geometry (`&OBST`, `&HOLE`) at all.
    geometry: bool = True
    #: Import `&DEVC` as instruments at all.
    devices: bool = True
    #: Timestamp for `meta.source.importedAt`. None means now. Set it to compare two
    #: imports of the same file byte for byte -- which is how the TypeScript and
    #: Python importers are held to the same output.
    imported_at: Optional[str] = None


# -- small helpers --------------------------------------------------------

def _slug(text: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return out or "x"


def _extent(xb: Xb) -> Tuple[float, float, float]:
    return xb[1] - xb[0], xb[3] - xb[2], xb[5] - xb[4]


def _centre(xb: Xb) -> Tuple[float, float, float]:
    return (xb[0] + xb[1]) / 2.0, (xb[2] + xb[3]) / 2.0, (xb[4] + xb[5]) / 2.0


def _sorted_xb(xb: Sequence[float]) -> Xb:
    """`XB` with each pair in ascending order.

    FDS accepts either order and normalises internally, and hand-edited files do
    write `XB=2.5,-0.1,...`. Every extent below would come out negative.
    """
    v = [float(x) for x in xb]
    return [min(v[0], v[1]), max(v[0], v[1]), min(v[2], v[3]), max(v[2], v[3]),
            min(v[4], v[5]), max(v[4], v[5])]


def _color_of(rec: Record) -> Optional[str]:
    name = rec.string("COLOR")
    if name:
        return FDS_COLORS.get(name.strip().upper())
    rgb = rec.numbers("RGB")
    if len(rgb) >= 3:
        return "#{:02x}{:02x}{:02x}".format(
            *(max(0, min(255, int(round(c)))) for c in rgb[:3]))
    return None


def _face_surfs(rec: Record) -> List[Optional[str]]:
    """The `SURF_ID` of each of the six faces, in `FACES` order."""
    six = rec.strings("SURF_ID6")
    if six:
        return (six + [None] * 6)[:6]
    one = rec.string("SURF_ID")
    return [one] * 6 if one else [None] * 6


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class _Ids:
    """Unique, readable object ids -- an FDS `ID` where there is one, else a counter."""

    def __init__(self) -> None:
        self.used: Dict[str, int] = {}

    def make(self, prefix: str, name: Optional[str] = None) -> str:
        base = "{}-{}".format(prefix, _slug(name)) if name else prefix
        n = self.used.get(base, 0)
        self.used[base] = n + 1
        if n == 0 and name:
            return base
        return "{}-{}".format(base, n + 1)


# -- reading the file, including its includes -----------------------------

def _read_source(path: str, seen: Optional[set] = None, depth: int = 0) -> Tuple[str, List[Issue]]:
    """The file's text with any `&CATF` includes concatenated in place.

    FDS's `&CATF` splices other files into the input, and split inputs are normal in
    anything bigger than a demonstration case -- a geometry file plus a devices file
    is the usual shape. Reading only the named file would import a model with no
    geometry and no obvious reason why.
    """
    seen = set() if seen is None else seen
    issues: List[Issue] = []
    real = os.path.abspath(path)
    if real in seen:
        return "", [Issue("warning", "fds-catf-cycle",
                          "{} includes itself; the repeat was skipped".format(
                              os.path.basename(path)))]
    if depth > 8:
        return "", [Issue("warning", "fds-catf-deep",
                          "&CATF nesting stopped at 8 levels deep")]
    seen.add(real)

    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()

    extra: List[str] = []
    for rec in namelist.read(text):
        if rec.group != "CATF":
            continue
        for other in rec.strings("OTHER_FILES"):
            if not other:
                continue
            child = other if os.path.isabs(other) else os.path.join(os.path.dirname(real), other)
            if not os.path.exists(child):
                issues.append(Issue("warning", "fds-catf-missing",
                                    "&CATF names {} but it is not beside the input; "
                                    "anything it defined is missing from this plan"
                                    .format(other)))
                continue
            child_text, child_issues = _read_source(child, seen, depth + 1)
            extra.append(child_text)
            issues.extend(child_issues)

    return "\n".join([text] + extra), issues


# -- the model, one step above raw records --------------------------------

@dataclass
class _Box:
    """An `&OBST`, `&HOLE` or `&VENT` after `&MULT` expansion."""

    xb: Xb
    rec: Record
    surfs: List[Optional[str]] = field(default_factory=lambda: [None] * 6)
    name: Optional[str] = None
    color: Optional[str] = None


def _multipliers(records: List[Record]) -> Dict[str, Record]:
    return {r.string("ID"): r for r in records if r.group == "MULT" and r.string("ID")}


def _expand_mult(xb: Xb, mult: Optional[Record]) -> List[Xb]:
    """Every copy `&MULT` asks for, including the original.

    Supports the two forms that appear in real inputs: a `DX`/`DY`/`DZ` step over
    `I`/`J`/`K` index ranges, and a `DXB` delta over `N_LOWER`..`N_UPPER`. An
    unexpanded `MULT_ID` would drop most of a repetitive facade, so this is not
    optional decoration.
    """
    if mult is None:
        return [list(xb)]

    def rng(lo: str, hi: str) -> range:
        a = int(mult.number(lo, 0) or 0)
        b = int(mult.number(hi, 0) or 0)
        return range(min(a, b), max(a, b) + 1)

    dx0 = mult.number("DX0", 0.0) or 0.0
    dy0 = mult.number("DY0", 0.0) or 0.0
    dz0 = mult.number("DZ0", 0.0) or 0.0

    dxb = mult.numbers("DXB")
    if len(dxb) == 6 and (mult.has("N_LOWER") or mult.has("N_UPPER")):
        out = []
        for n in rng("N_LOWER", "N_UPPER"):
            out.append([xb[k] + n * dxb[k] for k in range(6)])
        return out

    dx = mult.number("DX", 0.0) or 0.0
    dy = mult.number("DY", 0.0) or 0.0
    dz = mult.number("DZ", 0.0) or 0.0
    out = []
    for i in rng("I_LOWER", "I_UPPER"):
        for j in rng("J_LOWER", "J_UPPER"):
            for k in rng("K_LOWER", "K_UPPER"):
                sx, sy, sz = dx0 + i * dx, dy0 + j * dy, dz0 + k * dz
                out.append([xb[0] + sx, xb[1] + sx, xb[2] + sy, xb[3] + sy,
                            xb[4] + sz, xb[5] + sz])
    return out


def _boxes(records: List[Record], group: str, mults: Dict[str, Record]) -> List[_Box]:
    out: List[_Box] = []
    for rec in records:
        if rec.group != group or not rec.has("XB"):
            continue
        xb = _sorted_xb(rec.numbers("XB"))
        if len(xb) != 6:
            continue
        mult = mults.get(rec.string("MULT_ID") or "")
        for copy in _expand_mult(xb, mult):
            out.append(_Box(xb=_sorted_xb(copy), rec=rec, surfs=_face_surfs(rec),
                            name=rec.string("ID"), color=_color_of(rec)))
    return out


# -- the fire -------------------------------------------------------------

@dataclass
class _FireFace:
    surf: str
    xb: Xb
    area_m2: float
    hrr_kw: Optional[float]
    face: str
    horizontal: bool
    from_vent: bool


def _peak_ramp(records: List[Record]) -> Dict[str, float]:
    """The largest `F` each `&RAMP` reaches.

    `HRRPUA` is the value at `F = 1`, so the peak heat release of a ramped fire is
    `HRRPUA x area x max(F)`. A ramp that never reaches 1 -- a growth curve cut
    short, which is the usual shape -- would otherwise be read as a fire larger than
    the input ever produces.
    """
    peaks: Dict[str, float] = {}
    for rec in records:
        if rec.group != "RAMP":
            continue
        rid = rec.string("ID")
        f = rec.number("F")
        if rid is not None and f is not None:
            peaks[rid] = max(peaks.get(rid, 0.0), f)
    return peaks


def _fire_faces(boxes: List[_Box], vents: List[_Box], surfs: Dict[str, Record],
                peaks: Dict[str, float], heat_of_combustion: Optional[float]) -> List[_FireFace]:
    """Every surface in the model that releases heat.

    A model can easily have several: the sample input has a 7500 kW/m2 ignition
    source *and* a 300 kW/m2 burning wall lining. Both are found; which one becomes
    the plan's burner is decided separately, and is overridable.
    """
    def released(surf_id: Optional[str]) -> Optional[Tuple[float, str]]:
        rec = surfs.get(surf_id or "")
        if rec is None:
            return None
        peak = peaks.get(rec.string("RAMP_Q") or "", 1.0) or 1.0
        hrrpua = rec.number("HRRPUA")
        if hrrpua:
            return hrrpua * peak, "HRRPUA"
        mlrpua = rec.number("MLRPUA")
        hoc = rec.number("HEAT_OF_COMBUSTION", heat_of_combustion)
        if mlrpua and hoc:
            # kg/m2/s x kJ/kg = kW/m2
            return mlrpua * hoc * peak, "MLRPUA"
        return None

    out: List[_FireFace] = []
    for box, from_vent in [(b, False) for b in boxes] + [(v, True) for v in vents]:
        dx, dy, dz = _extent(box.xb)
        for index, surf_id in enumerate(box.surfs):
            rel = released(surf_id)
            if rel is None:
                continue
            face = FACES[index]
            if face in ("-x", "+x"):
                area = dy * dz
            elif face in ("-y", "+y"):
                area = dx * dz
            else:
                area = dx * dy
            # A vent is a plane: whichever extent is degenerate names its face, and
            # the other two give its area, whatever SURF_ID6 slot it arrived in.
            if from_vent:
                if dz <= TOL_M:
                    face, area = "+z", dx * dy
                elif dy <= TOL_M:
                    face, area = "+y", dx * dz
                elif dx <= TOL_M:
                    face, area = "+x", dy * dz
            out.append(_FireFace(
                surf=str(surf_id), xb=box.xb, area_m2=area,
                hrr_kw=rel[0] * area if area > 0 else None,
                face=face, horizontal=face in ("-z", "+z"), from_vent=from_vent))
    return out


def _pick_burner(faces: List[_FireFace], wanted: Optional[str]) -> Optional[_FireFace]:
    """The heat-release face to treat as the plan's burner.

    Horizontal first, then smallest: a burning wall lining is not a burner, and when
    a model has both an ignition source and a spreading fire the ignition source is
    the compact one. The caller can name a `SURF` instead, and the import preview
    lists every candidate so the choice is visible rather than implicit.
    """
    if not faces:
        return None
    if wanted:
        named = [f for f in faces if f.surf == wanted]
        if named:
            return min(named, key=lambda f: f.area_m2)
    horizontal = [f for f in faces if f.horizontal]
    return min(horizontal or faces, key=lambda f: f.area_m2)


# -- geometry classification ----------------------------------------------

def _is_slab(xb: Xb) -> bool:
    dx, dy, dz = _extent(xb)
    return dz <= SLAB_ASPECT * min(dx, dy) and min(dx, dy) > TOL_M


def _is_wall(xb: Xb) -> bool:
    dx, dy, dz = _extent(xb)
    thin, long_ = min(dx, dy), max(dx, dy)
    return thin <= WALL_ASPECT * long_ and thin <= WALL_ASPECT * dz


def _detect_floor(slabs: List[_Box], burner: Optional[_FireFace],
                  domain: Optional[Xb]) -> Tuple[float, str]:
    """Floor level, and the rule that produced it.

    The lowest horizontal slab's TOP face -- the surface things stand on -- rather
    than the bottom of the mesh. The distinction is not academic: the sample input's
    meshes start at z = -0.2 while its floor slab's top is at z = 0, so taking the
    mesh would put every height in the plan 200 mm out and leave the burner floating.
    """
    below = [s for s in slabs
             if burner is None or s.xb[5] <= burner.xb[4] + BURNER_PLATFORM_TOL_M]
    pool = below or slabs
    if pool:
        lowest = min(pool, key=lambda s: s.xb[5])
        return lowest.xb[5], "the top of the lowest horizontal slab"
    if burner is not None:
        return burner.xb[4], "the base of the burner"
    if domain is not None:
        return domain[4], "the bottom of the mesh"
    return 0.0, "z = 0"


# -- single-record conversion, shared with the editor's paste box ----------

def obstruction_from_record(rec: Record, origin: Sequence[float] = (0.0, 0.0, 0.0),
                            ids: Optional[_Ids] = None,
                            surfs: Optional[Dict[str, Record]] = None) -> Optional[Dict[str, Any]]:
    """One `&OBST` or `&VENT` as a plan object, with no model around it.

    This is what the editor's "create from FDS text" box calls, so a pasted `&OBST`
    lands as the same wall the full importer would have produced -- one
    classification rule, not two that drift.
    """
    if not rec.has("XB"):
        return None
    xb = _sorted_xb(rec.numbers("XB"))
    if len(xb) != 6:
        return None
    return _geometry_object(xb, rec, origin, ids or _Ids(), surfs or {})


def _geometry_object(xb: Xb, rec: Record, origin: Sequence[float], ids: _Ids,
                     surfs: Dict[str, Record]) -> Dict[str, Any]:
    """A box -- classified, re-origined and named -- as a wall, ceiling or obstruction.

    Takes the `XB` separately from the record so a `&MULT` copy converts through
    exactly this path rather than a parallel one.
    """
    ox, oy, oz = (float(v) for v in origin)
    dx, dy, dz = _extent(xb)
    cx, cy, _ = _centre(xb)
    color = _color_of(rec)
    display = {"color": color} if color else None
    name = rec.string("ID")

    if _is_slab(xb) and dz > TOL_M:
        obj: Dict[str, Any] = {
            "id": ids.make("ceiling", name), "type": "ceiling", "name": name or "Ceiling",
            "transform": {"position_m": [0.0, 0.0, 0.0]},
            "polygon_m": [[xb[0] - ox, xb[2] - oy], [xb[1] - ox, xb[2] - oy],
                          [xb[1] - ox, xb[3] - oy], [xb[0] - ox, xb[3] - oy]],
            "height_m": xb[4] - oz,
            "thickness_m": dz,
        }
    elif _is_wall(xb):
        if dx <= dy:                       # runs along Y
            a = [cx - ox, xb[2] - oy]
            b = [cx - ox, xb[3] - oy]
            thickness = dx
        else:                              # runs along X
            a = [xb[0] - ox, cy - oy]
            b = [xb[1] - ox, cy - oy]
            thickness = dy
        base = xb[4] - oz
        obj = {
            "id": ids.make("wall", name), "type": "wall", "name": name or "Wall",
            "transform": {"position_m": [0.0, 0.0, 0.0]},
            "polyline_m": [a, b],
            # Height is measured from the base the plan will actually draw. A wall
            # that starts below the floor -- every wall in the sample input starts
            # 100 mm down, because that is how you seal one to a slab -- keeps its
            # top where the file put it instead of gaining the buried part twice.
            "height_m": max(xb[5] - max(xb[4], oz), TOL_M),
            "thickness_m": thickness,
            "baseHeight_m": max(base, 0.0),
            "openings": [],
        }
    else:
        obj = {
            "id": ids.make("obst", name), "type": "obstruction", "name": name or "Obstruction",
            "transform": {"position_m": [cx - ox, cy - oy, xb[4] - oz]},
            "size_m": [dx, dy, dz],
        }

    if display:
        obj["display"] = display
    note = _surface_note(rec, surfs)
    if note:
        obj["notes"] = note
    return obj


def _surface_note(rec: Record, surfs: Dict[str, Record]) -> Optional[str]:
    """What the FDS surfaces on this box were, and whether any of them burns.

    A combustible lining is a planning fact, not simulation trivia: it decides where
    a gauge can survive and what the room looks like ten minutes in. This format has
    nowhere structured to put it, so it goes in the notes rather than nowhere.
    """
    named = [x for x in dict.fromkeys(rec.strings("SURF_ID6") or [rec.string("SURF_ID")]) if x]
    if not named:
        return None
    burning = [x for x in named
               if surfs.get(x) is not None
               and (surfs[x].number("HRRPUA") or surfs[x].number("MLRPUA"))]
    quoted = lambda names: ", ".join("'" + str(x) + "'" for x in names)  # noqa: E731
    note = "FDS SURF " + quoted(named)
    if burning:
        note += " -- {} release{} heat, so this surface burns".format(
            quoted(burning), "" if len(burning) > 1 else "s")
    return note


def device_from_record(rec: Record, props: Optional[Dict[str, Record]] = None,
                       origin: Sequence[float] = (0.0, 0.0, 0.0),
                       aim_target: Optional[Sequence[float]] = None,
                       ids: Optional[_Ids] = None) -> Optional[Dict[str, Any]]:
    """One `&DEVC` as a plan instrument, or None if its quantity is not one."""
    quantity, diameter = _device_quantity(rec, props or {})
    kind = default_device_map().get((quantity or "").upper())
    if kind is None or not rec.has("XYZ"):
        return None
    xyz = rec.numbers("XYZ")
    if len(xyz) != 3:
        return None
    ids = ids or _Ids()
    ox, oy, oz = (float(v) for v in origin)
    position = [xyz[0] - ox, xyz[1] - oy, xyz[2] - oz]
    name = rec.string("ID")

    if kind == "heatFluxSensor":
        return _gauge_object(ids, name, position, _device_normal(rec), aim_target, quantity)
    return _rake_object(ids, name, position, [0.0], diameter, quantity)


def default_device_map() -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {}
    for q in GAUGE_QUANTITIES:
        out[q] = "heatFluxSensor"
    for q in GAS_TC_QUANTITIES | SURFACE_TC_QUANTITIES:
        out[q] = "thermocouple"
    return out


def _device_quantity(rec: Record, props: Dict[str, Record]) -> Tuple[Optional[str], Optional[float]]:
    """A device's quantity and bead diameter, following `PROP_ID` when it has one.

    A thermocouple is written as `&DEVC PROP_ID='TC'` with the quantity on the
    `&PROP`, so a reader that only looks at `QUANTITY` sees an unlabelled device and
    imports nothing -- which is exactly what every thermocouple in the sample input
    would do.
    """
    quantity = rec.string("QUANTITY")
    diameter = None
    prop = props.get(rec.string("PROP_ID") or "")
    if prop is not None:
        quantity = quantity or prop.string("QUANTITY")
        diameter = prop.number("DIAMETER")
    return quantity, diameter


def _device_normal(rec: Record) -> Optional[Tuple[float, float, float]]:
    orientation = rec.numbers("ORIENTATION")
    if len(orientation) == 3 and any(abs(v) > TOL_M for v in orientation):
        n = math.sqrt(sum(v * v for v in orientation))
        return (orientation[0] / n, orientation[1] / n, orientation[2] / n)
    ior = rec.number("IOR")
    return IOR_NORMAL.get(int(ior)) if ior is not None else None


def _gauge_object(ids: _Ids, name: Optional[str], position: List[float],
                  normal: Optional[Tuple[float, float, float]],
                  aim_target: Optional[Sequence[float]],
                  quantity: Optional[str]) -> Dict[str, Any]:
    from ._math import look_at_quat
    import numpy as np

    if normal is not None:
        target = [position[i] + normal[i] for i in range(3)]
    elif aim_target is not None:
        target = [float(v) for v in aim_target]
    else:
        target = [position[0], position[1], position[2] + 1.0]

    quat = look_at_quat(np.asarray(position, dtype=float), np.asarray(target, dtype=float))
    return {
        "id": ids.make("hf", name), "type": "heatFluxSensor",
        "name": name or "Heat flux gauge",
        "transform": {
            "position_m": [float(v) for v in position],
            "rotation_quat": [float(v) for v in quat],
            "aimTarget_m": [float(v) for v in target],
        },
        "gauge": {
            "kind": "other",
            # FDS has no gauge; it reports the flux at a point. Inventing a full
            # scale here would make every over-range and low-signal verdict in the
            # plan a fiction, so the range stays unstated and the checks say so.
            "range_kw_m2": None,
            "viewAngle_deg": 180.0,
            "waterCooled": None,
            "serial": None,
        },
        "mount": {"type": "wall" if normal is not None else "other",
                  "height_m": float(position[2])},
        "notes": "FDS &DEVC QUANTITY='{}'".format(quantity) if quantity else None,
    }


def _rake_object(ids: _Ids, name: Optional[str], position: List[float],
                 offsets: Sequence[float], diameter_m: Optional[float],
                 quantity: Optional[str]) -> Dict[str, Any]:
    surface = (quantity or "").upper() in SURFACE_TC_QUANTITIES
    return {
        "id": ids.make("tc", name), "type": "thermocouple",
        "name": name or ("Surface temperature" if surface else "Thermocouple"),
        "transform": {"position_m": [float(v) for v in position]},
        "beadOffsets_m": [float(v) for v in offsets],
        "thermocouple": {
            "tcType": "K",
            "beadDiameter_mm": diameter_m * 1000.0 if diameter_m else None,
            "sheathed": None,
            "maxTemperature_C": None,
        },
        "mount": {"type": "wall" if surface else "pole", "height_m": float(position[2])},
        "notes": "FDS &DEVC QUANTITY='{}'{}".format(
            quantity, " -- a surface temperature, not a gas temperature" if surface else "")
        if quantity else None,
    }


# -- the main conversion --------------------------------------------------

def to_plan(text: str, filename: Optional[str] = None,
            options: Optional[ImportOptions] = None) -> FdsImport:
    """Convert FDS input text into a plan, with a full account of the conversion."""
    opts = options or ImportOptions()
    records = namelist.read(text)
    if not records:
        raise PlanError("no FDS namelist records found -- is this an .fds input file?")

    by_group: Dict[str, List[Record]] = {}
    for rec in records:
        by_group.setdefault(rec.group, []).append(rec)

    issues: List[Issue] = []
    ids = _Ids()
    surfs = {r.string("ID"): r for r in by_group.get("SURF", []) if r.string("ID")}
    props = {r.string("ID"): r for r in by_group.get("PROP", []) if r.string("ID")}
    peaks = _peak_ramp(records)
    mults = _multipliers(records)

    # -- domain ----------------------------------------------------------
    meshes = [_sorted_xb(r.numbers("XB")) for r in by_group.get("MESH", []) if r.has("XB")]
    meshes = [m for m in meshes if len(m) == 6]
    domain: Optional[Xb] = None
    if meshes:
        domain = [min(m[0] for m in meshes), max(m[1] for m in meshes),
                  min(m[2] for m in meshes), max(m[3] for m in meshes),
                  min(m[4] for m in meshes), max(m[5] for m in meshes)]

    # -- the fire --------------------------------------------------------
    reac = (by_group.get("REAC") or [None])[0]
    obst_boxes = _boxes(records, "OBST", mults) if opts.geometry else []
    vent_boxes = [b for b in _boxes(records, "VENT", mults)
                  if not _is_domain_vent(b, domain)]
    heat_of_combustion = reac.number("HEAT_OF_COMBUSTION") if reac else None
    faces = _fire_faces(obst_boxes if opts.geometry else _boxes(records, "OBST", mults),
                        vent_boxes, surfs, peaks, heat_of_combustion)
    burner = _pick_burner(faces, opts.burner_surf)
    candidates = sorted({f.surf for f in faces})

    if burner is None:
        issues.append(Issue(
            "warning", "fds-no-fire",
            "no surface in this input releases heat, so the plan has no burner and "
            "its origin is the centre of the mesh. Add a burner, then move the "
            "geometry onto it -- every standoff and flame-height figure is measured "
            "from the burner centre."))
    elif len(candidates) > 1:
        issues.append(Issue(
            "info", "fds-fire-choice",
            "{} surfaces release heat ({}); '{}' was taken as the burner because it "
            "is the most compact horizontal one. The rest are burning surfaces the "
            "plan cannot represent."
            .format(len(candidates), ", ".join(candidates), burner.surf)))

    # -- origin and floor ------------------------------------------------
    slabs = [b for b in obst_boxes
             if _is_slab(b.xb) and not (burner is not None and b.xb == burner.xb)]
    if opts.floor_z_m is not None:
        floor_z, floor_rule = float(opts.floor_z_m), "the level you gave"
    else:
        floor_z, floor_rule = _detect_floor(slabs, burner, domain)

    if opts.origin_m is not None:
        ox, oy, oz = (float(v) for v in opts.origin_m)
    elif burner is not None:
        bx, by, _ = _centre(burner.xb)
        ox, oy, oz = bx, by, floor_z
    elif domain is not None:
        ox = (domain[0] + domain[1]) / 2.0
        oy = (domain[2] + domain[3]) / 2.0
        oz = floor_z
    else:
        ox = oy = oz = 0.0
    origin = (ox, oy, oz)

    if burner is not None and burner.xb[4] > floor_z + BURNER_PLATFORM_TOL_M:
        issues.append(Issue(
            "warning", "fds-burner-raised",
            "the burner's base is {:.2f} m above the floor, taken from {}. If it "
            "stands on a platform this is right; if the floor was detected wrongly "
            "every height in the plan is off by the same amount."
            .format(burner.xb[4] - floor_z, floor_rule)))

    # -- build the plan --------------------------------------------------
    head = (by_group.get("HEAD") or [None])[0]
    chid = head.string("CHID") if head else None
    fds_title = head.string("TITLE") if head else None
    # CHID, not TITLE: CHID is the job name and fits a toolbar and a drawing sheet,
    # while TITLE is free prose -- the sample input's is a 200-character paragraph.
    # The prose is kept, in the notes, where length costs nothing.
    plan = Plan.new(chid or (fds_title or "Imported FDS model")[:60])

    objects: List[Dict[str, Any]] = []
    walls: List[Tuple[Dict[str, Any], Xb]] = []

    if opts.geometry:
        floor_box = min(slabs, key=lambda s: s.xb[5]) if slabs else None
        if floor_box is not None and floor_box.xb[5] > floor_z + TOL_M:
            floor_box = None
        for box in obst_boxes:
            if burner is not None and box.xb == burner.xb and not burner.from_vent:
                continue                      # becomes the burner, below
            if box is floor_box:
                continue                      # the floor is the z = 0 plane, not an object
            obj = _geometry_object(box.xb, box.rec, origin, ids, surfs)
            if obj["type"] == "wall":
                walls.append((obj, box.xb))
            objects.append(obj)

        _apply_holes(_boxes(records, "HOLE", mults), walls, origin, issues)

    if burner is not None:
        objects.append(_burner_object(ids, burner, origin, floor_z, reac, surfs))

    device_groups: List[DeviceGroup] = []
    if opts.devices:
        objects.extend(_import_devices(
            by_group.get("DEVC", []), props, origin, opts, burner, floor_z,
            ids, device_groups, issues))

    plan.data["objects"] = objects

    # -- document-level fields ------------------------------------------
    meta = plan.meta
    if chid:
        meta["testId"] = chid
    notes = ["Imported from {}.".format(filename or "an FDS input")]
    if fds_title and fds_title != chid:
        notes.append("&HEAD TITLE: {}".format(fds_title))
    t_end = by_group.get("TIME", [None])[0]
    if t_end is not None and t_end.number("T_END") is not None:
        notes.append("Simulation T_END {:g} s.".format(t_end.number("T_END")))
    if burner is not None:
        notes.append("Origin is the '{}' surface centre; floor from {}."
                     .format(burner.surf, floor_rule))
    meta["notes"] = " ".join(notes)
    meta["source"] = {
        "tool": "FDS",
        "file": filename,
        "chid": chid,
        "importedAt": opts.imported_at or _utc_now_iso(),
        "originOffset_m": [ox, oy, oz],
    }

    env = plan.environment
    span = _plan_span(objects) or (
        [domain[0] - ox, domain[1] - ox, domain[2] - oy, domain[3] - oy]
        if domain is not None else None)
    if span is not None:
        # floorSize is centred on the origin, and the origin is the burner rather
        # than the middle of anything, so the plane has to reach the further side.
        # Sized on the objects rather than the mesh: an FDS domain is routinely far
        # larger than the compartment inside it -- three times larger, in the sample
        # input -- and a floor plane that size dwarfs the plan drawn on it.
        env["floorSize_m"] = [
            max(2.0 * max(abs(span[0]), abs(span[1])) + 2.0, 4.0),
            max(2.0 * max(abs(span[2]), abs(span[3])) + 2.0, 4.0),
        ]
    ceilings = [o for o in objects if o["type"] == "ceiling"]
    if ceilings:
        env["ceilingHeight_m"] = min(float(c["height_m"]) for c in ceilings)
    misc = (by_group.get("MISC") or [None])[0]
    if misc is not None and misc.number("TMPA") is not None:
        env["ambientTemperature_C"] = misc.number("TMPA")

    # A freshly built plan starts at the baseline version and would report
    # `version-understated` against its own contents until first saved. An import is
    # not an edit in progress, so it declares what it holds straight away.
    plan.data["version"] = plan.effective_version

    _report_skipped(by_group, issues)

    return FdsImport(plan=plan, issues=issues, devices=device_groups, origin_m=origin,
                     burner_surf=burner.surf if burner else None,
                     burner_candidates=candidates, source_file=filename)


def _is_domain_vent(box: _Box, domain: Optional[Xb]) -> bool:
    """A vent that is just a boundary condition on the edge of the mesh.

    `SURF_ID='OPEN'` and `MB='XMAX'` are how an FDS model says "the world continues
    past here". They are not geometry and they are not instruments."""
    if any(s == "OPEN" or s == "MIRROR" or s == "PERIODIC" for s in box.surfs):
        return True
    if domain is None:
        return False
    return any(abs(box.xb[i] - domain[i]) <= TOL_M and abs(box.xb[i ^ 1] - domain[i]) <= TOL_M
               for i in range(6))


def _burner_object(ids: _Ids, burner: _FireFace, origin: Sequence[float], floor_z: float,
                   reac: Optional[Record], surfs: Dict[str, Record]) -> Dict[str, Any]:
    ox, oy, oz = (float(v) for v in origin)
    dx, dy, _dz = _extent(burner.xb)
    cx, cy, _ = _centre(burner.xb)
    square = abs(dx - dy) <= TOL_M
    surf_rec = surfs.get(burner.surf)

    # The fuel surface is the face that burns: the top of a pan, the plane of a vent.
    fuel_z = burner.xb[5] if burner.face == "+z" else burner.xb[4]

    fuel = None
    if reac is not None:
        fuel = reac.string("FUEL") or reac.string("ID")
    if fuel:
        fuel = fuel.lower()

    fire: Dict[str, Any] = {"fuel": fuel, "hrr_kw": burner.hrr_kw, "hrrCurve": None}
    # Only when the input states it. FDS has its own default; adopting that here
    # would put a number the file never contained into a model that predicts every
    # gauge reading from it.
    chi_r = reac.number("RADIATIVE_FRACTION") if reac is not None else None
    if chi_r is not None:
        fire["radiativeFraction"] = chi_r

    obj: Dict[str, Any] = {
        "id": ids.make("burner", burner.surf), "type": "burner",
        "name": burner.surf or "Burner",
        "transform": {"position_m": [cx - ox, cy - oy, floor_z - oz]},
        "footprint": {"shape": "square" if square else "rectangle",
                      "size_m": [dx, dy]},
        "rimHeight_m": max(fuel_z - floor_z, 0.0),
        "fire": fire,
        "notes": "FDS &SURF ID='{}'".format(burner.surf),
    }
    # Absent, not null: `display` is an object or it is not there. A null one is
    # schema-invalid, and the editor reads absent as "use the type colour" anyway.
    color = _color_of(surf_rec) if surf_rec is not None else None
    if color:
        obj["display"] = {"color": color}
    return obj


def _apply_holes(holes: List[_Box], walls: List[Tuple[Dict[str, Any], Xb]],
                 origin: Sequence[float], issues: List[Issue]) -> None:
    """Turn each `&HOLE` into an opening in every wall it cuts.

    A hole in FDS is a subtraction from the solid, so a doorway is a hole through
    the wall obstruction rather than a property of the wall. This format has
    openings on the wall, positioned by arc length along its polyline, so the
    conversion is an overlap test -- which is also why a hole that misses every
    wall is reported instead of vanishing.
    """
    placed = 0
    for hole in holes:
        cut = False
        for wall, xb in walls:
            lo_x, hi_x = max(hole.xb[0], xb[0]), min(hole.xb[1], xb[1])
            lo_y, hi_y = max(hole.xb[2], xb[2]), min(hole.xb[3], xb[3])
            lo_z, hi_z = max(hole.xb[4], xb[4]), min(hole.xb[5], xb[5])
            if hi_x - lo_x <= TOL_M or hi_y - lo_y <= TOL_M or hi_z - lo_z <= TOL_M:
                continue
            along_x = (xb[1] - xb[0]) >= (xb[3] - xb[2])
            start = xb[0] if along_x else xb[2]
            lo, hi = (lo_x, hi_x) if along_x else (lo_y, hi_y)
            base = max(xb[4], float(origin[2]))
            opening: Dict[str, Any] = {
                "offset_m": lo - start,
                "width_m": hi - lo,
                "height_m": hi_z - max(lo_z, base),
                "sillHeight_m": max(lo_z - base, 0.0),
            }
            if hole.name:
                opening["id"] = hole.name
            wall["openings"].append(opening)
            cut = True
            placed += 1
        if not cut:
            issues.append(Issue(
                "info", "fds-hole-unmatched",
                "&HOLE at line {} cuts nothing this plan holds -- it opens a slab or "
                "a solid block, and only walls carry openings here.".format(hole.rec.line)))
    if placed:
        issues.append(Issue("info", "fds-holes",
                            "{} wall opening(s) came from &HOLE.".format(placed)))


def _import_devices(records: List[Record], props: Dict[str, Record],
                    origin: Sequence[float], opts: ImportOptions,
                    burner: Optional[_FireFace], floor_z: float, ids: _Ids,
                    groups: List[DeviceGroup], issues: List[Issue]) -> List[Dict[str, Any]]:
    mapping = dict(default_device_map())
    if opts.device_map:
        mapping.update({k.upper(): v for k, v in opts.device_map.items()})

    ox, oy, oz = (float(v) for v in origin)
    aim: Optional[List[float]] = None
    if burner is not None:
        bx, by, _ = _centre(burner.xb)
        aim = [bx - ox, by - oy, max(burner.xb[5] - floor_z, 0.0) + 0.3]

    # Bucket by quantity first: the preview reports per quantity, and rake grouping
    # must never merge a thermocouple with a wall temperature that shares its point.
    buckets: Dict[str, List[Tuple[Record, Optional[float]]]] = {}
    order: List[str] = []
    for rec in records:
        quantity, diameter = _device_quantity(rec, props)
        key = (quantity or "").upper()
        if key not in buckets:
            buckets[key] = []
            order.append(key)
        buckets[key].append((rec, diameter))

    objects: List[Dict[str, Any]] = []
    for key in order:
        members = buckets[key]
        kind = mapping.get(key)
        group = DeviceGroup(quantity=key or None, count=len(members), mapped_to=kind)
        groups.append(group)
        if kind is None:
            group.note = "no counterpart in a test plan"
            continue

        positioned = [(r, d) for r, d in members if len(r.numbers("XYZ")) == 3]
        if len(positioned) < len(members):
            group.note = "{} of them have no XYZ (a region or a global quantity)".format(
                len(members) - len(positioned))

        if kind == "thermocouple" and opts.group_rakes:
            made = _grouped_rakes(positioned, origin, ids, key)
        else:
            made = []
            for rec, diameter in positioned:
                pos = [v - o for v, o in zip(rec.numbers("XYZ"), (ox, oy, oz))]
                name = rec.string("ID")
                if kind == "heatFluxSensor":
                    made.append(_gauge_object(ids, name, pos, _device_normal(rec), aim, key))
                else:
                    made.append(_rake_object(ids, name, pos, [0.0], diameter, key))
        group.objects = len(made)
        objects.extend(made)

        if kind == "thermocouple" and opts.group_rakes and len(made) < len(positioned):
            issues.append(Issue(
                "info", "fds-rake-grouped",
                "{} '{}' devices became {} rake(s): a vertical run at one XY is one "
                "instrument with several beads here, not several instruments."
                .format(len(positioned), key, len(made))))

    gauges = sum(g.objects for g in groups if g.mapped_to == "heatFluxSensor")
    if gauges:
        issues.append(Issue(
            "warning", "fds-gauge-range",
            "{} heat flux gauge(s) arrived without a full-scale range -- FDS reports a "
            "flux at a point and has no gauge to over-range. Set a range on each to "
            "get an over-range or low-signal verdict.".format(gauges)))
    return objects


def _grouped_rakes(members: List[Tuple[Record, Optional[float]]], origin: Sequence[float],
                   ids: _Ids, quantity: str) -> List[Dict[str, Any]]:
    """Collapse vertical runs at a common XY into one rake each.

    Only vertical runs. A rake's beads lie along its local +Z, so a horizontal row
    would have to be a rotated object, and a rotated rake reads correctly in the 3D
    view but not in the elevations (CONVENTIONS section 5a). Twenty-two separate
    objects is untidy; twenty-two objects drawn in the wrong place is wrong.
    """
    ox, oy, oz = (float(v) for v in origin)
    by_xy: Dict[Tuple[float, float, Any], List[Tuple[Record, Optional[float]]]] = {}
    order: List[Tuple[float, float, Any]] = []
    for rec, diameter in members:
        xyz = rec.numbers("XYZ")
        key = (round(xyz[0], 4), round(xyz[1], 4), rec.number("IOR"))
        if key not in by_xy:
            by_xy[key] = []
            order.append(key)
        by_xy[key].append((rec, diameter))

    out: List[Dict[str, Any]] = []
    for key in order:
        run = sorted(by_xy[key], key=lambda pair: pair[0].numbers("XYZ")[2])
        first = run[0][0]
        z0 = first.numbers("XYZ")[2]
        position = [key[0] - ox, key[1] - oy, z0 - oz]
        offsets = [r.numbers("XYZ")[2] - z0 for r, _ in run]
        diameter = next((d for _, d in run if d), None)
        if len(run) == 1:
            name = first.string("ID")
        else:
            first_id, last_id = first.string("ID"), run[-1][0].string("ID")
            name = "{}-{}".format(first_id, last_id) if first_id and last_id else None
        out.append(_rake_object(ids, name, position, offsets, diameter, quantity))
    return out


#: Records this format has no counterpart for. Named individually so the report
#: says what was in the file rather than "some things were skipped".
_SKIPPED = {
    "MESH": "the computational grid",
    "MATL": "material thermal properties",
    "SPEC": "gas species",
    "SLCF": "slice file output",
    "BNDF": "boundary file output",
    "ISOF": "isosurface output",
    "PART": "Lagrangian particles",
    "DUMP": "output control",
    "TRNX": "mesh stretching", "TRNY": "mesh stretching", "TRNZ": "mesh stretching",
    "PRES": "pressure solver settings",
    "RADI": "radiation solver settings",
    "CTRL": "control logic",
    "ZONE": "pressure zones",
    "INIT": "initial conditions",
    "PROF": "profile output",
    "SM3D": "smoke3d output",
    "OBST": "", "VENT": "", "HOLE": "", "DEVC": "", "PROP": "", "SURF": "",
    "RAMP": "", "REAC": "", "HEAD": "", "TIME": "", "TAIL": "", "MULT": "",
    "MISC": "", "CATF": "",
}


def _report_skipped(by_group: Dict[str, List[Record]], issues: List[Issue]) -> None:
    parts = []
    for group, records in sorted(by_group.items()):
        why = _SKIPPED.get(group)
        if why:
            parts.append("&{} x{} ({})".format(group, len(records), why))
        elif why is None:
            parts.append("&{} x{}".format(group, len(records)))
    if parts:
        issues.append(Issue(
            "info", "fds-not-imported",
            "Simulation-only records, left behind: " + ", ".join(parts) + "."))


def _plan_span(objects: List[Dict[str, Any]]) -> Optional[List[float]]:
    """`[x0, x1, y0, y1]` covering every object's plan footprint, in plan coordinates."""
    xs: List[float] = []
    ys: List[float] = []
    for obj in objects:
        pos = (obj.get("transform") or {}).get("position_m") or [0.0, 0.0, 0.0]
        for key in ("polyline_m", "polygon_m"):
            for x, y in obj.get(key, []) or []:
                xs.append(pos[0] + x)
                ys.append(pos[1] + y)
        if obj["type"] == "obstruction":
            xs.extend([pos[0] - obj["size_m"][0] / 2, pos[0] + obj["size_m"][0] / 2])
            ys.extend([pos[1] - obj["size_m"][1] / 2, pos[1] + obj["size_m"][1] / 2])
        elif obj["type"] in ("burner", "heatFluxSensor", "thermocouple", "camera"):
            xs.append(pos[0])
            ys.append(pos[1])
    if not xs:
        return None
    return [min(xs), max(xs), min(ys), max(ys)]


def load(path, options: Optional[ImportOptions] = None) -> FdsImport:
    """Read an FDS input file -- and anything it `&CATF`s in -- as a plan."""
    text, issues = _read_source(str(path))
    result = to_plan(text, filename=os.path.basename(str(path)), options=options)
    result.issues = issues + result.issues
    return result
