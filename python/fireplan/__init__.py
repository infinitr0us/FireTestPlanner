"""fireplan -- read, validate and export fire test plans.

The plan file is the product: a fire safety engineer authors it in the 3D editor, a
data scientist consumes it as a camera rig description. This package is the second
half of that handoff.

    >>> from fireplan import Plan
    >>> p = Plan.load("fixtures/pool-fire-camera-row.ftp.json")
    >>> cam = p.cameras["cam-lwir-t650"]
    >>> cam.K                      # 3x3 intrinsics, pixels
    >>> cam.extrinsics()           # 4x4 camera-to-world, OpenCV frame
    >>> p.to_nerfstudio("transforms.json")

An FDS input file converts straight into a plan, re-origined onto the burner as this
format requires and carrying the offset back to the source coordinates:

    >>> Plan.from_fds("fixtures/fds/room_corner.fds")
    >>> from fireplan import fds
    >>> fds.load("model.fds").issues     # and everything the conversion left behind

Coordinate and camera frame conventions are normative in CONVENTIONS.md. The short
version: the file stores OpenGL-style poses because the editor is Three.js; this
reader returns OpenCV by default because that is what reconstruction tooling wants.
"""

from . import correlations, fds, namelist
from ._math import look_at_quat, matrix_to_quat, quat_to_matrix
from .objects import (
    Burner,
    Camera,
    Ceiling,
    HeatFluxSensor,
    Hood,
    Obstruction,
    PlanObject,
    Thermocouple,
    UnknownObject,
    Wall,
)
from .plan import FORMAT, VERSION, VERSION_LATEST, Issue, Plan, PlanError
from .serialize import dumps as dumps_canonical

__version__ = "0.7.0"

__all__ = [
    "Plan",
    "PlanError",
    "Issue",
    "Camera",
    "Burner",
    "Hood",
    "Wall",
    "Ceiling",
    "Obstruction",
    "HeatFluxSensor",
    "Thermocouple",
    "PlanObject",
    "UnknownObject",
    "correlations",
    "fds",
    "namelist",
    "quat_to_matrix",
    "matrix_to_quat",
    "look_at_quat",
    "dumps_canonical",
    "FORMAT",
    "VERSION",
    "VERSION_LATEST",
    "__version__",
]
