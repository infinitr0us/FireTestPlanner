"""Camera intrinsics, extrinsics and projection.

The frame conversions are the highest-risk code in the package -- a silent axis flip
here costs a data scientist a week -- so the expected matrices below are derived by
hand in the comments rather than by calling the code under test.
"""

from __future__ import annotations

import io
import json
import math
import os

import numpy as np
import pytest

from fireplan import Plan
from fireplan._math import look_at_quat, matrix_to_quat, quat_to_matrix


def _camera_at(position, target=(0.0, 0.0, 0.0), **spec_overrides):
    spec = {
        "modality": "RGB",
        "resolution_px": [1000, 500],
        "sensor_mm": [10.0, 5.0],
        "focalLength_mm": 20.0,
    }
    spec.update(spec_overrides)
    plan = Plan.new("test")
    plan.add({
        "id": "cam",
        "type": "camera",
        "transform": {
            "position_m": list(position),
            "rotation_quat": [float(v) for v in look_at_quat(position, target)],
            "aimTarget_m": list(target),
        },
        "camera": spec,
    })
    return plan.cameras["cam"]


# -- intrinsics ----------------------------------------------------------

def test_intrinsics_from_sensor_and_focal_length():
    cam = _camera_at([2.0, 0.0, 0.0])
    # fx = f * res_x / sensor_w = 20 * 1000 / 10 = 2000
    # fy = f * res_y / sensor_h = 20 *  500 /  5 = 2000
    assert cam.fx == pytest.approx(2000.0)
    assert cam.fy == pytest.approx(2000.0)
    # Principal point defaults to the OpenCV image centre, (w-1)/2 not w/2.
    assert cam.principal_point == pytest.approx((499.5, 249.5))

    expected_k = np.array([[2000.0, 0.0, 499.5], [0.0, 2000.0, 249.5], [0.0, 0.0, 1.0]])
    assert np.allclose(cam.K, expected_k)


def test_field_of_view_is_derived_not_stored():
    cam = _camera_at([2.0, 0.0, 0.0])
    # hfov = 2 atan(10 / (2*20)) = 2 atan(0.25) = 28.0724 deg
    assert cam.hfov_deg == pytest.approx(2 * math.degrees(math.atan(0.25)))
    assert cam.hfov_deg == pytest.approx(28.07248694)
    assert cam.vfov_deg == pytest.approx(2 * math.degrees(math.atan(0.125)))
    assert "fov_deg" not in cam.spec  # never stored, so it cannot drift


def test_explicit_principal_point_overrides_centre():
    cam = _camera_at([2.0, 0.0, 0.0], principalPoint_px=[510.0, 240.0])
    assert cam.principal_point == pytest.approx((510.0, 240.0))


# -- zoom ----------------------------------------------------------------

def test_zoom_defaults_to_one_and_is_not_stored():
    cam = _camera_at([2.0, 0.0, 0.0])
    assert cam.zoom_factor == pytest.approx(1.0)
    assert cam.effective_focal_length_mm == pytest.approx(cam.focal_length_mm)
    # 1x is the absence of a zoom rather than a value, so a plan that does not use
    # the feature keeps declaring format 1.0.
    assert "zoomFactor" not in cam.spec


def test_zoom_halves_the_field_of_view_and_doubles_the_focal_length():
    plain = _camera_at([2.0, 0.0, 0.0])
    zoomed = _camera_at([2.0, 0.0, 0.0], zoomFactor=2.0)

    assert zoomed.effective_focal_length_mm == pytest.approx(40.0)
    assert zoomed.focal_length_mm == pytest.approx(20.0)  # the lens is unchanged
    # hfov = 2 atan(10 / (2*40)) = 2 atan(0.125)
    assert zoomed.hfov_deg == pytest.approx(2 * math.degrees(math.atan(0.125)))
    assert math.tan(math.radians(zoomed.hfov_deg / 2)) == pytest.approx(
        math.tan(math.radians(plain.hfov_deg / 2)) / 2
    )


def test_zoom_scales_the_intrinsic_matrix():
    zoomed = _camera_at([2.0, 0.0, 0.0], zoomFactor=2.0)
    assert zoomed.fx == pytest.approx(4000.0)
    assert zoomed.fy == pytest.approx(4000.0)
    # The principal point is a sensor property, not an optical one.
    assert zoomed.principal_point == pytest.approx((499.5, 249.5))


