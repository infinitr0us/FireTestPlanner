"""Reconstructed flames: the codec, the format 1.4 object, and its checks.

The web suite runs the same fixture, the same check cases and the same expected
digests, so the two engines cannot drift apart about where a voxel sits or when a
hull is in the wrong place.
"""
from copy import deepcopy
import gzip
import hashlib
import json
from pathlib import Path
import struct

import numpy as np
import pytest

from fireplan import Plan, PlanError
from fireplan.flame import (
    FlameSequence, Frame, frame_timestamp, infer_pitch, infer_resolution, list_frames, pack_frame,
    read_frame, scan_folder,
)
from fireplan.linked_files import problems, sequence_problem
from fireplan.serialize import dumps, required_version

ROOT = Path(__file__).resolve().parents[2]
FLAME = ROOT / 'fixtures/flame'
EXPECTED = json.loads((FLAME / 'expected.json').read_text(encoding='utf-8'))
CHECK_CASES = json.loads((FLAME / 'check-cases.json').read_text(encoding='utf-8'))


@pytest.fixture(scope='module')
def sequence():
    return FlameSequence.load(str(FLAME / 'voxels'))


@pytest.fixture
def flame_plan():
    return Plan.load(FLAME / 'flame-test.ftp.json')


def synthetic(timestamp, cells, pitch=0.1, origin=(-1.0, -1.0, 0.0)):
    """A frame on a linspace-style lattice: voxel_size = pitch * 20 / 21."""
    voxels = np.array([[origin[a] + c[a] * pitch for a in range(3)] for c in cells], dtype=float).reshape(-1, 3)
    return timestamp, voxels, pitch * 20 / 21


def write_frames(folder, frames):
    for timestamp, voxels, voxel_size in frames:
        np.savez_compressed(folder / 't_{:09.1f}s.npz'.format(timestamp), voxels=voxels, voxel_size=voxel_size)


# -- frame files ------------------------------------------------------------

def test_timestamp_comes_from_the_file_name_only():
    assert frame_timestamp('t_0000055.0s.npz') == 55.0
    assert frame_timestamp('voxels/t_0000005.0s.npz') == 5.0
    assert frame_timestamp('t_12.25s.npz') == 12.25
    assert frame_timestamp('t_0000055.0s.ply') is None
    assert frame_timestamp('volumes.csv') is None
    assert frame_timestamp('t_-5.0s.npz') is None


def test_folder_listing_orders_and_refuses_duplicates(tmp_path):
    write_frames(tmp_path, [synthetic(10, [[0, 0, 0]]), synthetic(5, [[0, 0, 0]])])
    (tmp_path / 'notes.txt').write_text('ignored')
    assert [t for t, _ in list_frames(str(tmp_path))] == [5.0, 10.0]
    (tmp_path / 't_5.0s.npz').write_bytes((tmp_path / 't_0000005.0s.npz').read_bytes())
    with pytest.raises(ValueError, match='two frames carry the timestamp 5.0 s'):
        list_frames(str(tmp_path))
    with pytest.raises(ValueError, match='no t_<seconds>s.npz frames'):
        list_frames(str(tmp_path / 'empty')) if (tmp_path / 'empty').mkdir() is None else None


def test_frame_file_shape_is_checked(tmp_path):
    np.savez_compressed(tmp_path / 'bad.npz', voxels=np.zeros((4, 2)), voxel_size=0.1)
    with pytest.raises(ValueError, match=r'\(M, 3\)'):
        read_frame(str(tmp_path / 'bad.npz'))
    np.savez_compressed(tmp_path / 'nan.npz', voxels=np.array([[0.0, 0.0, np.nan]]), voxel_size=0.1)
    with pytest.raises(ValueError, match='finite'):
        read_frame(str(tmp_path / 'nan.npz'))
    np.savez_compressed(tmp_path / 'size.npz', voxels=np.zeros((0, 3)), voxel_size=0.0)
    with pytest.raises(ValueError, match='voxel_size'):
        read_frame(str(tmp_path / 'size.npz'))
    np.savez_compressed(tmp_path / 'keys.npz', points=np.zeros((0, 3)))
    with pytest.raises(ValueError, match='needs voxels and voxel_size'):
        read_frame(str(tmp_path / 'keys.npz'))


