"""Independent checks on the distributable synthetic data and its regeneration."""
import csv
import importlib.util
from pathlib import Path
import zipfile

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('synthetic_flame', ROOT / 'tools/build_synthetic_flame.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


def rows(name):
    with (ROOT / 'fixtures' / name / 'volumes.csv').open(encoding='utf-8', newline='') as stream:
        return list(csv.DictReader(stream))


def test_synthetic_files_regenerate_byte_for_byte(tmp_path, monkeypatch):
    (tmp_path / 'fixtures/linked-files').mkdir(parents=True)
    monkeypatch.setattr(generator, 'ROOT', tmp_path)
    generator.main()
    generated = sorted((tmp_path / 'fixtures').rglob('*'))
    files = [p for p in generated if p.is_file()]
    assert len(files) == 82
    for path in files:
        assert path.read_bytes() == (ROOT / path.relative_to(tmp_path)).read_bytes(), path.name


def test_synthetic_csv_matches_all_frame_counts_and_exposed_faces():
    records = rows('flame')
    assert len(records) == 80
    for index, row in enumerate(records):
        t = index * 5
        assert float(row['timestamp_s']) == t
        path = ROOT / 'fixtures/flame/voxels' / 't_{:09.1f}s.npz'.format(t)
        with np.load(path) as frame:
            v, size = frame['voxels'], float(frame['voxel_size'])
        assert v.shape == (int(row['occupied_voxels']), 3)
        assert v.dtype.str == '<f8' and v.flags.c_contiguous
        assert size == 3 / 192
        assert float(row['volume_m3']) == round(len(v) * size**3, 6)
        assert int(row['total_voxels']) == 192**3
        assert int(row['num_valid_views']) == 4
        # Recover integer grid indices against the full grid origin, then count
        # transitions into and out of occupied space on all three padded axes.
        cells = np.rint((v - [-1.5, -1.5, -0.1]) / (3 / 191)).astype(int)
        assert np.all((cells >= 0) & (cells < 192))
        assert np.allclose(v, cells * (3 / 191) + [-1.5, -1.5, -0.1], atol=1e-14, rtol=0)
        faces = 0
        if len(v):
            assert v[:, 2].min() == pytest.approx(0.009947643979057563)
            cells -= cells.min(axis=0)
            grid = np.zeros(cells.max(axis=0) + 1, dtype=np.int8)
            grid[tuple(cells.T)] = 1
            padded = np.pad(grid, 1)
            faces = sum(int(np.abs(np.diff(padded, axis=a)).sum()) for a in range(3))
        assert float(row['surface_area_m2']) == round(faces * size**2, 6)
        assert row['active_volume_m3'] == row['volume_m3']
        assert row['active_surface_area_m2'] == row['surface_area_m2']


def test_npz_container_is_portable_and_timestamp_free():
    path = ROOT / 'fixtures/flame/voxels/t_0000055.0s.npz'
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist() == ['voxels.npy', 'voxel_size.npy']
        for member in archive.infolist():
            assert member.date_time == (1980, 1, 1, 0, 0, 0)
            assert member.create_system == 0
            assert member.compress_type == zipfile.ZIP_DEFLATED
            assert archive.read(member)[:8] == b'\x93NUMPY\x01\x00'
    with np.load(path) as frame:
        assert frame['voxel_size'].shape == ()
        assert frame['voxel_size'].dtype.str == '<f8'


def test_design_fire_and_large_run_keep_their_separate_scales():
    assert [generator.design_hrr(t) for t in (0, 45, 100, 285, 385, 395)] == [0, 80, 80, 80, 0, 0]
    records = rows('linked-files')
    assert [float(r['timestamp_s']) for r in records] == list(range(0, 200, 2))
    assert all(int(r['total_voxels']) == 8_000_000 and int(r['num_valid_views']) == 2 for r in records)
    assert max(int(r['occupied_voxels']) for r in records) == 2_028_915
    for r in records:
        assert float(r['volume_m3']) == round(int(r['occupied_voxels']) * 0.01**3, 6)
    # At 2 s the coarse box is 19 x 17 x 16 cells: hand-derived volume and area.
    assert float(records[1]['volume_m3']) == 19 * 17 * 16 / 1_000_000
    assert float(records[1]['surface_area_m2']) == 2 * (19*17 + 19*16 + 17*16) / 10_000
    assert float(records[0]['volume_m3']) == float(records[-1]['volume_m3']) == 0
