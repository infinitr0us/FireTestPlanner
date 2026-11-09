"""Generate redistributable flame fixtures, using only NumPy and the standard library.

Run from the repository root: python tools/build_synthetic_flame.py
No input data, clock, camera footage or reconstruction code is used. Seed 20261018
drives PCG64 integer draws. The 80 kW heptane design fire grows over 45 s, burns
steadily until 285 s, then decays to burnout at 385 s. Samples below 1 kW are empty.
Heskestad supplies the mean
height, L = max(0, 0.235 Q**0.4 - 1.02 D), D = sqrt(4 * 0.3048**2 / pi).
Independent five-second samples alias puffing: a square pan-filling base necks,
swells and tapers into a leaning, asymmetric tip, sometimes with detached pockets.
These are illustrative binary shapes, not a combustion simulation or measurements.

Grid contract: 192 endpoint-inclusive centres per axis over a 3 m cube centred
at (0, 0, 1.4) m. Thus x/y span [-1.5, 1.5], z spans [-0.1, 2.9], pitch is
3/191 m, and stored voxel_size is 3/192 m. Rig and plan frames coincide, Z up.
Only centres above the floor are occupied. C-order indexing is ijk, k fastest.
Each t_{seconds:09.1f}s.npz contains voxels (M,3) <f8 C-order and voxel_size
(scalar <f8); even empty frames have shape (0,3). NPY v1.0 members are ZIP-deflated
with fixed DOS metadata and ZIP64 local headers, in voxels/voxel_size order.

The independent CSV-only large run samples 0..198 s every 2 s. A coarse binary
box model on a 200**3 grid at 10 mm mimics a fat two-view hull, reaching about
2 m3. Its integer dimensions define exact counts and exposed faces without
allocating or distributing a second voxel sequence. It grows over 36 s, burns
until 140 s and decays to zero at 198 s. It is not the 80 kW fire's volume history.

CSV columns (same definitions for both runs; all empty-frame descriptors are 0):
  timestamp_s: sample time, float seconds, also encoded in each NPZ filename.
  volume_m3: occupied_voxels * stored voxel_size**3 (NOT lattice pitch**3).
  volume_liters: 1000 * volume_m3, before rounding.
  surface_area_m2: exposed six-neighbour faces * stored voxel_size**2.
  occupied_voxels: number of occupied cells, integer.
  total_voxels: full grid capacity, 192**3 or 200**3, integer.
  fill_ratio: occupied_voxels / total_voxels.
  num_valid_views: illustrative view count, 4 or 2, including empty samples.
  base_area_m2: occupied cells in the lowest occupied layer * voxel_size**2.
  effective_diameter_m: equal-area diameter sqrt(4 * base_area_m2 / pi).
  mean_flame_height_m: average occupied XY-column height from the lowest occupied
    centre to that column's highest centre, plus voxel_size. A spatial descriptor
    of this sample, not the driving Heskestad mean or a temporal average.
  aspect_ratio: mean_flame_height_m / effective_diameter_m.
  vertical_centroid_m: arithmetic mean of occupied centre z coordinates.
  vertical_std_m: population standard deviation of occupied centre z coordinates.
  heskestad_hrr_kw: ((mean_flame_height_m + 1.02 * effective_diameter_m)/0.235)**2.5;
    a geometric proxy, not an estimate of the specified design HRR.
  active_volume_m3, active_surface_area_m2: all occupied cells are active in these
    models, so these equal volume_m3 and surface_area_m2, including detached tips.
  cylinder_fill_ratio: active_volume / (base_area * mean_flame_height); a descriptor
    that can exceed 1 when a hull bulges beyond its base, not a bounded probability.
  method_a_hrr_kw: synthetic uncalibrated proxy 1000 kW/m3 * active_volume +
    10 kW/m2 * active_surface_area. This defines our own illustrative coefficients.
  method_c_xsv_m3: active_surface_area * mean_flame_height (an area-length feature).

Numbers use shortest float spelling after decimal rounding, as in the interchange
CSV: six places except volume_liters and the two HRR columns (three); counts are
integers, timestamps have one decimal. UTF-8, comma separated, LF. Explicit byte
order, archive metadata, seed and rounded shape decisions avoid host-dependent
output. Rebuild the plans and reader digests with build_flame_fixture.py and
build_linked_fixture.py afterwards; those builders do not generate this data.
"""