# -- lattice ------------------------------------------------------------------

def test_pitch_is_inferred_from_coordinates_not_voxel_size():
    _, voxels, _ = synthetic(0, [[0, 0, 0], [1, 0, 0], [5, 2, 3]])
    assert infer_pitch(voxels) == pytest.approx(0.1, abs=1e-12)
    assert infer_resolution(0.015706806282722363, 0.015625) == 192
    assert infer_resolution(0.1, 0.1 * 20 / 21) == 21
    assert infer_resolution(0.01, 0.01) is None
    with pytest.raises(ValueError, match='no two voxels'):
        infer_pitch(synthetic(0, [[0, 0, 0]])[1])


def test_off_lattice_and_duplicate_voxels_are_refused():
    with pytest.raises(ValueError, match='not on the sequence lattice'):
        pack_frame(0, np.array([[0, 0, 0], [0.13, 0, 0]]), [0, 0, 0], 0.1)
    with pytest.raises(ValueError, match='duplicate voxel'):
        pack_frame(0, np.array([[0.1, 0, 0], [0.1, 0, 0]]), [0, 0, 0], 0.1)
    with pytest.raises(ValueError, match='before the lattice origin'):
        pack_frame(0, np.array([[-0.1, 0, 0]]), [0, 0, 0], 0.1)


# -- packing ------------------------------------------------------------------

def test_bit_packing_follows_numpy_order():
    frame = pack_frame(1, synthetic(1, [[2, 3, 4], [2, 3, 5], [3, 3, 4]])[1], [-1, -1, 0], 0.1)
    assert (frame.count, frame.origin, frame.dims) == (3, (2, 3, 4), (2, 1, 2))
    assert frame.bits == bytes([0b11100000])
    assert frame.occupancy().tolist() == [[[True, True]], [[True, False]]]


def test_surface_cells_treat_the_box_boundary_as_empty():
    cells = [[i, j, k] for i in range(3) for j in range(3) for k in range(3)]
    frame = pack_frame(0, synthetic(0, cells)[1], [-1, -1, 0], 0.1)
    surface = frame.surface_cells()
    assert len(surface) == 26
    assert surface[0].tolist() == [0, 0, 0]
    assert len(Frame(0, 0, (0, 0, 0), (0, 0, 0), b'').surface_cells()) == 0


# -- the sequence ---------------------------------------------------------------

def test_sequence_holds_a_frame_until_the_next(tmp_path):
    write_frames(tmp_path, [synthetic(0, [[0, 0, 0], [1, 0, 0]]), synthetic(5, [[0, 0, 0]]), synthetic(10, [])])
    seq = FlameSequence.load(str(tmp_path))
    assert seq.timestamps.tolist() == [0.0, 5.0, 10.0]
    assert seq.frame_at(-1) is None
    assert seq.frame_at(4.99).timestamp == 0.0
    assert seq.frame_at(5).timestamp == 5.0
    assert seq.frame_at(1e9).empty
    assert seq.voxels(1e9).shape == (0, 3)
    assert seq.voxels(0).tolist() == [[-1.0, -1.0, 0.0], [-0.9, -1.0, 0.0]]
    grid, origin = seq.occupancy(5)
    assert grid.shape == (1, 1, 1) and origin.tolist() == [-1.0, -1.0, 0.0]


def test_sequence_refuses_disagreeing_frames(tmp_path):
    write_frames(tmp_path, [synthetic(0, [[0, 0, 0], [1, 0, 0]])])
    np.savez_compressed(tmp_path / 't_0000005.0s.npz', voxels=np.array([[-0.97, -1.0, 0.0]]), voxel_size=0.1 * 20 / 21)
    with pytest.raises(ValueError, match='t_0000005.0s.npz: voxels are not on the sequence lattice'):
        FlameSequence.load(str(tmp_path))
    np.savez_compressed(tmp_path / 't_0000005.0s.npz', voxels=np.array([[-1.0, -1.0, 0.0]]), voxel_size=0.05)
    with pytest.raises(ValueError, match='disagree about voxel_size'):
        FlameSequence.load(str(tmp_path))
    for path in tmp_path.glob('*.npz'):
        np.savez_compressed(path, voxels=np.zeros((0, 3)), voxel_size=0.1)
    with pytest.raises(ValueError, match='every frame is empty'):
        FlameSequence.load(str(tmp_path))


