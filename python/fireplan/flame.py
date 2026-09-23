"""Reconstructed flame sequences: the visual-hull voxel frames a plan links to.

The reconstruction pipeline (`fixtures/flame/reconstruct_revised.py`) writes one
`t_<seconds>s.npz` per timestep, holding the world coordinates of the occupied
voxel centres and the pipeline's `voxel_size`. This module reads a folder of them,
infers the lattice they sit on, describes the run as the manifest a plan stores
(format 1.4, `linkedFiles[].sequence`), and packs the frames into the compact form
the editor embeds in a shared page. Mirror of `web/src/core/flame.ts`; the two are
held to identical manifests and identical packed bytes on the fixture.

The one trap is the lattice pitch. The pipeline builds its grid with an
endpoint-inclusive `linspace`, so neighbouring centres are `volume / (res - 1)`
apart while its `voxel_size` is `volume / res` -- half a percent less. Indexing
voxels by `voxel_size` is off by one a hundred voxels out, so the pitch is inferred
from the coordinates and `voxel_size` is carried along as what the pipeline said.
"""

from __future__ import annotations

import math
import os
import re
import struct
import zipfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .linked_files import sequence_problem
from .serialize import _js_number

FRAME_NAME = re.compile(r'^t_(\d+(?:\.\d+)?)s\.npz$')

#: A frame whose coordinates land further than this fraction of a pitch from a
#: lattice point is not on the sequence's grid. Real frames land within 1e-9.
LATTICE_TOLERANCE = 0.01

#: Packed sequence magic and version; little-endian throughout.
PACK_MAGIC = b'FTPV'
PACK_VERSION = 1
#: Per-frame record: f64 timestamp, u32 count, i32[3] origin, u16[3] dims, u32 byte length.
FRAME_HEADER = '<dI3i3HI'
#: A frame box axis is a u16 in the packed form; a longer one has no representation.
MAX_FRAME_DIM = 0xFFFF


def frame_timestamp(name: str) -> Optional[float]:
    """The timestamp a frame file name carries, or None for any other file."""
    m = FRAME_NAME.match(os.path.basename(name))
    return float(m.group(1)) if m else None


def list_frames(folder: str) -> List[Tuple[float, str]]:
    """`(timestamp, path)` for every frame in the folder, in time order.

    Only files named the way the pipeline names them count; a stray file is ignored
    rather than refused, but two files claiming one timestamp are refused rather
    than merged.
    """
    frames = []
    for name in os.listdir(folder):
        t = frame_timestamp(name)
        if t is not None:
            frames.append((t, os.path.join(folder, name)))
    frames.sort(key=lambda item: item[0])
    for (a, pa), (b, pb) in zip(frames, frames[1:]):
        if a == b:
            raise ValueError('two frames carry the timestamp {} s: {} and {}'.format(
                a, os.path.basename(pa), os.path.basename(pb)))
    if not frames:
        raise ValueError('no t_<seconds>s.npz frames in {}'.format(folder))
    return frames


#: What a frame's arrays may hold: 4- or 8-byte floats or integers, either byte order.
#: The editor reads exactly these (DTYPE_READERS in web/src/core/flame.ts), and
#: np.load reads far more -- a frame only one engine could open was a plan the other
#: refused (review 2026-09-22, FLM-5).
_FRAME_DTYPES = {('f', 4), ('f', 8), ('i', 4), ('i', 8)}
#: Stored or deflated, the two methods the editor's ZIP reader decompresses.
_FRAME_COMPRESSION = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}