def test_zoom_improves_the_ground_sample_distance():
    plain = _camera_at([2.0, 0.0, 0.0])
    zoomed = _camera_at([2.0, 0.0, 0.0], zoomFactor=2.0)
    assert zoomed.ground_sample_distance_m() == pytest.approx(
        plain.ground_sample_distance_m() / 2
    )


def test_zoom_narrows_what_the_camera_can_see():
    # A point at the edge of the unzoomed frame falls outside it at 2x. This is the
    # whole reason zoom is geometry rather than an annotation.
    plain = _camera_at([2.0, 0.0, 0.0], target=(0.0, 0.0, 0.0))
    zoomed = _camera_at([2.0, 0.0, 0.0], target=(0.0, 0.0, 0.0), zoomFactor=2.0)
    # Half the vertical field is atan(2.5/20) = 7.13 deg, which is 0.25 m of
    # height at the 2 m standoff. A bead at 0.2 m is inside that and outside half
    # of it.
    edge = np.array([0.0, 0.0, 0.2])
    assert plain.project(edge)[1] is True
    assert zoomed.project(edge)[1] is False


@pytest.mark.parametrize("bad", [0.0, -2.0, None, "2x"])
def test_a_nonsense_zoom_falls_back_to_one_rather_than_to_infinity(bad):
    # A plan is someone else's file, and a zero here would take every derived
    # quantity -- fx, both fields of view, the frustum -- to infinity.
    cam = _camera_at([2.0, 0.0, 0.0], zoomFactor=bad)
    assert cam.zoom_factor == pytest.approx(1.0)
    assert cam.fx == pytest.approx(2000.0)


# -- shipped presets -----------------------------------------------------

def _preset(preset_id):
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "presets", "cameras.json",
    )
    with io.open(path, encoding="utf-8") as fh:
        library = json.load(fh)
    return next(p for p in library["presets"] if p["id"] == preset_id)


def _fov_deg(preset):
    f = preset["focalLength_mm"]
    return tuple(2 * math.degrees(math.atan(s / (2 * f))) for s in preset["sensor_mm"])


def test_every_preset_has_a_sensor_and_a_positive_focal_length():
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "presets", "cameras.json",
    )
    with io.open(path, encoding="utf-8") as fh:
        presets = json.load(fh)["presets"]
    assert len({p["id"] for p in presets}) == len(presets)
    for p in presets:
        assert p["focalLength_mm"] > 0
        assert all(s > 0 for s in p["sensor_mm"])
        assert all(int(r) == r and r > 0 for r in p["resolution_px"])
        assert p["intrinsicsSource"] in ("nominal", "datasheet", "calibrated")


def test_the_a700_24_degree_preset_uses_the_printed_18_mm_lens():
    # The A700 24 deg f/1.0 science-kit sheet (P/N 85903-0102, rev. 98866) prints
    # 640 x 480 at 12 um pitch and the lens as 18 mm. Under a pinhole that is
    # 2 atan(7.68 / 36) = 24.09 x 2 atan(5.76 / 36) = 18.18 deg, against the 24 deg
    # designation, and 0.012 / 18 = 0.667 mrad/px. Until 2026-11-02 the preset
    # stored 18.07 mm, back-solved from the angle. See docs/datasheets/README.md.
    preset = _preset("flir-a700-24deg")
    assert preset["resolution_px"] == [640, 480]
    assert preset["sensor_mm"] == pytest.approx([640 * 0.012, 480 * 0.012])
    assert preset["focalLength_mm"] == pytest.approx(18.0)
    h, v = _fov_deg(preset)
    assert h == pytest.approx(24.09, abs=0.01)
    assert v == pytest.approx(18.18, abs=0.01)
    assert h == pytest.approx(24.0, abs=0.1)
    ifov_mrad = 0.012 / preset["focalLength_mm"] * 1000
    assert ifov_mrad == pytest.approx(0.667, abs=0.001)
    assert preset["intrinsicsSource"] == "datasheet"