# -- the fixture, and the web engine -------------------------------------------------

def test_fixture_manifest_matches_the_pinned_one(sequence):
    assert sequence.manifest('2026-09-19T00:00:00Z') == EXPECTED['manifest']
    assert scan_folder(str(FLAME / 'voxels'), '2026-09-19T00:00:00Z') == EXPECTED['manifest']
    assert sequence.manifest()['importedAt'].endswith('Z')


def test_fixture_packs_to_the_pinned_bytes(sequence):
    packed = sequence.pack()
    assert len(packed) == EXPECTED['packedBytes']
    assert hashlib.sha256(packed).hexdigest() == EXPECTED['packedSha256']
    back = FlameSequence.unpack(packed)
    assert back.pack() == packed
    assert back.manifest('x') == sequence.manifest('x')
    assert FlameSequence.unpack(gzip.decompress(gzip.compress(packed))).pack() == packed
    with pytest.raises(ValueError, match='not a packed flame sequence'):
        FlameSequence.unpack(b'\0' * 100)
    with pytest.raises(ValueError, match='trailing'):
        FlameSequence.unpack(packed + b'\0')
    with pytest.raises(ValueError, match='truncated'):
        FlameSequence.unpack(packed[:1000])


def _two_cells(tmp_path):
    """Two occupied cells in a 2x1x1 box: the smallest sequence a payload can lie about."""
    write_frames(tmp_path, [synthetic(0, [[0, 0, 0], [1, 0, 0]])])
    return FlameSequence.load(str(tmp_path))


@pytest.mark.parametrize('edit, message', [
    # The editor sizes its instance buffer from `count` and fills it with the cells
    # actually set; this used to unpack cleanly and overrun there.
    (lambda f: setattr(f, 'count', 1), 'declares 1 voxels but holds 2'),
    (lambda f: setattr(f, 'count', 3), 'declares 3 voxels but holds 2'),
    (lambda f: setattr(f, 'dims', (1, 1, 9)), 'holds 1 bytes for a box of 9 cells'),
    (lambda f: setattr(f, 'bits', bytes([0b11000001])), 'has bits set past its last cell'),
    (lambda f: setattr(f, 'origin', (1, 0, 0)), 'has a box outside the sequence bounds'),
    (lambda f: setattr(f, 'origin', (-1, 0, 0)), 'has a box outside the sequence bounds'),
    (lambda f: (setattr(f, 'dims', (0, 0, 0)), setattr(f, 'bits', b'')), 'declares 2 voxels in a box with no cells'),
])
def test_unpack_refuses_inconsistent_frames(tmp_path, edit, message):
    """Mirror of 'the packed form, refusing what pack could not have written' in web."""
    seq = _two_cells(tmp_path)
    edit(seq.frames[0])
    # Spelled as the editor spells it (`0 s`, not `0.0 s`), so the two engines' sentences match.
    with pytest.raises(ValueError, match='inconsistent: the frame at 0 s ' + message):
        FlameSequence.unpack(seq.pack())


def test_unpack_refuses_an_empty_frame_with_a_box_and_frames_out_of_order(tmp_path):
    write_frames(tmp_path, [synthetic(0, [[0, 0, 0], [1, 0, 0]]), synthetic(5, [])])
    seq = FlameSequence.load(str(tmp_path))
    seq.frames[1].dims = (1, 1, 1)
    with pytest.raises(ValueError, match='is empty but carries a box'):
        FlameSequence.unpack(seq.pack())
    seq.frames[1].dims = (0, 0, 0)
    seq.frames.reverse()
    with pytest.raises(ValueError, match='strictly increasing'):
        FlameSequence.unpack(seq.pack())
    seq.frames.reverse()
    assert FlameSequence.unpack(seq.pack()).manifest('x') == seq.manifest('x')