def read_frame(path: str) -> Tuple[np.ndarray, float]:
    """The `(M, 3)` voxel centres and the voxel size a frame file holds.

    Every refusal names the file: in a folder of eighty frames, "not a ZIP archive"
    on its own sends the user looking at all of them.
    """
    name = os.path.basename(path)
    if not zipfile.is_zipfile(path):
        raise ValueError('{}: not a ZIP archive (no end-of-central-directory record)'.format(name))
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.compress_type not in _FRAME_COMPRESSION:
                raise ValueError('{}: ZIP entry {} uses unsupported compression method {}'.format(
                    name, info.filename, info.compress_type))
    with np.load(path) as data:
        if 'voxels' not in data or 'voxel_size' not in data:
            raise ValueError('{}: not a reconstruction frame (needs voxels and voxel_size)'.format(name))
        raw_voxels, raw_size = data['voxels'], data['voxel_size']
    for label, array in (('voxels', raw_voxels), ('voxel_size', raw_size)):
        # A member without the NPY header comes back from np.load as raw bytes.
        if not isinstance(array, np.ndarray):
            raise ValueError('{}: {} is not an NPY array'.format(name, label))
        if (array.dtype.kind, array.dtype.itemsize) not in _FRAME_DTYPES:
            raise ValueError('{}: {} has dtype {}; expected a 4- or 8-byte float or integer'.format(
                name, label, array.dtype.str))
    if raw_size.size != 1:
        raise ValueError('{}: voxel_size must be a positive number'.format(name))
    voxels = np.asarray(raw_voxels, dtype=np.float64)
    voxel_size = float(raw_size.reshape(-1)[0])
    if voxels.ndim != 2 or voxels.shape[1] != 3:
        raise ValueError('{}: voxels must be an (M, 3) array, got shape ({})'.format(
            name, ', '.join(str(n) for n in voxels.shape)))
    if not np.all(np.isfinite(voxels)):
        raise ValueError('{}: voxel coordinates must be finite'.format(name))
    if not (math.isfinite(voxel_size) and voxel_size > 0):
        raise ValueError('{}: voxel_size must be a positive number'.format(name))
    return voxels, voxel_size


def infer_pitch(voxels: np.ndarray) -> float:
    """The lattice pitch: the smallest gap between distinct x coordinates.

    Taken from the frame with the most voxels, which is certain to hold two
    neighbours; a 16-voxel frame might not. Gaps under a nanometre are float noise
    between values that are the same lattice line, not a pitch.
    """
    xs = np.unique(voxels[:, 0])
    gaps = np.diff(xs)
    gaps = gaps[gaps > 1e-9]
    if not len(gaps):
        raise ValueError('cannot infer the lattice pitch: no two voxels share a row')
    return float(gaps.min())


#: How close an inferred pitch has to be to the voxel size to BE it: an `arange`
#: grid's smallest float gap lands a few ulps short. Mirror of PITCH_SNAP in flame.ts.
PITCH_SNAP = 1e-4


def snap_pitch(pitch: float, voxel_size: float, spans: Sequence[float] = ()) -> float:
    """The pitch, snapped to the voxel size when the two are the same spacing.

    `spans` is the extent of the data on each axis. Close is not enough on its own: a
    grid whose true spacing is 0.01 m, labelled with a voxel size of 0.0099995 m, is
    within the snap, and snapping it put a voxel 3 m out 0.015 cells off the lattice.
    The snap stands only if every extent is still a whole number of the snapped
    cells. Mirror of `snapPitch` in flame.ts.
    """
    if abs(pitch - voxel_size) > PITCH_SNAP * voxel_size:
        return pitch
    for span in spans:
        cells = float(span) / voxel_size
        if abs(cells - round(cells)) > LATTICE_TOLERANCE:
            return pitch
    return voxel_size


def infer_resolution(pitch: float, voxel_size: float) -> Optional[int]:
    """Voxels per axis of the pipeline's full grid, from the linspace identity
    `pitch = volume / (res - 1)`, `voxel_size = volume / res`. None when the two are
    equal, which is a grid built some other way."""
    gap = pitch - voxel_size
    if gap <= 1e-9 * pitch:
        return None
    return int(round(pitch / gap))


def lattice_indices(voxels: np.ndarray, origin: Sequence[float], pitch: float) -> np.ndarray:
    """Integer lattice indices of voxel centres relative to `origin`, refusing a
    frame whose centres are not on the lattice."""
    scaled = (voxels - np.asarray(origin, dtype=np.float64)) / pitch
    indices = np.rint(scaled)
    if len(voxels) and float(np.abs(scaled - indices).max()) > LATTICE_TOLERANCE:
        raise ValueError('voxels are not on the sequence lattice')
    if len(voxels) and float(indices.min()) < 0:
        raise ValueError('voxels lie before the lattice origin')
    return indices.astype(np.int64)


