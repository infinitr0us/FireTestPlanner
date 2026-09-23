"""Write fixtures/flame/format-cases/: frame files in the layouts numpy produces.

The reconstruction pipeline writes little-endian float64 C-ordered arrays, and both
readers handled that. numpy writes others just as readily -- `np.array([x, y, z]).T`
saves Fortran order, a big-endian array stays big-endian, integer centres stay
integers -- and `fireplan` read them all while the editor refused them (review
2026-09-22, FLM-5). Each case here is read by both suites against
`format-cases.json`: the same voxels, or the same refusal.

    python tools/build_flame_format_cases.py
"""

from __future__ import annotations

import io
import json
import os
import zipfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "fixtures", "flame", "format-cases")

VOXELS = np.array([[0.0, 0.0, 0.0], [0.01, 0.0, 0.0], [0.0, 0.01, 0.02]])


def npz(path, voxels, voxel_size, compression=zipfile.ZIP_DEFLATED, suffix=".npy"):
    """np.savez's layout -- one .npy per array in a ZIP -- with a chosen compression,
    and optionally without the `.npy` on the member names, which np.load accepts."""
    with zipfile.ZipFile(path, "w", compression=compression) as archive:
        for name, array in (("voxels", voxels), ("voxel_size", voxel_size)):
            buffer = io.BytesIO()
            np.lib.format.write_array(buffer, np.asanyarray(array), allow_pickle=False)
            info = zipfile.ZipInfo(name + suffix, date_time=(2026, 9, 22, 0, 0, 0))
            info.compress_type = compression
            archive.writestr(info, buffer.getvalue())


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    expected = VOXELS.tolist()
    cases = [
        ("fortran-order.npz", np.asfortranarray(VOXELS), np.float64(0.01), zipfile.ZIP_DEFLATED,
         {"voxels": expected, "voxelSize": 0.01}),
        ("big-endian.npz", VOXELS.astype(">f8"), np.array(0.01, dtype=">f8"), zipfile.ZIP_DEFLATED,
         {"voxels": expected, "voxelSize": 0.01}),
        ("float32-stored.npz", VOXELS.astype("<f4"), np.float32(0.01), zipfile.ZIP_STORED,
         {"voxels": VOXELS.astype("<f4").astype(np.float64).tolist(),
          "voxelSize": float(np.float32(0.01))}),
        ("integer.npz", np.array([[0, 0, 0], [1, 0, 0]], dtype="<i8"), np.int32(1), zipfile.ZIP_DEFLATED,
         {"voxels": [[0, 0, 0], [1, 0, 0]], "voxelSize": 1}),
        ("float16.npz", VOXELS.astype("<f2"), np.float16(0.01), zipfile.ZIP_DEFLATED,
         {"error": "expected a 4- or 8-byte float or integer"}),
        ("bzip2.npz", VOXELS, np.float64(0.01), zipfile.ZIP_BZIP2,
         {"error": "unsupported compression method 12"}),
        # Members named `voxels`, not `voxels.npy`: np.load reads them the same, and
        # the editor refused them (Codex review of 5f8333d).
        ("no-npy-suffix.npz", VOXELS, np.float64(0.01), zipfile.ZIP_DEFLATED,
         {"voxels": expected, "voxelSize": 0.01}, ""),
    ]
    listing = []
    for name, voxels, size, compression, expect, *suffix in cases:
        npz(os.path.join(OUT, name), voxels, size, compression, *suffix)
        listing.append(dict({"file": name}, **expect))
    with open(os.path.join(ROOT, "fixtures", "flame", "format-cases.json"), "w",
              encoding="utf-8", newline="\n") as fh:
        json.dump(listing, fh, indent=2)
        fh.write("\n")
    print("wrote {} cases to {}".format(len(listing), OUT))


if __name__ == "__main__":
    main()