import csv
import io
from pathlib import Path
import zipfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SEED = 20261018
SIZE = 3.0 / 192
PITCH = 3.0 / 191
PAN = 0.3048
HEADER = (
    'timestamp_s,volume_m3,volume_liters,surface_area_m2,occupied_voxels,'
    'total_voxels,fill_ratio,num_valid_views,base_area_m2,effective_diameter_m,'
    'mean_flame_height_m,aspect_ratio,vertical_centroid_m,vertical_std_m,'
    'heskestad_hrr_kw,active_volume_m3,active_surface_area_m2,cylinder_fill_ratio,'
    'method_a_hrr_kw,method_c_xsv_m3'
).split(',')


def envelope(t, growth, decay, end):
    return min(1.0, t / growth) ** 2 * max(0.0, min(1.0, (end - t) / (end - decay))) ** 2


def design_hrr(t):
    return 80.0 * envelope(t, 45.0, 285.0, 385.0)


def random_values(rng, n):
    # Fixed integer-to-float mapping rather than distribution implementation details.
    return rng.integers(0, 1 << 24, size=n, dtype=np.uint32).astype(np.float64) / (1 << 24)


def flame_frames():
    rng = np.random.Generator(np.random.PCG64(SEED))
    axis = np.linspace(-1.5, 1.5, 192, dtype='<f8')
    # Evaluate only a box containing the analytic shape, without changing its lattice.
    xy = axis[np.abs(axis) < 0.4]
    z = (axis + 1.4)[((axis + 1.4) > 0) & ((axis + 1.4) < 2.0)]
    x, y, zz = xy[:, None, None], xy[None, :, None], z[None, None, :]
    diameter = np.sqrt(4 * PAN**2 / np.pi)
    for t in range(0, 400, 5):
        r = random_values(rng, 9)
        hrr = design_hrr(t)
        mean_height = max(0.0, 0.235 * hrr**0.4 - 1.02 * diameter)
        height = max(0.045, mean_height) * (0.6 + 0.9 * r[0])
        u = np.clip((zz - z[0]) / height, 0, 1)
        lean_x, lean_y = 0.065 * (r[1:3] - 0.5)
        cx = lean_x * u + 0.018 * np.sin(7 * u + 6 * r[3]) * u
        cy = lean_y * u + 0.014 * np.sin(9 * u + 6 * r[4]) * u
        # Rounded square at the base, circular aloft; seeded swelling and necking.
        radius = PAN / 2 * (1 - u)**0.65 * (
            1 - 0.28 * np.sin(np.pi * np.minimum(3 * u, 1))
            + (0.2 + 0.9 * r[5]) * np.sin(np.pi * u)**2)
        radius = np.maximum(radius, 1e-9)
        power = 2 + 6 * (1 - u)**4
        field = (np.abs((x - cx) / radius)**power
                 + np.abs((y - cy) / (radius * (1 + 0.15 * r[6] * u)))**power)
        occupied = (np.round(field, 12) <= 1) & (zz <= height + z[0])
        # The first layer fills the square pan. A cold/just-ignited fire has none.
        occupied[:, :, 0] = (np.abs(xy[:, None]) <= PAN / 2) & (np.abs(xy[None, :]) <= PAN / 2)
        if r[7] < 0.45 and mean_height > 0.25:
            occupied &= ~((u > 0.76) & (u < 0.84))
            pocket = ((x - lean_x - 0.025)**2 + (y - lean_y + 0.015)**2) / 0.045**2
            pocket = pocket + ((zz - height * 1.04) / (0.055 + 0.045 * r[8]))**2
            occupied |= np.round(pocket, 12) <= 1
        if hrr < 1.0:
            occupied[:] = False
        indices = np.argwhere(occupied)
        voxels = np.empty((len(indices), 3), dtype='<f8')
        for a, centres in enumerate((xy, xy, z)):
            voxels[:, a] = centres[indices[:, a]]
        yield float(t), voxels, occupied, z