class Frame:
    """One packed frame: a bounding box on the lattice and a bit per cell.

    `bits` is `numpy.packbits` order (most significant bit first) over cells
    flattened as `((i * ny) + j) * nz + k`, with `i, j, k` relative to `origin`.
    """

    __slots__ = ('timestamp', 'count', 'origin', 'dims', 'bits')

    def __init__(self, timestamp: float, count: int, origin: Tuple[int, int, int],
                 dims: Tuple[int, int, int], bits: bytes):
        self.timestamp = timestamp
        self.count = count
        self.origin = origin
        self.dims = dims
        self.bits = bits

    @property
    def empty(self) -> bool:
        return self.count == 0

    def occupancy(self) -> np.ndarray:
        """Bool `(nx, ny, nz)` over the frame's own box."""
        if self.empty:
            return np.zeros((0, 0, 0), dtype=bool)
        n = int(np.prod(self.dims))
        flat = np.unpackbits(np.frombuffer(self.bits, dtype=np.uint8))[:n].astype(bool)
        return flat.reshape(self.dims)

    def surface_cells(self) -> np.ndarray:
        """`(n, 3)` box-local indices of the cells with an empty 6-neighbour, in
        flat order. The box boundary counts as empty. What the editor draws."""
        if self.empty:
            return np.zeros((0, 3), dtype=np.int64)
        g = self.occupancy()
        p = np.pad(g, 1)
        enclosed = (p[:-2, 1:-1, 1:-1] & p[2:, 1:-1, 1:-1]
                    & p[1:-1, :-2, 1:-1] & p[1:-1, 2:, 1:-1]
                    & p[1:-1, 1:-1, :-2] & p[1:-1, 1:-1, 2:])
        surface = g & ~enclosed
        return np.argwhere(surface).astype(np.int64)


def frame_problem(frame: Frame, extent: Sequence[int]) -> Optional[str]:
    """Why a packed frame is not one `pack_frame` could have produced, or None.

    The editor sizes its instance buffer from `count` and fills it with the cells
    actually set, and the surface walk trusts `dims` to address `bits`: a frame
    that claims one and holds the other overruns a buffer instead of drawing.
    `extent` is the sequence lattice's last index per axis, which every box has to
    fit inside. Mirror of `frameProblem` in web/src/core/flame.ts.
    """
    count, origin, dims, bits = frame.count, frame.origin, frame.dims, frame.bits
    if not math.isfinite(frame.timestamp):
        return 'has a non-finite timestamp'
    if count == 0:
        if any(d != 0 for d in dims) or any(o != 0 for o in origin) or len(bits) != 0:
            return 'is empty but carries a box'
        return None
    if any(d <= 0 for d in dims):
        return 'declares {} voxels in a box with no cells'.format(count)
    cells = dims[0] * dims[1] * dims[2]
    if len(bits) != (cells + 7) // 8:
        return 'holds {} bytes for a box of {} cells'.format(len(bits), cells)
    padding = len(bits) * 8 - cells
    if padding and bits[-1] & ((1 << padding) - 1):
        return 'has bits set past its last cell'
    held = int(np.unpackbits(np.frombuffer(bits, dtype=np.uint8)).sum())
    if held != count:
        return 'declares {} voxels but holds {}'.format(count, held)
    for a in range(3):
        if origin[a] < 0 or origin[a] + dims[a] - 1 > extent[a]:
            return 'has a box outside the sequence bounds'
    return None


def pack_frame(timestamp: float, voxels: np.ndarray, origin_m: Sequence[float], pitch: float) -> Frame:
    if not len(voxels):
        return Frame(timestamp, 0, (0, 0, 0), (0, 0, 0), b'')
    idx = lattice_indices(voxels, origin_m, pitch)
    lo = idx.min(axis=0)
    dims = idx.max(axis=0) - lo + 1
    # Refused where every frame is built, as the web reader does: the editor draws
    # cells with 16-bit indices, and a longer axis wrapped. Same sentence as `pack`.
    if int(dims.max()) > MAX_FRAME_DIM:
        raise ValueError('frame at {} s spans {} cells on one axis; the packed form holds at most {}'.format(
            _js_number(timestamp), int(dims.max()), MAX_FRAME_DIM))
    local = idx - lo
    flat = (local[:, 0] * dims[1] + local[:, 1]) * dims[2] + local[:, 2]
    cells = np.zeros(int(np.prod(dims)), dtype=bool)
    cells[flat] = True
    count = int(cells.sum())
    if count != len(voxels):
        raise ValueError('frame at {} s holds {} duplicate voxel(s)'.format(timestamp, len(voxels) - count))
    return Frame(timestamp, count, tuple(int(v) for v in lo), tuple(int(v) for v in dims),
                 np.packbits(cells).tobytes())