def test_unpack_refuses_bounds_off_the_lattice(tmp_path):
    """Mirror of 'refuses bounds that are not on the lattice' in web.

    The two centres are at x = -1 and x = -0.9, pitch 0.1. With the maximum x
    rewritten to -0.94 (the f64 at byte 53) the extent used to round 0.6 up to 1,
    which admitted the second cell at -0.9: outside the bounds it declared.
    """
    packed = bytearray(_two_cells(tmp_path).pack())
    struct.pack_into('<d', packed, 53, -0.94)
    with pytest.raises(ValueError, match='its bounds are not on its lattice'):
        FlameSequence.unpack(bytes(packed))
    # Float noise the size real frames carry is not a misalignment.
    struct.pack_into('<d', packed, 53, -0.9 + 1e-9)
    assert FlameSequence.unpack(bytes(packed)).bounds[1][0] == pytest.approx(-0.9, abs=1e-8)


def test_pack_refuses_an_axis_the_u16_field_cannot_hold(tmp_path):
    """The same message as the editor's, rather than struct's; the editor used to
    wrap 65,536 to 0 silently."""
    write_frames(tmp_path, [synthetic(0, [[0, 0, 0], [1, 0, 0], [0, 0, 65535]])])
    # Refused as the folder is read, as the editor now refuses it (review 2026-09-22,
    # FLM-7): its renderer addresses cells in 16 bits too.
    with pytest.raises(ValueError, match='spans 65536 cells on one axis; the packed form holds at most 65535'):
        FlameSequence.load(str(tmp_path))
    # The limit itself packs and reads back.
    write_frames(tmp_path, [synthetic(0, [[0, 0, 0], [1, 0, 0], [0, 0, 65534]])])
    limit = FlameSequence.load(str(tmp_path))
    assert FlameSequence.unpack(limit.pack()).frames[0].dims == (2, 1, 65535)


def test_fixture_surface_cells_match_the_pinned_digest(sequence):
    digest = hashlib.sha256()
    counts = []
    for frame in sequence.frames:
        cells = frame.surface_cells().astype('<u2')
        counts.append(len(cells))
        digest.update(cells.tobytes())
    assert counts == EXPECTED['surfaceCellCounts']
    assert digest.hexdigest() == EXPECTED['surfaceCellsSha256']


def test_fixture_voxels_round_trip_to_the_pipeline_files(sequence):
    original, _ = read_frame(str(FLAME / 'voxels/t_0000055.0s.npz'))
    rebuilt = sequence.voxels(55.0)
    assert len(rebuilt) == len(original) == 35960
    key = lambda v: v[np.lexsort(v.T[::-1])]
    assert np.abs(key(original) - key(rebuilt)).max() < 1e-12


# -- the format 1.4 object ----------------------------------------------------------------

def test_fixture_is_canonical_valid_and_declares_1_4(flame_plan):
    text = (FLAME / 'flame-test.ftp.json').read_text(encoding='utf-8')
    assert dumps(flame_plan.data) == text
    flame_plan.validate_schema()
    assert flame_plan.format_version == '1.4.0'
    assert required_version(flame_plan.data) == '1.4.0'
    # A 1.3 tool reads the object through its unknown-type path, so the 1.3 schema
    # accepts the file: that is the forward compatibility CONVENTIONS section 6 promises.
    flame_plan.validate_schema('1.3.0')
    flame = flame_plan.reconstructed_flames[0]
    assert flame.id == 'flame-main' and flame.burner_id == 'burner-main' and flame.representation == 'voxels'
    assert flame.manifest['grid']['resolution'] == 192
    assert len(flame.manifest['frames']) == 80
    assert flame.opacity == 1.0 and flame.color_mode == 'height'
    assert flame_plan.flame_burner(flame).id == 'burner-main'
    # The HRR is the test record's, not the reference layout's 130 kW.
    assert flame_plan.burners[0].hrr_kw == 80
    assert flame.bounds_corners().shape == (8, 3)
    assert not [i for i in flame_plan.check() if i.code.startswith('flame-')]


