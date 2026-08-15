"""Camera intrinsics, extrinsics and projection.

The frame conversions are the highest-risk code in the package -- a silent axis flip
here costs a data scientist a week -- so the expected matrices below are derived by
hand in the comments rather than by calling the code under test.
"""

from __future__ import annotations

import math

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