def test_the_a700_body_carries_the_five_lenses_flir_prints():
    # Each lens's printed focal length, and the pinhole field of view it gives on
    # the 7.68 x 5.76 mm array: 2 atan(7.68 / 2f) x 2 atan(5.76 / 2f). For the 6,
    # 14 and 80 deg lenses that is not the printed angle (6 x 4.5, 14 x 10 and
    # 80 x 63 deg); the presets keep the printed focal length and the README shows
    # the mismatch. The palette places the 24 deg lens.
    base = _preset("flir-a700-24deg")
    expected = {
        6: (70.0, 6.28, 4.71),
        14: (29.0, 15.09, 11.34),
        24: (18.0, 24.09, 18.18),
        42: (10.0, 42.01, 32.13),
        80: (5.0, 75.05, 59.88),
    }
    for deg, (mm, h_deg, v_deg) in expected.items():
        preset = _preset("flir-a700-{}deg".format(deg))
        assert preset["body"] == "FLIR A700"
        assert preset["focalLength_mm"] == pytest.approx(mm)
        for key in ("modality", "resolution_px", "sensor_mm", "spectralBand_um",
                    "framerate_hz", "intrinsicsSource"):
            assert preset[key] == base[key], key
        h, v = _fov_deg(preset)
        assert h == pytest.approx(h_deg, abs=0.01)
        assert v == pytest.approx(v_deg, abs=0.01)
        assert bool(preset.get("bodyDefault")) == (deg == 24)


@pytest.mark.parametrize("preset_id, source, mm, fov", [
    # 320 x 240 at 25 um, the printed 9 mm: 2 atan(8 / 18) x 2 atan(6 / 18). The
    # sheet prints 51 x 38 deg, which no single focal length reproduces.
    ("flir-k65-9mm", "datasheet", 9.0, (47.92, 36.87)),
    # 160 x 120 at 12 um; f = 1.92 / (2 tan 27.5 deg) is back-solved from the
    # printed 55 deg, and gives 2 atan(1.44 / 2f) = 42.65 deg against 43 +/- 1.
    ("flir-one-pro-55deg", "datasheet", 1.84414, (55.00, 42.65)),
    # 2.8 mm and an extent inferred from 38.5 mm equivalent on the 36 x 24 mm
    # diagonal: D = 43.2666 x 2.8 / 38.5, W = 16 D / sqrt(337), H = 9 D / sqrt(337).
    ("canon-vixia-hf-r50-optical-wide", "nominal", 2.8, (52.19, 30.80)),
    # A review's 4 mm, the extent fitted to Apple's printed 60.983 deg horizontal
    # field for 1920 x 1080: W = 8 tan(30.4915 deg), H = 9 W / 16.
    ("iphone-x-rear-wide-1080p", "nominal", 4.0, (60.98, 36.65)),
])
def test_the_single_lens_presets_reproduce_their_documented_derivations(preset_id, source, mm, fov):
    preset = _preset(preset_id)
    assert "body" not in preset
    assert preset["intrinsicsSource"] == source
    assert preset["focalLength_mm"] == pytest.approx(mm)
    h, v = _fov_deg(preset)
    assert h == pytest.approx(fov[0], abs=0.01)
    assert v == pytest.approx(fov[1], abs=0.01)
    if preset["modality"] == "RGB":
        assert preset["spectralBand_um"] is None


def test_the_k65_and_one_pro_sensors_are_their_printed_arrays_at_the_printed_pitch():
    k65 = _preset("flir-k65-9mm")
    assert k65["resolution_px"] == [320, 240]
    assert k65["sensor_mm"] == pytest.approx([320 * 0.025, 240 * 0.025])
    assert k65["spectralBand_um"] == [8.0, 14.0]
    one = _preset("flir-one-pro-55deg")
    assert one["resolution_px"] == [160, 120]
    assert one["sensor_mm"] == pytest.approx([160 * 0.012, 120 * 0.012])
    assert one["focalLength_mm"] == pytest.approx(1.92 / (2 * math.tan(math.radians(27.5))), abs=1e-5)


def test_the_a8303sc_preset_derives_its_sensor_from_the_detector_pitch():
    # 1280 x 720 at 14 um, straight off the datasheet; the nominal 25 mm lens is
    # used as printed because pitch and lens designation agree for this camera.
    preset = _preset("flir-a8303sc-25mm")
    assert preset["resolution_px"] == [1280, 720]
    assert preset["sensor_mm"] == pytest.approx([1280 * 0.014, 720 * 0.014])
    assert preset["focalLength_mm"] == pytest.approx(25.0)
    h, v = _fov_deg(preset)
    assert h == pytest.approx(39.4, abs=0.1)
    assert v == pytest.approx(22.8, abs=0.1)
    assert preset["spectralBand_um"] == [3.0, 5.0]
    assert preset["intrinsicsSource"] == "datasheet"