def test_fixture_links_resolve_and_load(flame_plan):
    seq = flame_plan.flame_sequence(flame_plan.reconstructed_flames[0])
    assert seq.manifest('2026-09-19T20:00:00Z') == flame_plan.reconstructed_flames[0].manifest
    assert flame_plan.linked_file_path(flame_plan.burners[0].linked_files[0]).endswith('volumes.csv')


def test_add_reconstructed_flame_writes_what_the_builder_wrote(flame_plan):
    plan = Plan.load(ROOT / 'fixtures/pool-fire-camera-row.ftp.json')
    flame = plan.add_reconstructed_flame('voxels', str(FLAME / 'voxels'), imported_at='2026-09-19T20:00:00Z')
    assert flame.id == 'flame-1' and flame.burner_id is None
    assert flame.manifest == flame_plan.reconstructed_flames[0].manifest
    assert flame.raw['display'] == {'visible': True, 'locked': True}
    assert plan.effective_version == '1.4.0'
    plan.validate_schema()
    with pytest.raises(PlanError, match='links no voxel sequence'):
        plan.flame_sequence(plan.add({'id': 'bare', 'type': 'reconstructedFlame'}))


def test_reserved_time_offset_is_dropped_at_zero(flame_plan):
    link = flame_plan.reconstructed_flames[0].sequence_link
    link['timeOffset_s'] = 0
    assert '"timeOffset_s"' not in dumps(flame_plan.data)
    link['timeOffset_s'] = None
    assert '"timeOffset_s"' not in dumps(flame_plan.data)
    link['timeOffset_s'] = 1.5
    assert '"timeOffset_s": 1.5' in dumps(flame_plan.data)
    flame_plan.validate_schema()


def test_display_appearance_keys_are_kept_in_order(flame_plan):
    flame = flame_plan.reconstructed_flames[0]
    flame.raw['display'] = {'colorMode': 'solid', 'opacity': 0.4, 'locked': True}
    text = dumps(flame_plan.data)
    assert text.index('"locked": true') < text.index('"opacity": 0.4') < text.index('"colorMode": "solid"')
    assert flame.opacity == 0.4 and flame.color_mode == 'solid'
    flame_plan.validate_schema()


@pytest.mark.parametrize('bad, message', [
    ({'kind': 'spreadsheet'}, 'reconstructed flame links a voxel sequence'),
    ({'timeOffset_s': 'soon'}, 'finite number of seconds'),
])
def test_link_rules_are_enforced_beyond_the_schema(flame_plan, bad, message):
    flame_plan.reconstructed_flames[0].sequence_link.update(bad)
    assert any(message in p for p in problems(flame_plan.data))


@pytest.mark.parametrize('edit, message', [
    (lambda s: s['grid'].update(pitch_m=0.01), 'pitch no smaller'),
    (lambda s: s['grid'].update(voxelSize_m=0), 'positive voxel size'),
    (lambda s: s.update(bounds_m=[[1, 0, 0], [0, 1, 1]]), 'minimum corner first'),
    (lambda s: s.update(frames=[]), '1-20,000 frames'),
    (lambda s: s.update(frames=[[5, 1], [5, 2]]), 'strictly increasing'),
    (lambda s: s.update(frames=[[5, -1]]), 'non-negative'),
    (lambda s: s['grid'].update(resolution=1), 'resolution of at least 2'),
    (lambda s: s['grid'].update(resolution=192.5), 'resolution of at least 2'),
])
def test_manifest_rules_are_enforced_beyond_the_schema(flame_plan, edit, message):
    sequence = deepcopy(flame_plan.reconstructed_flames[0].manifest)
    edit(sequence)
    assert message in sequence_problem(sequence)
    assert sequence_problem(flame_plan.reconstructed_flames[0].manifest) is None


