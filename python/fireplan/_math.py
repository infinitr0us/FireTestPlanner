"""Quaternion and frame helpers.

Quaternions are XYZW ordered throughout, matching Three.js, so a value read from
the editor drops straight in. See CONVENTIONS.md section 3.
"""

from __future__ import annotations

import numpy as np

WORLD_UP = np.array([0.0, 0.0, 1.0])


def normalize(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    if n == 0.0:
        raise ValueError("cannot normalize a zero-length vector")
    return v / n


def quat_to_matrix(q) -> np.ndarray:
    """Unit quaternion (x, y, z, w) -> 3x3 rotation matrix, local-to-world."""
    x, y, z, w = (float(c) for c in q)
    n = (x * x + y * y + z * z + w * w) ** 0.5
    if n == 0.0:
        raise ValueError("zero-length quaternion")
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def matrix_to_quat(m: np.ndarray) -> np.ndarray:
    """3x3 rotation matrix -> unit quaternion (x, y, z, w).

    Shepperd's method: pick the branch with the largest divisor so the square root
    never operates on a near-zero value.
    """
    m = np.asarray(m, dtype=float)
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0.0:
        s = 0.5 / np.sqrt(t + 1.0)
        q = np.array(
            [
                (m[2, 1] - m[1, 2]) * s,
                (m[0, 2] - m[2, 0]) * s,
                (m[1, 0] - m[0, 1]) * s,
                0.25 / s,
            ]
        )
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = 2.0 * np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2])
        q = np.array(
            [
                0.25 * s,
                (m[0, 1] + m[1, 0]) / s,
                (m[0, 2] + m[2, 0]) / s,
                (m[2, 1] - m[1, 2]) / s,
            ]
        )
    elif m[1, 1] > m[2, 2]:
        s = 2.0 * np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2])
        q = np.array(
            [
                (m[0, 1] + m[1, 0]) / s,
                0.25 * s,
                (m[1, 2] + m[2, 1]) / s,
                (m[0, 2] - m[2, 0]) / s,
            ]
        )
    else:
        s = 2.0 * np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1])
        q = np.array(
            [
                (m[0, 2] + m[2, 0]) / s,
                (m[1, 2] + m[2, 1]) / s,
                0.25 * s,
                (m[1, 0] - m[0, 1]) / s,
            ]
        )
    q = q / np.linalg.norm(q)
    # Canonical sign: w >= 0, so q and -q (the same rotation) serialise identically
    # and a plan that was only re-saved produces an empty git diff.
    return -q if q[3] < 0.0 else q


def look_at_quat(eye, target, up_hint=WORLD_UP) -> np.ndarray:
    """Orientation that puts `target` on the view axis, in the stored OpenGL frame.

    The stored local frame looks down -Z with +Y up, so local +Z is 'back'
    (CONVENTIONS.md section 3).
    """
    eye = np.asarray(eye, dtype=float)
    target = np.asarray(target, dtype=float)
    delta = target - eye
    if np.linalg.norm(delta) == 0.0:
        raise ValueError("camera position and aim target coincide")

    back = normalize(-delta)
    up_hint = normalize(up_hint)

    # Straight up or straight down: the hint is parallel to the view axis and the
    # cross product collapses. Any perpendicular reference will do; +Y keeps the
    # roll stable as a camera tilts through vertical.
    if abs(float(np.dot(back, up_hint))) > 1.0 - 1e-9:
        up_hint = np.array([0.0, 1.0, 0.0])
        if abs(float(np.dot(back, up_hint))) > 1.0 - 1e-9:
            up_hint = np.array([1.0, 0.0, 0.0])

    right = normalize(np.cross(up_hint, back))
    up = np.cross(back, right)
    return matrix_to_quat(np.column_stack([right, up, back]))


def roll_of(q) -> float:
    """Roll from the level look-at frame, right-handed about forward, in (-pi, pi]."""
    actual = quat_to_matrix(q)
    level = quat_to_matrix(look_at_quat([0, 0, 0], -actual[:, 2]))
    up = actual[:, 1]
    roll = float(np.arctan2(np.dot(up, level[:, 0]), np.dot(up, level[:, 1])))
    return float(np.pi) if roll <= -np.pi else roll


def with_roll(q, roll: float) -> np.ndarray:
    """Keep the view direction and set absolute roll from its level look-at frame."""
    level = quat_to_matrix(look_at_quat([0, 0, 0], -quat_to_matrix(q)[:, 2]))
    right, up, back = level.T
    r = float(roll) % (2 * np.pi)
    if r > np.pi:
        r -= 2 * np.pi
    c, s = np.cos(r), np.sin(r)
    return matrix_to_quat(np.column_stack([right * c - up * s, up * c + right * s, back]))