def test_the_a8303sc_body_carries_the_four_lenses_its_datasheet_lists():
    # "Available Lenses: 17mm, 25 mm, 50 mm, 100 mm". One preset per lens, grouped
    # by body; the lenses differ in focal length and nothing else, and the palette
    # places the 25 mm one.
    base = _preset("flir-a8303sc-25mm")
    expected_fov = {17: (55.58, 33.03), 25: (39.44, 22.80), 50: (20.32, 11.51), 100: (10.24, 5.77)}
    for mm, (h_deg, v_deg) in expected_fov.items():
        preset = _preset("flir-a8303sc-{}mm".format(mm))
        assert preset["body"] == "FLIR A8303sc"
        assert preset["focalLength_mm"] == pytest.approx(mm)
        for key in ("modality", "resolution_px", "sensor_mm", "spectralBand_um",
                    "framerate_hz", "intrinsicsSource"):
            assert preset[key] == base[key], key
        h, v = _fov_deg(preset)
        assert h == pytest.approx(h_deg, abs=0.01)
        assert v == pytest.approx(v_deg, abs=0.01)
        assert bool(preset.get("bodyDefault")) == (mm == 25)


# -- extrinsics ----------------------------------------------------------

def test_stored_frame_is_opengl():
    """Camera at +X looking back at the origin, world up = +Z.

    Hand-derived: forward = (-1,0,0), so local +Z ('back') = (1,0,0).
    Up = (0,0,1). Right = up x back = (0,0,1) x (1,0,0) = (0,1,0).
    Columns of R are [right, up, back].
    """
    cam = _camera_at([2.0, 0.0, 0.0])
    expected = np.array([
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
    ])
    assert np.allclose(cam.rotation("opengl"), expected, atol=1e-12)
    assert np.allclose(cam.forward, [-1.0, 0.0, 0.0], atol=1e-12)
    assert np.allclose(cam.up, [0.0, 0.0, 1.0], atol=1e-12)
    assert np.allclose(cam.right, [0.0, 1.0, 0.0], atol=1e-12)


def test_opencv_frame_flips_y_and_z():
    """Same camera, hand-derived independently in the OpenCV frame.

    OpenCV +X = right = (0,1,0); +Y = down = (0,0,-1); +Z = forward = (-1,0,0).
    """
    cam = _camera_at([2.0, 0.0, 0.0])
    expected = np.column_stack([
        [0.0, 1.0, 0.0],    # right
        [0.0, 0.0, -1.0],   # down
        [-1.0, 0.0, 0.0],   # forward
    ])
    assert np.allclose(cam.rotation("opencv"), expected, atol=1e-12)
    # And the flip relationship holds in general.
    assert np.allclose(cam.rotation("opencv"), cam.rotation("opengl") @ np.diag([1.0, -1.0, -1.0]))


def test_opencv_is_the_default_convention():
    cam = _camera_at([2.0, 1.0, 1.5])
    assert np.allclose(cam.extrinsics(), cam.extrinsics("opencv"))
    assert not np.allclose(cam.extrinsics(), cam.extrinsics("opengl"))


def test_nerfstudio_matches_opengl_without_a_flip():
    cam = _camera_at([2.0, 1.0, 1.5])
    assert np.allclose(cam.rotation("nerfstudio"), cam.rotation("opengl"))


def test_world_to_camera_inverts_camera_to_world():
    cam = _camera_at([-2.7, 0.6, 1.5], target=(0.0, 0.0, 0.75))
    c2w = cam.extrinsics(world_to_camera=False)
    w2c = cam.extrinsics(world_to_camera=True)
    assert np.allclose(c2w @ w2c, np.eye(4), atol=1e-12)
    # Translation column of c2w is the camera position in world space.
    assert np.allclose(c2w[:3, 3], cam.position)


def test_unknown_convention_is_rejected_loudly():
    cam = _camera_at([2.0, 0.0, 0.0])
    with pytest.raises(ValueError, match="unknown convention"):
        cam.rotation("blender")


# -- projection ----------------------------------------------------------

def test_aim_target_lands_on_the_principal_point():
    cam = _camera_at([2.0, 0.0, 1.0], target=(0.0, 0.0, 0.5))
    uv, visible = cam.project(np.array([0.0, 0.0, 0.5]))
    assert visible
    assert uv == pytest.approx(cam.principal_point, abs=1e-9)