class FlameSequence:
    """A folder of frames, read once: grid, bounds, packed frames, manifest."""

    def __init__(self, voxel_size: float, pitch: float, resolution: Optional[int],
                 bounds: np.ndarray, frames: List[Frame]):
        self.voxel_size = voxel_size
        self.pitch = pitch
        self.resolution = resolution
        #: `(2, 3)` min and max voxel centre over the sequence; also the lattice origin.
        self.bounds = bounds
        self.frames = frames

    @classmethod
    def load(cls, folder: str) -> 'FlameSequence':
        listed = list_frames(folder)
        raw = [(t, *read_frame(path)) for t, path in listed]
        names = {t: os.path.basename(path) for t, path in listed}
        sizes = {vs for _, _, vs in raw}
        if len(sizes) != 1:
            raise ValueError('frames disagree about voxel_size: {}'.format(sorted(sizes)))
        voxel_size = sizes.pop()
        populated = [(t, v) for t, v, _ in raw if len(v)]
        if not populated:
            raise ValueError('every frame is empty; nothing to reconstruct a grid from')
        fullest = max(populated, key=lambda item: len(item[1]))[1]
        lo = np.min([v.min(axis=0) for _, v in populated], axis=0)
        hi = np.max([v.max(axis=0) for _, v in populated], axis=0)
        pitch = snap_pitch(infer_pitch(fullest), voxel_size, [float(h - l) for l, h in zip(lo, hi)])
        bounds = np.array([lo, hi], dtype=np.float64)
        frames = []
        for t, v, _ in raw:
            try:
                frames.append(pack_frame(t, v, lo, pitch))
            except ValueError as exc:
                # The file's own name, not one rebuilt from the timestamp.
                raise ValueError('{}: {}'.format(names[t], exc)) from exc
        sequence = cls(voxel_size, pitch, infer_resolution(pitch, voxel_size), bounds, frames)
        # The rules the editor's load boundary applies to a manifest: fireplan wrote
        # manifests the editor then refused to open.
        problem = sequence_problem(sequence.manifest('1970-01-01T00:00:00Z'))
        if problem:
            raise ValueError(problem)
        return sequence

    @property
    def timestamps(self) -> np.ndarray:
        return np.array([f.timestamp for f in self.frames], dtype=np.float64)

    def frame_at(self, time_s: float) -> Optional[Frame]:
        """The frame showing at `time_s`: the last one at or before it. A frame
        holds until the next; before the first there is nothing."""
        index = int(np.searchsorted(self.timestamps, time_s, side='right')) - 1
        return self.frames[index] if index >= 0 else None

    def voxels(self, time_s: float) -> np.ndarray:
        """`(M, 3)` world centres of the frame at `time_s`, rebuilt from the lattice
        (so within float noise of what the pipeline wrote, in flat-index order)."""
        frame = self.frame_at(time_s)
        if frame is None or frame.empty:
            return np.zeros((0, 3), dtype=np.float64)
        cells = np.argwhere(frame.occupancy()) + np.asarray(frame.origin)
        return self.bounds[0] + cells * self.pitch

    def occupancy(self, time_s: float) -> Tuple[np.ndarray, np.ndarray]:
        """Bool `(nx, ny, nz)` over the frame's box and the world coordinates of the
        box's first cell centre."""
        frame = self.frame_at(time_s)
        if frame is None:
            return np.zeros((0, 0, 0), dtype=bool), self.bounds[0].copy()
        return frame.occupancy(), self.bounds[0] + np.asarray(frame.origin) * self.pitch

    def manifest(self, imported_at: Optional[str] = None) -> Dict[str, Any]:
        """The `sequence` block a plan stores. Recorded data: full precision."""
        if imported_at is None:
            imported_at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        return {
            'importedAt': imported_at,
            'grid': {'voxelSize_m': self.voxel_size, 'pitch_m': self.pitch, 'resolution': self.resolution},
            'bounds_m': [[float(x) for x in self.bounds[0]], [float(x) for x in self.bounds[1]]],
            'frames': [[f.timestamp, f.count] for f in self.frames],
        }

    # -- packed form -------------------------------------------------------

    def pack(self) -> bytes:
        """The compact, lossless form the editor embeds in a shared page.

        Little-endian binary rather than JSON, so both engines produce the same
        bytes without agreeing on how to spell a float:

            'FTPV' u8 version u32 frames
            f64 voxelSize f64 pitch i32 resolution (-1 = unknown) f64[6] bounds
            per frame: f64 timestamp u32 count i32[3] origin u16[3] dims u32 nbytes bytes
        """
        # Refused with the editor's message rather than struct's: the two engines
        # have to agree on what cannot be packed as well as on what can. The
        # timestamp is spelled as JavaScript spells it, so the sentences match.
        for f in self.frames:
            if any(d > MAX_FRAME_DIM for d in f.dims):
                raise ValueError('frame at {} s spans {} cells on one axis; the packed form holds at most {}'.format(
                    _js_number(f.timestamp), max(f.dims), MAX_FRAME_DIM))
        out = bytearray(PACK_MAGIC)
        out += struct.pack('<BI', PACK_VERSION, len(self.frames))
        out += struct.pack('<ddi', self.voxel_size, self.pitch, -1 if self.resolution is None else self.resolution)
        out += struct.pack('<6d', *self.bounds[0], *self.bounds[1])
        for f in self.frames:
            out += struct.pack(FRAME_HEADER, f.timestamp, f.count, *f.origin, *f.dims, len(f.bits))
            out += f.bits
        return bytes(out)

    @classmethod
    def unpack(cls, data: bytes) -> 'FlameSequence':
        """Read the packed form back, refusing anything `pack` could not have written.

        The container is checked as it is walked; then the manifest rules -- grid,
        bounds, 1-20,000 frames in strictly increasing time -- and each frame's own
        consistency, so a payload that lies about its cells is refused here rather
        than in whatever reads the frames.
        """
        if data[:4] != PACK_MAGIC or len(data) < 77:
            raise ValueError('not a packed flame sequence')
        version, count = struct.unpack_from('<BI', data, 4)
        if version != PACK_VERSION:
            raise ValueError('packed flame sequence version {} is not supported'.format(version))
        offset = 4 + struct.calcsize('<BI')
        voxel_size, pitch, resolution = struct.unpack_from('<ddi', data, offset)
        offset += struct.calcsize('<ddi')
        bounds = np.array(struct.unpack_from('<6d', data, offset), dtype=np.float64).reshape(2, 3)
        offset += struct.calcsize('<6d')
        frames = []
        header = struct.calcsize(FRAME_HEADER)
        for _ in range(count):
            if offset + header > len(data):
                raise ValueError('packed flame sequence is truncated')
            t, n, ox, oy, oz, dx, dy, dz, nbytes = struct.unpack_from(FRAME_HEADER, data, offset)
            offset += header
            bits = bytes(data[offset:offset + nbytes])
            if len(bits) != nbytes:
                raise ValueError('packed flame sequence is truncated')
            frames.append(Frame(t, n, (ox, oy, oz), (dx, dy, dz), bits))
            offset += nbytes
        if offset != len(data):
            raise ValueError('packed flame sequence has {} trailing byte(s)'.format(len(data) - offset))
        sequence = cls(voxel_size, pitch, None if resolution < 0 else resolution, bounds, frames)
        problem = sequence_problem(sequence.manifest('packed'))
        if problem:
            raise ValueError('packed flame sequence is inconsistent: {}'.format(problem))
        # The bounds are voxel centres, so they sit a whole number of pitches apart;
        # rounding a maximum that does not would admit a box whose last cell decodes
        # past it. Real bounds land within 1e-9 of a lattice point, like the frames.
        extent = []
        for a in range(3):
            cells = (bounds[1][a] - bounds[0][a]) / pitch
            if abs(cells - round(cells)) > LATTICE_TOLERANCE:
                raise ValueError('packed flame sequence is inconsistent: its bounds are not on its lattice')
            extent.append(int(round(cells)))
        for frame in frames:
            bad = frame_problem(frame, extent)
            if bad:
                raise ValueError('packed flame sequence is inconsistent: the frame at {} s {}'.format(_js_number(frame.timestamp), bad))
        return sequence


def scan_folder(folder: str, imported_at: Optional[str] = None) -> Dict[str, Any]:
    """The manifest for a folder of frames, as the editor would write it."""
    return FlameSequence.load(folder).manifest(imported_at)
