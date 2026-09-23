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
covering the records the mapping dropped and the judgements it had to make: which
heat-release surface was taken to be the burner, which `&HOLE` cut nothing, which
`&DEVC` quantity has no counterpart. Per-object classification -- this box became a
wall, that one a ceiling -- is reported as counts in the import preview rather than
one issue per object, because a model with two hundred obstructions would bury
everything else. An import that quietly loses half a model is worse than one that
refuses, so this one neither loses nor refuses: it converts and then says what it
did.
"""

from __future__ import annotations

import dataclasses
import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from . import namelist, serialize
from ._text import js_to_fixed
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

#: What a zero-thickness `&OBST` is drawn as. FDS allows an obstruction with no
#: thickness -- glazing, a thin partition, a shelf -- and real models are full of
#: them. This format has no planar object, and a box with a zero extent is one the
#: editor refuses to open, so the plate is given a nominal thickness and the import
#: says so. 10 mm reads as a plate and can still be picked in the viewport.
THIN_M = 0.01

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
    # FDS 6's current name for NET HEAT FLUX, and the old name of GAUGE HEAT FLUX.
    "TOTAL HEAT FLUX", "GAUGE HEAT FLUX GAS",
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

#: The record groups a single pasted record can become. Both converters check the
#: group before the fields: `&MESH`, `&INIT` and `&SLCF` all carry an `XB`, and
#: `&SLCF` carries a `QUANTITY` and an `XYZ` as well. `&VENT` is deliberately not
#: here: a vent is a boundary condition on the face of a solid, not a solid, and the
#: full import never turns one into geometry either -- it only ever reads one as a
#: fire. Pasting one used to produce a box with a zero extent that the editor then
#: refused to reopen.
GEOMETRY_GROUPS = ("OBST",)
DEVICE_GROUP = "DEVC"

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
    #: Whether `&CATF` includes were already spliced into `text`. `load` resolves
    #: them against the file's own folder and says so; a caller converting bare text
    #: cannot, and gets told that its includes went unread.
    includes_resolved: bool = False
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


def _xb_of(rec: Record) -> Optional[Xb]:
    """This record's `XB`, sorted -- or None if it does not have six numbers.

    The count is checked *before* anything indexes the list. `&OBST XB=0,1,2 /` is
    a half-finished hand edit, and a whole import that stops with an IndexError
    tells the reader nothing about which line to look at; skipping the record and
    saying so is the behaviour the rest of this module promises, and the one the
    TypeScript mirror already had.
    """
    raw = rec.numbers("XB")
    return _sorted_xb(raw) if len(raw) == 6 else None


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
    """The `SURF_ID` of each of the six faces, in `FACES` order.

    FDS's three spellings, each overriding the one before for the faces it names:
    `SURF_ID` for every face; `SURF_IDS` for the top, the sides and the bottom;
    `SURF_ID6` face by face. Mirror of `faceSurfs` in web/src/core/fds.ts.
    """
    one = rec.string("SURF_ID")
    faces: List[Optional[str]] = [one] * 6
    ids = rec.strings("SURF_IDS") + [None, None, None]
    top, sides, bottom = ids[0], ids[1], ids[2]
    if top:
        faces[5] = top
    if sides:
        faces[0:4] = [sides] * 4
    if bottom:
        faces[4] = bottom
    for i, s in enumerate(rec.strings("SURF_ID6")[:6]):
        if s:
            faces[i] = s
    return faces


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class _Ids:
    """Unique, readable object ids -- an FDS `ID` where there is one, else a counter."""

    def __init__(self) -> None:
        self.used: Dict[str, int] = {}
        self.taken: set = set()

    def make(self, prefix: str, name: Optional[str] = None) -> str:
        """The next id for `prefix` and `name`, never one already handed out.

        Counting per base alone let two bases meet: an unnamed box is `obst-1` and a
        box with `ID='1'` is `obst-1` too; the second of two `Col` copies is
        `obst-col-2` and so is `ID='Col 2'`. Mirror of `Ids.make` in fds.ts.
        """
        base = "{}-{}".format(prefix, _slug(name)) if name else prefix
        n = self.used.get(base, 0)
        candidate = base if n == 0 and name else "{}-{}".format(base, n + 1)
        while candidate in self.taken:
            n += 1
            candidate = "{}-{}".format(base, n + 1)
        self.used[base] = n + 1
        self.taken.add(candidate)
        return candidate


# -- reading the file, including its includes -----------------------------



def _file_key(path: str) -> str:
    """One spelling per file: resolved, and case-blind where the filesystem is."""
    return os.path.normcase(os.path.realpath(path))


def _read_text(path: str) -> Tuple[Optional[str], Optional[Issue]]:
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            return fh.read(), None
    except OSError as exc:
        # A &CATF naming a directory, a file that vanished between the check and the
        # open, or one the user cannot read. None of those is a reason to abandon a
        # model whose other half is perfectly readable.
        return None, Issue("warning", "fds-catf-unreadable",
                           "&CATF names {} but it could not be read ({}); anything it "
                           "defined is missing from this plan"
                           .format(os.path.basename(path), exc.strerror or exc))


def _as_included(child: str, name: str, issues: List[Issue]) -> str:
    """An included file as FDS copies it into the run (COPY_FILE_TO_CAT, read.f90):
    its `&HEAD` left out, and nothing past its first `&TAIL` or `&CATF`, where FDS
    stops copying it. A child's `&TAIL` ends the child, not the model, and a child's
    own `&CATF` is never read. Mirror of `asIncluded` in web/src/io/files.ts."""
    records = namelist.read(child)
    stop = next((r for r in records if r.group in ("TAIL", "CATF")), None)
    end = stop.start if stop is not None else len(child)
    if stop is not None and stop.group == "CATF":
        issues.append(Issue(
            "info", "fds-catf-nested",
            "{} includes further files with &CATF; FDS stops copying an included file at "
            "its own &CATF line and never reads nested includes, so neither does this "
            "import".format(name)))
    elif stop is not None and re.search(r"^[ \t]*&", child[stop.end:], re.M):
        issues.append(Issue(
            "info", "fds-catf-tail",
            "the included file {} has records after its &TAIL; FDS copies an included "
            "file only up to its &TAIL, and so does this import".format(name)))
    pieces: List[str] = []
    pos = 0
    for rec in records:
        if rec.start >= end:
            break
        if rec.group != "HEAD":
            continue
        pieces.append(child[pos:rec.start])
        pos = rec.end
    pieces.append(child[pos:end])
    return "".join(pieces)


def _read_source(path: str) -> Tuple[str, List[Issue]]:
    """The file's text with its `&CATF` includes spliced in **where they sit**, as
    FDS splices them.

    FDS's `&CATF` splices other files into the input, and split inputs are normal in
    anything bigger than a demonstration case -- a geometry file plus a devices file
    is the usual shape. Reading only the named file would import a model with no
    geometry and no obvious reason why.

    The position matters as much as the content. `&CATF` belongs in the body of the
    input, before `&TAIL` -- that is where the official validation cases put it --
    and reading stops at `&TAIL`, so a child appended after the parent's last line
    is a child nobody reads. Each child goes through `_as_included`: FDS reads only
    the top-level file's includes. Mirror of `spliceFdsIncludes` in files.ts.
    """
    real = os.path.abspath(path)
    # The input itself: a file that is not there is the caller's error, and saying
    # "no FDS namelist records found" about it sent people looking in the wrong place.
    with open(real, "r", encoding="utf-8-sig", errors="replace") as fh:
        text = fh.read()
    own = _file_key(real)

    issues: List[Issue] = []
    seen: set = set()
    pieces: List[str] = []
    pos = 0
    for rec in namelist.read(text):
        if rec.group != "CATF":
            continue
        included: List[str] = []
        for other in rec.strings("OTHER_FILES"):
            if not other:
                continue
            child = other if os.path.isabs(other) else os.path.join(os.path.dirname(real), other)
            key = _file_key(child)
            if key == own:
                issues.append(Issue("warning", "fds-catf-cycle",
                                    "&CATF includes {} from inside itself; the repeat was "
                                    "skipped".format(other)))
                continue
            if key in seen:
                # Two &CATF names for one file, which FDS would splice twice. Once is
                # enough here -- the second copy could only redefine what the first said.
                issues.append(Issue("info", "fds-catf-repeat",
                                    "{} is included more than once; it was read the first "
                                    "time".format(other)))
                continue
            seen.add(key)
            if not os.path.exists(child):
                issues.append(Issue("warning", "fds-catf-missing",
                                    "&CATF names {} but it is not beside the input; "
                                    "anything it defined is missing from this plan"
                                    .format(other)))
                continue
            child_text, problem = _read_text(child)
            if child_text is None:
                issues.append(problem)
                continue
            included.append(_as_included(child_text, other, issues))
        if included:
            pieces.append(text[pos:rec.end])
            pieces.append("\n" + "\n".join(included) + "\n")
            pos = rec.end

    pieces.append(text[pos:])
    return "".join(pieces), issues


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


#: FDS's TWENTY_EPSILON_EB: a DX smaller than this does not override DXB.
_MULT_EPS = 20 * 2.220446049250313e-16


def _expand_mult(xb: Xb, mult: Optional[Record]) -> List[Xb]:
    """Every copy `&MULT` asks for, including the original -- as FDS builds them.

    A transcription of `READ_MULT` and the copy loop in `READ_OBST`/`READ_MESH`
    (firemodels/fds Source/read.f90); see `expandMult` in web/src/core/fds.ts for
    the rules and why each matters. In short: `DX`/`DY`/`DZ` override `DXB` pairs in
    both forms; the form is sequential whenever `N_LOWER` or `N_UPPER` is non-zero;
    `DX0`/`DY0`/`DZ0` offset every copy; skip bounds default to -999/999 and the
    hole is the box between them and the array's own bounds; copies come out K,
    then J, then I.
    """
    if mult is None:
        return [list(xb)]

    def whole(key: str, fallback: int) -> int:
        v = mult.number(key)
        return fallback if v is None else int(math.trunc(v))

    dxb = [0.0] * 6
    # By position: a null repeat (`DXB=2*,1,1,2*`) leaves those entries at zero.
    for k, v in enumerate(mult.number_list("DXB")[:6]):
        if v is None:
            continue
        dxb[k] = v
    for key, pair in (("DX", 0), ("DY", 2), ("DZ", 4)):
        d = mult.number(key) or 0.0
        if abs(d) > _MULT_EPS:
            dxb[pair] = dxb[pair + 1] = d
    offset = [mult.number("DX0") or 0.0, mult.number("DY0") or 0.0, mult.number("DZ0") or 0.0]

    n_lower, n_upper = whole("N_LOWER", 0), whole("N_UPPER", 0)
    sequential = n_lower != 0 or n_upper != 0
    if sequential:
        lower, upper, first = [n_lower, 0, 0], [n_upper, 0, 0], "N"
    else:
        lower = [whole("I_LOWER", 0), whole("J_LOWER", 0), whole("K_LOWER", 0)]
        upper = [whole("I_UPPER", 0), whole("J_UPPER", 0), whole("K_UPPER", 0)]
        first = "I"
    lower_skip = [whole(first + "_LOWER_SKIP", -999), whole("J_LOWER_SKIP", -999),
                  whole("K_LOWER_SKIP", -999)]
    upper_skip = [whole(first + "_UPPER_SKIP", 999), whole("J_UPPER_SKIP", 999),
                  whole("K_UPPER_SKIP", 999)]
    skipping = any(lower_skip[a] >= lower[a] or upper_skip[a] <= upper[a] for a in range(3))
    hole_low = [max(lower[a], lower_skip[a]) for a in range(3)]
    hole_high = [min(upper[a], upper_skip[a]) for a in range(3)]

    out = []
    for k in range(lower[2], upper[2] + 1):
        for j in range(lower[1], upper[1] + 1):
            for i in range(lower[0], upper[0] + 1):
                if skipping and all(hole_low[a] <= v <= hole_high[a] for a, v in enumerate((i, j, k))):
                    continue
                step = (i, i, i) if sequential else (i, j, k)
                out.append([xb[n] + offset[n // 2] + step[n // 2] * dxb[n] for n in range(6)])
    return out


def _mesh_boxes(records: List[Record], mults: Dict[str, Record]) -> List[Xb]:
    """Every `&MESH` box, `&MULT` expanded.

    The domain is what the origin falls back to when nothing in the file burns, so
    a `MULT_ID` on a mesh that this reader ignored would shift every coordinate in
    the plan by whatever the multiplied domain does not cover.
    """
    out: List[Xb] = []
    for rec in records:
        if rec.group != "MESH":
            continue
        xb = _xb_of(rec)
        if xb is None:
            continue
        mult = mults.get(rec.string("MULT_ID") or "")
        out.extend(_sorted_xb(copy) for copy in _expand_mult(xb, mult))
    return out


def _boxes(records: List[Record], group: str, mults: Dict[str, Record]) -> List[_Box]:
    out: List[_Box] = []
    for rec in records:
        if rec.group != group:
            continue
        xb = _xb_of(rec)
        if xb is None:
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


def _states_heat(rec: Optional[Record]) -> bool:
    """Whether this `&SURF` names a heat release rate at all.

    Deliberately blind to ramps: this answers "is this a fire surface", which is
    what decides whether a vent is a boundary condition or a burner, not "how big
    is the fire", which is :func:`_fire_faces`'s question.
    """
    return rec is not None and bool(rec.number("HRRPUA") or rec.number("MLRPUA"))


def _vent_orientation(xb: Xb, rec: Record, obsts: List[_Box],
                      domain: Optional[Xb]) -> Optional[str]:
    """Which way a `&VENT` faces: ``'+z'``, ``'-z'``, ``'+x'`` and so on, or None
    when the box is not a plane at all.

    A vent is a face on a solid, and FDS decides its orientation from which side
    the solid is on -- or from an explicit `IOR`, whose sign is the direction of the
    surface normal. This reader has no solver, so it does the same by inspection:
    `IOR` when stated; otherwise the obstruction the vent lies on (a vent on a box's
    top face burns upward, one on its underside burns downward); otherwise the mesh
    boundary (the domain floor faces up, the domain ceiling faces down). Reading
    every horizontal vent as upward turned a fire on the underside of a ceiling
    into an upward-burning pan three metres high. Mirror of `ventOrientation` in
    web/src/core/fds.ts.
    """
    dx, dy, dz = _extent(xb)
    if dz <= TOL_M:
        axis = "z"
    elif dy <= TOL_M:
        axis = "y"
    elif dx <= TOL_M:
        axis = "x"
    else:
        return None

    ior = rec.number("IOR")
    if ior is not None and int(ior) != 0:
        return ("+" if ior > 0 else "-") + axis

    lo = {"x": 0, "y": 2, "z": 4}[axis]
    plane = xb[lo]
    in_plane = [i for i in (0, 2, 4) if i != lo]

    def within(box: Xb) -> bool:
        # The vent has to lie within the face it sits on, in the two in-plane axes.
        return all(xb[i] >= box[i] - TOL_M and xb[i + 1] <= box[i + 1] + TOL_M
                   for i in in_plane)

    on_high_face = on_low_face = False
    for box in obsts:
        if not within(box.xb):
            continue
        if abs(plane - box.xb[lo + 1]) <= TOL_M:
            on_high_face = True
        if abs(plane - box.xb[lo]) <= TOL_M:
            on_low_face = True
    if on_high_face and not on_low_face:
        return "+" + axis
    if on_low_face and not on_high_face:
        return "-" + axis
    if domain is not None:
        if abs(plane - domain[lo]) <= TOL_M:
            return "+" + axis
        if abs(plane - domain[lo + 1]) <= TOL_M:
            return "-" + axis
    # Nothing establishes it -- a vent floating in the domain, which FDS itself
    # would reject -- so the positive side stands, as it always has.
    return "+" + axis


def _union_area(rects: List[Tuple[float, float, float, float]]) -> float:
    """Area of the union of axis-aligned rectangles ``(u0, u1, v0, v1)``: strips
    between consecutive u edges, each with its merged v cover. Mirror of
    ``unionArea`` in fds.ts, step for step, so both engines subtract the same double."""
    us = sorted(set(x for r in rects for x in (r[0], r[1])))
    total = 0.0
    for i in range(len(us) - 1):
        a, b = us[i], us[i + 1]
        spans = sorted((r[2], r[3]) for r in rects if r[0] <= a and r[1] >= b)
        covered = 0.0
        lo = hi = 0.0
        is_open = False
        for s, e in spans:
            if not is_open or s > hi:
                if is_open:
                    covered += hi - lo
                lo, hi = s, e
                is_open = True
            elif e > hi:
                hi = e
        if is_open:
            covered += hi - lo
        total += (b - a) * covered
    return total


def _exposed_area(box: "_Box", face: str, area: float, boxes: List["_Box"]) -> float:
    """What is left of a box's face once other obstructions are taken off it.

    FDS burns a surface only where gas touches it. Another box sitting flush against
    the face, or running through its plane, covers that part -- two touching burning
    boxes share a face that burns on neither side. Mirror of ``exposedArea`` in fds.ts.
    """
    axis = 0 if face[1] == "x" else (2 if face[1] == "y" else 4)
    high = face[0] == "+"
    plane = box.xb[axis + 1] if high else box.xb[axis]
    u, v = [i for i in (0, 2, 4) if i != axis]
    rects: List[Tuple[float, float, float, float]] = []
    for other in boxes:
        if other is box:
            continue
        o = other.xb
        if high:
            covers = o[axis] <= plane + TOL_M and o[axis + 1] > plane + TOL_M
        else:
            covers = o[axis + 1] >= plane - TOL_M and o[axis] < plane - TOL_M
        if not covers:
            continue
        u0, u1 = max(box.xb[u], o[u]), min(box.xb[u + 1], o[u + 1])
        v0, v1 = max(box.xb[v], o[v]), min(box.xb[v + 1], o[v + 1])
        if u1 - u0 > TOL_M and v1 - v0 > TOL_M:
            rects.append((u0, u1, v0, v1))
    return area if not rects else max(0.0, area - _union_area(rects))


def _fire_faces(boxes: List[_Box], vents: List[_Box], surfs: Dict[str, Record],
                peaks: Dict[str, float], heat_of_combustion: Optional[float],
                issues: List[Issue], domain: Optional[Xb] = None) -> List[_FireFace]:
    """Every surface in the model that releases heat.

    A model can easily have several: the sample input has a 7500 kW/m2 ignition
    source *and* a 300 kW/m2 burning wall lining. Both are found; which one becomes
    the plan's burner is decided separately, and is overridable.
    """
    off: List[str] = []
    unknown: List[str] = []

    def released(surf_id: Optional[str]) -> Optional[Tuple[Optional[float], str]]:
        rec = surfs.get(surf_id or "")
        if rec is None:
            return None
        # `in`, not `or 1.0`: a ramp whose peak really is zero is a surface the
        # input switches off, and reading that as "no ramp, so full power" turns a
        # cold burner into the largest fire in the file.
        ramp = rec.string("RAMP_Q") or ""
        peak = peaks[ramp] if ramp in peaks else 1.0
        if peak <= 0.0:
            if surf_id and surf_id not in off:
                off.append(str(surf_id))
            return None
        hrrpua = rec.number("HRRPUA")
        if hrrpua:
            return hrrpua * peak, "HRRPUA"
        mlrpua = rec.number("MLRPUA")
        hoc = rec.number("HEAT_OF_COMBUSTION", heat_of_combustion)
        if mlrpua and hoc:
            # kg/m2/s x kJ/kg = kW/m2
            return mlrpua * hoc * peak, "MLRPUA"
        if mlrpua:
            # A mass loss rate with no heat of combustion stated: still the fire, at a
            # rate the file does not give. Mirror of fds.ts.
            if surf_id and surf_id not in unknown:
                unknown.append(str(surf_id))
            return None, "MLRPUA"
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
            # A vent is a plane: whichever extent is degenerate names its axis, the
            # solid it sits on (or its IOR) names the side, and the other two
            # extents give its area, whatever SURF_ID6 slot it arrived in.
            if from_vent:
                oriented = _vent_orientation(box.xb, box.rec, boxes, domain)
                if oriented is not None:
                    face = oriented
                    axis = oriented[1]
                    area = dx * dy if axis == "z" else (dx * dz if axis == "y" else dy * dz)
            else:
                area = _exposed_area(box, face, area, boxes)
            out.append(_FireFace(
                surf=str(surf_id), xb=box.xb, area_m2=area,
                hrr_kw=rel[0] * area if rel[0] is not None and area > 0 else None,
                face=face, horizontal=face in ("-z", "+z"), from_vent=from_vent))
    if unknown:
        issues.append(Issue(
            "warning", "fds-hrr-unknown",
            "{} state{} MLRPUA but no HEAT_OF_COMBUSTION, on the &SURF or the &REAC, so "
            "the heat release rate is not in the file. It was imported as a fire with no "
            "HRR; set one before relying on the flame and instrument predictions."
            .format(", ".join("'" + x + "'" for x in unknown), "s" if len(unknown) == 1 else "")))
    if off:
        issues.append(Issue(
            "warning", "fds-surface-off",
            "{} release{} no heat in this input: the &RAMP on RAMP_Q never leaves "
            "zero, so the surface is switched off. It was not imported as a fire."
            .format(", ".join("'" + x + "'" for x in off), "s" if len(off) == 1 else "")))
    return out


def _can_be_burner(face: _FireFace) -> bool:
    """Whether this heat-release face can be *the* burner of a plan.

    A burner here is a floor-standing source: a footprint in plan, a rim height
    measured up from the floor, and a fuel surface on top. Three kinds of burning
    face are not that, and each one produces nonsense if it is forced to be:

    * **A vertical face** -- a wall lining -- has no plan footprint at all. Its
      `size_m` comes out `[w, 0]`, which the editor's own load boundary rejects.
    * **A downward-facing face** -- a ceiling soffit, which is where a lining fire
      in a compartment test usually is -- has a footprint, and that is what makes it
      dangerous: `rimHeight_m` becomes the height of the ceiling, so the burner is a
      solid box the size of the room reaching from the floor to the soffit. It fills
      the room, hides everything inside it, and z-fights with every wall it shares a
      face with.
    * **A degenerate horizontal face** has an area but no thickness in plan.

    All three are reported as burning surfaces instead, which is what they are.
    """
    dx, dy, _ = _extent(face.xb)
    return face.face == "+z" and dx > TOL_M and dy > TOL_M


def _pick_burner(faces: List[_FireFace], wanted: Optional[str]) -> Optional[_FireFace]:
    """The heat-release face to treat as the plan's burner.

    Horizontal only, then smallest: a burning wall lining is not a burner -- and
    cannot be one here, having no plan footprint (:func:`_can_be_burner`) -- and
    when a model has both an ignition source and a spreading fire the ignition
    source is the compact one. The caller can name a `SURF` instead, and the import
    preview lists every candidate so the choice is visible rather than implicit.
    """
    usable = [f for f in faces if _can_be_burner(f)]
    if not usable:
        return None
    if wanted:
        named = [f for f in usable if f.surf == wanted]
        if named:
            return min(named, key=lambda f: f.area_m2)
    return min(usable, key=lambda f: f.area_m2)


def _burner_faces(faces: List[_FireFace], picked: Optional[_FireFace]) -> List[_FireFace]:
    """Every face that becomes a burner object: the picked one, then its siblings.

    One `&SURF` is routinely applied to several `&VENT`s -- two burners in a room,
    a row of sand-box fires -- and taking only the first would drop a fire source
    from the plan while reporting the conversion as complete. Format 1.2 holds
    several burners and calls the one at the origin the primary (CONVENTIONS
    section 1), which is exactly this: the picked face defines the frame, and its
    siblings are objects standing where the file puts them.

    Only the picked surface's own faces. A second heat-release *surface* is a
    different judgement -- the sample input's burning wall lining is not a second
    burner -- and that one stays a reported choice rather than a silent import.
    """
    if picked is None:
        return []
    out = [picked]
    for face in faces:
        if face.surf != picked.surf or not _can_be_burner(face):
            continue
        if any(face.xb == other.xb for other in out):
            continue          # another face of a box already taken as a burner
        out.append(face)
    return out


# -- geometry classification ----------------------------------------------

def _is_slab(xb: Xb) -> bool:
    dx, dy, dz = _extent(xb)
    return dz <= SLAB_ASPECT * min(dx, dy) and min(dx, dy) > TOL_M


def _is_wall(xb: Xb) -> bool:
    dx, dy, dz = _extent(xb)
    thin, long_ = min(dx, dy), max(dx, dy)
    return thin <= WALL_ASPECT * long_ and thin <= WALL_ASPECT * dz


#: A box is a burner's pan, not a floor, when the fire vent covers a good part of its
#: top: at most this many times the vent's plan area. Mirror of PAN_AREA_RATIO.
PAN_AREA_RATIO = 4.0


def _burner_pans(faces: List[_FireFace], obsts: List[_Box]) -> List[_Box]:
    """The boxes the burner vents sit on: the pans. Mirror of `burnerPans` in
    web/src/core/fds.ts -- a pan with a fire &VENT on top is part of the burner, not
    the floor; a large slab under a small vent is a floor with a fire on it."""
    out: List[_Box] = []
    for face in faces:
        if not face.from_vent or face.face != "+z":
            continue
        fx, fy, _ = _extent(face.xb)
        for box in obsts:
            bx, by, _ = _extent(box.xb)
            on_top = (abs(face.xb[4] - box.xb[5]) <= TOL_M
                      and face.xb[0] >= box.xb[0] - TOL_M and face.xb[1] <= box.xb[1] + TOL_M
                      and face.xb[2] >= box.xb[2] - TOL_M and face.xb[3] <= box.xb[3] + TOL_M)
            if on_top and bx * by <= PAN_AREA_RATIO * fx * fy and not any(box is p for p in out):
                out.append(box)
    return out


def _detect_floor(slabs: List[_Box], burner_base: Optional[float],
                  domain: Optional[Xb]) -> Tuple[float, str]:
    """Floor level, and the rule that produced it.

    The lowest horizontal slab's TOP face -- the surface things stand on -- rather
    than the bottom of the mesh. The distinction is not academic: the sample input's
    meshes start at z = -0.2 while its floor slab's top is at z = 0, so taking the
    mesh would put every height in the plan 200 mm out and leave the burner floating.
    """
    # With a burner, only a slab UNDER it can be the floor. Falling back to every
    # slab when none qualifies took the one slab in the model -- an overhead
    # ceiling -- as the floor, put the origin at its top, dropped it from the plan
    # as floor geometry and left every device two metres below ground.
    if burner_base is None:
        candidates = list(slabs)
    else:
        candidates = [s for s in slabs if s.xb[5] <= burner_base + BURNER_PLATFORM_TOL_M]
    if candidates:
        lowest = min(candidates, key=lambda s: s.xb[5])
        return lowest.xb[5], "the top of the lowest horizontal slab"
    if burner_base is not None:
        return burner_base, _FLOOR_FROM_BURNER
    if domain is not None:
        return domain[4], "the bottom of the mesh"
    return 0.0, "z = 0"


#: The rule `_detect_floor` reports when it took the burner's own base as the floor.
_FLOOR_FROM_BURNER = "the base of the burner"


# -- single-record conversion, shared with the editor's paste box ----------

def obstruction_from_record(rec: Record, origin: Sequence[float] = (0.0, 0.0, 0.0),
                            ids: Optional[_Ids] = None,
                            surfs: Optional[Dict[str, Record]] = None) -> Optional[Dict[str, Any]]:
    """One `&OBST` or `&VENT` as a plan object, with no model around it.

    This is what the editor's "create from FDS text" box calls, so a pasted `&OBST`
    lands as the same wall the full importer would have produced -- one
    classification rule, not two that drift.

    The group is checked, not just the fields. `&MESH`, `&INIT`, `&SLCF` and a
    dozen others carry an `XB` too, and turning a computational mesh into a wall
    because it has six numbers is a worse answer than refusing it.
    """
    if rec.group not in GEOMETRY_GROUPS:
        return None
    xb = _xb_of(rec)
    if xb is None:
        return None
    return _geometry_object(xb, rec, origin, ids or _Ids(), surfs or {})


def _geometry_object(xb: Xb, rec: Record, origin: Sequence[float], ids: _Ids,
                     surfs: Dict[str, Record],
                     stats: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """A box -- classified, re-origined and named -- as a wall, ceiling or obstruction.

    Takes the `XB` separately from the record so a `&MULT` copy converts through
    exactly this path rather than a parallel one.

    An extent of zero -- FDS's thin obstruction -- becomes `THIN_M`, and is counted
    in ``stats["thin"]`` so the import can say so. It is the only dimension this
    conversion ever invents, and it invents it because a zero one is not a box the
    editor can open.
    """
    stats = {"thin": 0} if stats is None else stats
    ox, oy, oz = (float(v) for v in origin)
    dx, dy, dz = _extent(xb)
    cx, cy, _ = _centre(xb)
    color = _color_of(rec)
    display = {"color": color} if color else None
    name = rec.string("ID")

    def thickened(v: float) -> float:
        if v > TOL_M:
            return v
        stats["thin"] += 1
        return THIN_M

    # A slab is a ceiling only if it is above the floor. One resting on it -- a
    # plinth, a hearth, a second floor tile beside the first -- has a soffit height
    # of zero or less, which is not a ceiling in this format and not a valid object
    # in any schema version. It falls through to the box it actually is.
    if _is_slab(xb) and xb[4] - oz > TOL_M:
        obj: Dict[str, Any] = {
            "id": ids.make("ceiling", name), "type": "ceiling", "name": name or "Ceiling",
            "transform": {"position_m": [0.0, 0.0, 0.0]},
            "polygon_m": [[xb[0] - ox, xb[2] - oy], [xb[1] - ox, xb[2] - oy],
                          [xb[1] - ox, xb[3] - oy], [xb[0] - ox, xb[3] - oy]],
            "height_m": xb[4] - oz,
            "thickness_m": thickened(dz),
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
            "thickness_m": thickened(thickness),
            "baseHeight_m": max(base, 0.0),
            "openings": [],
        }
    else:
        obj = {
            "id": ids.make("obst", name), "type": "obstruction", "name": name or "Obstruction",
            "transform": {"position_m": [cx - ox, cy - oy, xb[4] - oz]},
            "size_m": [thickened(dx), thickened(dy), thickened(dz)],
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
    # The surfaces the faces actually carry, whichever spelling set them.
    named = [x for x in dict.fromkeys(_face_surfs(rec)) if x]
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
    """One `&DEVC` as a plan instrument, or None if its quantity is not one.

    `&SLCF QUANTITY='TEMPERATURE', XYZ=...` has every field this reads and is a
    slice file, not a thermocouple, so the group is checked first.
    """
    if rec.group != DEVICE_GROUP:
        return None
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
    meshes = _mesh_boxes(records, mults)
    domain: Optional[Xb] = None
    if meshes:
        domain = [min(m[0] for m in meshes), max(m[1] for m in meshes),
                  min(m[2] for m in meshes), max(m[3] for m in meshes),
                  min(m[4] for m in meshes), max(m[5] for m in meshes)]

    # -- the fire --------------------------------------------------------
    reac = (by_group.get("REAC") or [None])[0]
    # Always read, even when geometry is not being imported: the obstructions are
    # what locate the fire and the floor, and therefore the origin. Skipping the read
    # would move every instrument in the plan.
    obst_boxes = _boxes(records, "OBST", mults)
    vent_boxes = [b for b in _boxes(records, "VENT", mults)
                  if not _is_domain_vent(b, domain, surfs)]
    heat_of_combustion = reac.number("HEAT_OF_COMBUSTION") if reac else None
    faces = _fire_faces(obst_boxes, vent_boxes, surfs, peaks, heat_of_combustion, issues,
                        domain)
    burner = _pick_burner(faces, opts.burner_surf)
    burner_faces = _burner_faces(faces, burner)
    candidates = sorted({f.surf for f in faces if _can_be_burner(f)})
    # Heat-release surfaces no face of which could be a burner here: a lining on a
    # wall vent, a plane fire with no plan area. They are still in the file and
    # still change the fire, so they are named rather than passed over.
    unusable = sorted({f.surf for f in faces} - set(candidates))

    if burner is None and not faces:
        issues.append(Issue(
            "warning", "fds-no-fire",
            "no surface in this input releases heat, so the plan has no burner and "
            "its origin is the centre of the mesh. Add a burner, then move the "
            "geometry onto it -- every standoff and flame-height figure is measured "
            "from the burner centre."))
    elif burner is None:
        issues.append(Issue(
            "warning", "fds-fire-not-a-burner",
            "{} surface(s) release heat ({}) but none of them is an upward-facing "
            "horizontal face -- a wall lining burns on a plane with no plan footprint, "
            "and a ceiling soffit burns downwards. Neither is the floor-standing "
            "source this format's burner describes, so the plan has no burner and its "
            "origin is the centre of the mesh."
            .format(len({f.surf for f in faces}),
                    ", ".join(sorted({f.surf for f in faces})))))
    else:
        if opts.burner_surf and burner.surf != opts.burner_surf:
            # The chooser falls back to the default pick rather than refusing, which
            # is the useful behaviour -- but a caller who named a surface and got a
            # different one has to be told, or the plan silently describes a fire
            # somewhere else.
            issues.append(Issue(
                "warning", "fds-burner-unavailable",
                "'{}' was asked for as the burner surface, but no face of it is one "
                "this format can hold as a burner; '{}' was used instead."
                .format(opts.burner_surf, burner.surf)))
        if len(candidates) > 1:
            issues.append(Issue(
                "info", "fds-fire-choice",
                "{} surfaces release heat ({}); '{}' was taken as the burner because it "
                "is the most compact horizontal one. The rest are burning surfaces the "
                "plan cannot represent."
                .format(len(candidates), ", ".join(candidates), burner.surf)))
        if unusable:
            issues.append(Issue(
                "info", "fds-fire-not-a-burner",
                "{} release{} heat on faces this format cannot hold as a burner -- a "
                "wall lining has no plan footprint and a ceiling soffit burns "
                "downwards. {} in the plan as a burner; the notes on the geometry say "
                "which surfaces burn."
                .format(", ".join("'" + x + "'" for x in unusable),
                        "s" if len(unusable) == 1 else "",
                        "It is not" if len(unusable) == 1 else "They are not")))
        if len(burner_faces) > 1:
            issues.append(Issue(
                "info", "fds-burner-instances",
                "'{}' burns on {} separate faces; each became a burner, and the one "
                "at the origin is the primary."
                .format(burner.surf, len(burner_faces))))

    # -- origin and floor ------------------------------------------------
    pans = _burner_pans(burner_faces, obst_boxes)
    burner_xbs = [f.xb for f in burner_faces if not f.from_vent] + [p.xb for p in pans]
    slabs = [b for b in obst_boxes
             if _is_slab(b.xb) and not any(b.xb == xb for xb in burner_xbs)]
    # Where the chosen burner stands: the bottom of its pan, when it has one.
    burner_base = None if burner is None else min(
        [burner.xb[4]] + [p.xb[4] for p in _burner_pans([burner], obst_boxes)])
    if opts.floor_z_m is not None:
        floor_z, floor_rule = float(opts.floor_z_m), "the level you gave"
    else:
        floor_z, floor_rule = _detect_floor(slabs, burner_base, domain)

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

    if burner_base is not None and burner_base > floor_z + BURNER_PLATFORM_TOL_M:
        issues.append(Issue(
            "warning", "fds-burner-raised",
            "the burner's base is {:.2f} m above the floor, taken from {}. If it "
            "stands on a platform this is right; if the floor was detected wrongly "
            "every height in the plan is off by the same amount."
            .format(burner_base - floor_z, floor_rule)))
    if floor_rule == _FLOOR_FROM_BURNER and slabs:
        # The model has slabs, but every one of them is above the fire. That is the
        # shape of a floor-level fire under a ceiling with no floor slab drawn -- and
        # also the shape of a floor slab this reader failed to recognise, so it is
        # worth a line rather than a silent choice.
        issues.append(Issue(
            "info", "fds-floor-inferred",
            "No horizontal slab lies below the burner, so the floor was taken as the "
            "burner's base (z = {} in the file). The {} slab(s) above it {} kept as "
            "ceilings.".format(serialize._js_number(float(floor_z)), len(slabs),
                               "was" if len(slabs) == 1 else "were")))

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
        stats = {"thin": 0}
        # Every slab whose top is the floor, not merely the lowest one. A meshed
        # model tiles its floor -- one &OBST per mesh is the usual shape -- and
        # skipping a single instance leaves the rest to be converted as slabs
        # sitting at floor level, which is not a ceiling and not an object anyone
        # drew.
        for box in obst_boxes:
            if any(box.xb == xb for xb in burner_xbs):
                continue                      # becomes the burner, below
            if _is_slab(box.xb) and box.xb[5] <= floor_z + TOL_M:
                continue                      # the floor is the z = 0 plane, not an object
            obj = _geometry_object(box.xb, box.rec, origin, ids, surfs, stats)
            if obj["type"] == "wall":
                walls.append((obj, box.xb))
            objects.append(obj)

        _apply_holes(_boxes(records, "HOLE", mults), walls, origin, issues)

        if stats["thin"]:
            issues.append(Issue(
                "info", "fds-thin-geometry",
                "{} zero-thickness &OBST extent(s) were drawn {} mm thick: this format "
                "has no planar object, and a box with no thickness is one the editor "
                "cannot open.".format(stats["thin"], serialize._js_number(THIN_M * 1000))))

    # A box burning on every face burns on its sides too; they join the burner's
    # HRR, and the bottom is taken to rest on something. Mirror of fds.ts.
    sides_kw = 0.0
    for face in burner_faces:
        sides = [] if face.from_vent else [
            f for f in faces if not f.from_vent and f is not face and f.xb == face.xb
            and f.face not in ("+z", "-z") and f.hrr_kw is not None]
        extra = sum(f.hrr_kw for f in sides)
        sides_kw += extra
        whole = (dataclasses.replace(face, hrr_kw=face.hrr_kw + extra)
                 if extra > 0 and face.hrr_kw is not None else face)
        objects.append(_burner_object(ids, whole, origin, floor_z, reac, surfs))
    if sides_kw > 0:
        issues.append(Issue(
            "info", "fds-burner-sides",
            "The burner box also burns on its sides; their {} kW is included in the "
            "burner's heat release rate, as FDS releases heat over every exposed face."
            .format(js_to_fixed(sides_kw, 1))))

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
        # `serialize._js_number`, not "{:g}": it is the one spelling of a float both
        # writers agree on, and this string ends up in the plan file.
        notes.append("Simulation T_END {} s.".format(
            serialize._js_number(t_end.number("T_END"))))
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
    _report_unresolved_includes(by_group, opts, issues)
    _report_invalid(plan, issues)

    return FdsImport(plan=plan, issues=issues, devices=device_groups, origin_m=origin,
                     burner_surf=burner.surf if burner else None,
                     burner_candidates=candidates, source_file=filename)


def _is_domain_vent(box: _Box, domain: Optional[Xb], surfs: Dict[str, Record]) -> bool:
    """A vent that is just a boundary condition on the edge of the mesh.

    `SURF_ID='OPEN'` and `MB='XMAX'` are how an FDS model says "the world continues
    past here". They are not geometry and they are not instruments.

    A vent that releases heat is never one of those, wherever it sits. A floor fire
    in a domain that starts at the floor is written `XB=...,z0,z0` with `z0` the
    bottom of the mesh -- flush with a domain face, and the most ordinary way there
    is to write a burner. Dropping it left the plan with no fire, an origin fallen
    back to the mesh centre, and a warning telling the user their input has no heat
    source.
    """
    if any(_states_heat(surfs.get(s or "")) for s in box.surfs):
        return False
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


def _round4(value: float) -> float:
    """`Number(value.toFixed(4))`: the exact binary value, ties away from zero."""
    from decimal import ROUND_HALF_UP, Decimal
    if not math.isfinite(value):
        return value
    return float(Decimal(value).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


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
        # Rounded as JavaScript's toFixed(4) rounds (the exact value, ties away from
        # zero), so both engines put the same devices in the same run.
        key = (_round4(xyz[0]), _round4(xyz[1]), rec.number("IOR"))
        if key not in by_xy:
            by_xy[key] = []
            order.append(key)
        by_xy[key].append((rec, diameter))

    out: List[Dict[str, Any]] = []
    for key in order:
        run = sorted(by_xy[key], key=lambda pair: pair[0].numbers("XYZ")[2])
        first = run[0][0]
        x, y, z0 = first.numbers("XYZ")[:3]
        # The lowest bead's own coordinates, not the grouping key: the key is
        # rounded to 0.1 mm, and the web importer (and the file) say 1.23456.
        position = [x - ox, y - oy, z0 - oz]
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


def _report_unresolved_includes(by_group: Dict[str, List[Record]], opts: ImportOptions,
                                issues: List[Issue]) -> None:
    """Say so when `&CATF` named files nobody read.

    :func:`load` resolves includes because it has a path to resolve them against.
    Converting text -- which is what the editor does, having been handed the bytes
    of one file -- cannot, and a silent skip there is the worst kind: the plan looks
    complete and holds a fraction of the model.
    """
    catf = by_group.get("CATF") or []
    if catf and not opts.includes_resolved:
        named = [x for rec in catf for x in rec.strings("OTHER_FILES") if x]
        issues.append(Issue(
            "warning", "fds-catf-unresolved",
            "&CATF pulls {} into this input ({}), and only the file itself was read. "
            "Everything those files define -- geometry, devices, surfaces -- is "
            "missing from this plan. Open the input from a folder that holds them."
            .format("{} other file(s)".format(len(named)) if named else "other files",
                    ", ".join(named) if named else "unnamed")))


def _report_invalid(plan: Plan, issues: List[Issue]) -> None:
    """Check the plan the conversion just built, and report rather than raise.

    Every other way a document reaches this format goes through a validation
    boundary; an import that skipped it could hand back a plan that saves and then
    cannot be opened again -- a failure that surfaces a long way from the import
    that caused it. The findings are issues, not an exception, because the preview
    is the right place to show them.
    """
    try:
        plan.validate_schema()
    except PlanError as exc:
        issues.append(Issue(
            "error", "fds-invalid",
            "the conversion produced a plan this format does not accept, so it needs "
            "fixing before it is used: {}".format(str(exc).replace("\n", " ").strip())))
    # The schema cannot say "unique"; the editor's load boundary does, so this does.
    seen, repeated = set(), []
    for obj in plan.data.get("objects", []):
        oid = obj.get("id")
        if oid in seen and oid not in repeated:
            repeated.append(oid)
        seen.add(oid)
    if repeated:
        issues.append(Issue(
            "error", "fds-invalid",
            "the conversion produced repeated object ids: {}".format(", ".join(map(str, repeated)))))


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
    # The includes are resolved above, so the conversion should not warn that
    # they were not.
    opts = dataclasses.replace(options or ImportOptions(), includes_resolved=True)
    result = to_plan(text, filename=os.path.basename(str(path)), options=opts)
    result.issues = issues + result.issues
    return result