def test_a_burner_cannot_carry_a_voxel_sequence(flame_plan):
    flame_plan.burners[0].linked_files[0]['kind'] = 'voxelSequence'
    with pytest.raises(PlanError):
        flame_plan.validate_schema()
    assert any('voxel sequence' in p for p in problems(flame_plan.data))


def test_save_as_rebases_the_folder_like_any_link(flame_plan, tmp_path):
    (tmp_path / 'elsewhere').mkdir()
    flame_plan.save(tmp_path / 'elsewhere' / 'moved.ftp.json', update_modified=False)
    saved = json.loads((tmp_path / 'elsewhere' / 'moved.ftp.json').read_text(encoding='utf-8'))
    flame = [o for o in saved['objects'] if o['type'] == 'reconstructedFlame'][0]
    assert flame['linkedFiles'][0]['path'].endswith('fixtures/flame/voxels')
    assert flame['linkedFiles'][0]['sequence'] == flame_plan.reconstructed_flames[0].manifest


# -- checks, shared with the web suite ----------------------------------------------------------

def apply_case(data, case):
    data = deepcopy(data)
    flame = [o for o in data['objects'] if o['type'] == 'reconstructedFlame'][0]
    burner = [o for o in data['objects'] if o['id'] == 'burner-main'][0]
    flame.update(case.get('flame', {}))
    plot = burner['linkedFiles'][0]['plot']
    if 'plotSamples' in case:
        plot['samples'] = case['plotSamples']
    if 'plotShiftSeconds' in case:
        plot['samples'] = [[t + case['plotShiftSeconds'], v, a] for t, v, a in plot['samples']]
    if 'plotVolumeDelta' in case:
        row, voxels = case['plotVolumeDelta']['row'], case['plotVolumeDelta']['voxels']
        plot['samples'][row][1] += voxels * flame['linkedFiles'][0]['sequence']['grid']['voxelSize_m'] ** 3
    return data


@pytest.mark.parametrize('case', CHECK_CASES, ids=[c['name'] for c in CHECK_CASES])
def test_shared_check_cases(flame_plan, case):
    plan = Plan(apply_case(flame_plan.data, case))
    codes = sorted(i.code for i in plan.check() if i.code.startswith('flame-'))
    assert codes == sorted(case['expect'])
    for issue in plan.check():
        if issue.code.startswith('flame-'):
            assert issue.object_id == 'flame-main'


# -- review 2026-09-22: mirrored in web/src/core/flame.test.ts -----------------

_FORMAT_CASES = json.loads((FLAME / "format-cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", _FORMAT_CASES, ids=[c["file"] for c in _FORMAT_CASES])
def test_frame_layouts_are_read_as_the_editor_reads_them(case):
    """FLM-5: one set of accepted layouts, and the same refusals, in both engines."""
    from fireplan.flame import read_frame
    path = str(FLAME / "format-cases" / case["file"])
    if "error" in case:
        with pytest.raises(ValueError, match=case["error"]):
            read_frame(path)
        return
    voxels, size = read_frame(path)
    assert voxels.tolist() == case["voxels"] and size == case["voxelSize"]


def test_a_grid_whose_pitch_is_its_voxel_size_loads_and_validates(tmp_path):
    """FLM-1: an arange-built grid used to be refused by the editor while fireplan
    wrote its manifest anyway."""
    np.savez(str(tmp_path / "t_0000000.0s.npz"),
             voxels=np.array([[i * 0.01, 0.0, 0.0] for i in range(4)]), voxel_size=0.01)
    seq = FlameSequence.load(str(tmp_path))
    assert seq.pitch == 0.01 and seq.resolution is None
    from fireplan.linked_files import sequence_problem
    assert sequence_problem(seq.manifest("2026-09-22T00:00:00Z")) is None


def test_a_truncated_frame_is_named(tmp_path):
    (tmp_path / "t_0000005.0s.npz").write_bytes(b"\x01\x02\x03")
    with pytest.raises(ValueError, match=r"^t_0000005\.0s\.npz: not a ZIP archive"):
        FlameSequence.load(str(tmp_path))