def test_a_point_above_the_target_projects_above_centre():
    """+v is DOWN in the OpenCV image frame, so higher in the world means smaller v."""
    cam = _camera_at([8.0, 0.0, 0.0], target=(0.0, 0.0, 0.0))
    uv, visible = cam.project(np.array([0.0, 0.0, 0.5]))
    assert visible
    assert uv[1] < cam.principal_point[1]
    assert uv[0] == pytest.approx(cam.principal_point[0])
    # Hand-derived: X_cam = (0, -0.5, 8), so v = cy - fy*0.0625 = 249.5 - 125 = 124.5.
    assert uv[1] == pytest.approx(124.5)


def test_a_point_outside_the_field_of_view_is_not_visible():
    """Same geometry, camera four times closer: the point is now off the top of the
    frame. This is the whole basis of the framing check, so it gets its own test."""
    cam = _camera_at([2.0, 0.0, 0.0], target=(0.0, 0.0, 0.0))
    uv, visible = cam.project(np.array([0.0, 0.0, 0.5]))
    assert not visible
    # X_cam = (0, -0.5, 2) -> v = 249.5 - 500 = -250.5, above row 0.
    assert uv[1] == pytest.approx(-250.5)
    assert not np.isnan(uv).any()  # in front of the camera, just out of frame


def test_points_behind_the_camera_are_nan_not_mirrored():
    """A naive pinhole maps points behind the camera to plausible-looking pixels.
    That false positive would silently claim a camera 'sees' the fire it faces away
    from, so behind-camera points must be NaN and never visible."""
    cam = _camera_at([2.0, 0.0, 0.0], target=(0.0, 0.0, 0.0))
    uv, visible = cam.project(np.array([10.0, 0.0, 0.0]))  # behind it
    assert not visible
    assert np.all(np.isnan(uv))


def test_project_accepts_batches():
    cam = _camera_at([4.0, 0.0, 0.5], target=(0.0, 0.0, 0.5))
    pts = np.array([[0.0, 0.0, 0.5], [0.0, 0.0, 50.0], [100.0, 0.0, 0.5]])
    uv, visible = cam.project(pts)
    assert uv.shape == (3, 2)
    assert visible.tolist() == [True, False, False]


def test_ground_sample_distance_uses_slant_range():
    cam = _camera_at([3.0, 0.0, 4.0], target=(0.0, 0.0, 0.0))
    assert cam.standoff_m == pytest.approx(5.0)
    assert cam.standoff_horizontal_m == pytest.approx(3.0)
    assert cam.ground_sample_distance_m() == pytest.approx(5.0 / 2000.0)


# -- quaternion helpers --------------------------------------------------

def test_quaternion_matrix_roundtrip():
    for target in [(0, 0, 0), (1, 2, 0.5), (-3, 0.2, 2.0)]:
        q = look_at_quat([2.0, 1.0, 1.5], target)
        assert np.allclose(matrix_to_quat(quat_to_matrix(q)), q, atol=1e-12)


def test_matrix_to_quat_uses_canonical_sign():
    """q and -q are the same rotation; pinning w >= 0 keeps re-saves diff-free."""
    for target in [(0, 0, 0), (1, 2, 0.5), (-3, 0.2, 2.0), (0.1, -5, -2)]:
        q = look_at_quat([2.0, 1.0, 1.5], target)
        assert q[3] >= 0.0


def test_look_straight_down_does_not_collapse():
    """The view axis is parallel to the world up hint here, so the naive cross
    product is zero and the fallback has to kick in."""
    q = look_at_quat([0.0, 0.0, 5.0], [0.0, 0.0, 0.0])
    r = quat_to_matrix(q)
    assert np.allclose(-r[:, 2], [0.0, 0.0, -1.0], atol=1e-12)  # forward is straight down
    assert np.allclose(r.T @ r, np.eye(3), atol=1e-12)          # still orthonormal


def test_look_straight_up_does_not_collapse():
    q = look_at_quat([0.0, 0.0, 0.5], [0.0, 0.0, 5.0])
    r = quat_to_matrix(q)
    assert np.allclose(-r[:, 2], [0.0, 0.0, 1.0], atol=1e-12)
    assert np.allclose(r.T @ r, np.eye(3), atol=1e-12)


def test_aim_at_keeps_quaternion_and_target_consistent():
    cam = _camera_at([2.0, 0.0, 1.0], target=(0.0, 0.0, 0.0))
    cam.aim_at([1.0, 1.0, 0.4])
    assert np.allclose(cam.aim_target, [1.0, 1.0, 0.4])
    direction = np.array([1.0, 1.0, 0.4]) - cam.position
    direction = direction / np.linalg.norm(direction)
    assert np.allclose(cam.forward, direction, atol=1e-12)