def exposed_faces(occupied):
    # Each occupied cell has six faces; each adjacent pair hides two.
    adjacent = sum(int(np.count_nonzero(
        np.take(occupied, range(occupied.shape[a] - 1), axis=a)
        & np.take(occupied, range(1, occupied.shape[a]), axis=a))) for a in range(3))
    return 6 * int(occupied.sum()) - 2 * adjacent


def descriptors(t, count, faces, total, views, size, base_cells, height, centroid, std):
    volume, area, base = count * size**3, faces * size**2, base_cells * size**2
    diameter = np.sqrt(4 * base / np.pi)
    return [t, volume, 1000 * volume, area, count, total, count / total, views,
            base, diameter, height, height / diameter if count else 0.0, centroid, std,
            ((height + 1.02 * diameter) / 0.235)**2.5 if count else 0.0,
            volume, area, volume / (base * height) if count else 0.0,
            1000 * volume + 10 * area, area * height]


def flame_row(t, voxels, occupied, z):
    count = len(voxels)
    base_cells = height = centroid = std = 0.0
    if count:
        layers = occupied.sum(axis=(0, 1))
        bottom = int(np.flatnonzero(layers)[0])
        base_cells = int(layers[bottom])
        column_tops = np.max(np.where(occupied, z[None, None, :], -np.inf), axis=2)
        height = float(np.mean(column_tops[np.isfinite(column_tops)] - z[bottom] + SIZE))
        centroid, std = float(voxels[:, 2].mean()), float(voxels[:, 2].std())
    return descriptors(t, count, exposed_faces(occupied), 192**3, 4, SIZE,
                       base_cells, height, centroid, std)


def large_rows():
    rng = np.random.Generator(np.random.PCG64(SEED + 1))
    for t in range(0, 200, 2):
        r = random_values(rng, 3)
        scale = envelope(t, 36, 140, 198)**(1 / 3)
        nx = int(round(scale * (110 + 25 * r[0])))
        ny = int(round(scale * (105 + 30 * r[1])))
        nz = int(round(scale * (105 + 20 * r[2])))
        if not min(nx, ny, nz):
            nx = ny = nz = 0
        n = nx * ny * nz
        faces = 2 * (nx * ny + nx * nz + ny * nz)
        yield descriptors(float(t), n, faces, 200**3, 2, 0.01, nx * ny, nz * 0.01,
                          nz * 0.005, np.sqrt((nz**2 - 1) / 12) * 0.01 if n else 0.0)


def write_npz(path, voxels, voxel_size=SIZE):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, value in [('voxels', voxels), ('voxel_size', np.array(voxel_size, dtype='<f8'))]:
            member = zipfile.ZipInfo(name + '.npy', date_time=(1980, 1, 1, 0, 0, 0))
            member.create_system = 0
            member.external_attr = 0o600 << 16
            member.compress_type = zipfile.ZIP_DEFLATED
            with archive.open(member, 'w', force_zip64=True) as stream:
                np.lib.format.write_array(stream, value, version=(1, 0), allow_pickle=False)


def write_csv(path, rows):
    out = io.StringIO(newline='\n')
    writer = csv.writer(out, lineterminator='\n')
    writer.writerow(HEADER)
    for row in rows:
        writer.writerow([int(v) if i in (4, 5, 7) else round(float(v), 3 if i in (2, 14, 18) else 6)
                         for i, v in enumerate(row)])
    path.write_bytes(out.getvalue().encode('utf-8'))


def main():
    folder = ROOT / 'fixtures/flame/voxels'
    folder.mkdir(parents=True, exist_ok=True)
    rows = []
    for t, voxels, occupied, z in flame_frames():
        write_npz(folder / 't_{:09.1f}s.npz'.format(t), voxels)
        rows.append(flame_row(t, voxels, occupied, z))
    write_csv(ROOT / 'fixtures/flame/volumes.csv', rows)
    write_csv(ROOT / 'fixtures/linked-files/volumes.csv', large_rows())
    print('Wrote 80 synthetic NPZ frames, 80 flame CSV rows and 100 large-run CSV rows.')


if __name__ == '__main__':
    main()
