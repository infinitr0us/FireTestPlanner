/**
 * Frame math. Mirror of python/fireplan/_math.py -- keep the two in step.
 *
 * Quaternions are XYZW. Rotation matrices are column-major-by-meaning: column i is
 * the world-space direction of the object's local axis i. CONVENTIONS.md section 3.
 */

import type { Quat, Vec3 } from './types';

export const WORLD_UP: Vec3 = [0, 0, 1];
export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

export type Mat3 = [Vec3, Vec3, Vec3]; // [col0, col1, col2]

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function normalize(v: Vec3): Vec3 {
  const n = length(v);
  if (n === 0) throw new Error('cannot normalize a zero-length vector');
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Columns are the world directions of the local x, y, z axes. */
export function quatToColumns(q: Quat): Mat3 {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n === 0) throw new Error('zero-length quaternion');
  const [x, y, z, w] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** Shepperd's method, with the sign pinned to w >= 0 so re-saves stay diff-free. */
export function columnsToQuat(m: Mat3): Quat {
  const [c0, c1, c2] = m;
  // m[row][col]
  const m00 = c0[0], m10 = c0[1], m20 = c0[2];
  const m01 = c1[0], m11 = c1[1], m21 = c1[2];
  const m02 = c2[0], m12 = c2[1], m22 = c2[2];

  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  const out: Quat = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  return out[3] < 0 ? [-out[0], -out[1], -out[2], -out[3]] : out;
}

/**
 * Orientation that puts `target` on the view axis, in the stored OpenGL frame:
 * looks down local -Z with local +Y up, so local +Z is 'back'.
 */
export function lookAtQuat(eye: Vec3, target: Vec3, upHint: Vec3 = WORLD_UP): Quat {
  const delta = sub(target, eye);
  if (length(delta) === 0) throw new Error('position and aim target coincide');

  const back = normalize([-delta[0], -delta[1], -delta[2]]);
  let hint = normalize(upHint);

  // Looking straight up or down: the hint is parallel to the view axis and the
  // cross product collapses.
  if (Math.abs(dot(back, hint)) > 1 - 1e-9) {
    hint = [0, 1, 0];
    if (Math.abs(dot(back, hint)) > 1 - 1e-9) hint = [1, 0, 0];
  }

  const right = normalize(cross(hint, back));
  const up = cross(back, right);
  return columnsToQuat([right, up, back]);
}

/** World-space view direction: the stored frame looks down local -Z. */
export function forwardOf(q: Quat): Vec3 {
  const c = quatToColumns(q)[2];
  return [-c[0], -c[1], -c[2]];
}

export const upOf = (q: Quat): Vec3 => quatToColumns(q)[1];
export const rightOf = (q: Quat): Vec3 => quatToColumns(q)[0];

/** Angle in degrees between two directions. */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const c = Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))));
  return (Math.acos(c) * 180) / Math.PI;
}
