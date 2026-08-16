/**
 * The one place an object's position is changed.
 *
 * Moving an object is not just writing three numbers: a camera carries an
 * `aimTarget_m` that records what it was pointed at, and a `mount.height_m` that
 * records how high its tripod stands. Every path that moves something -- palette
 * drop, gizmo drag, group drag, typed coordinates -- has to maintain the same
 * invariants, or the same camera ends up aimed differently depending on how it was
 * moved. Centralising that is what stops the four paths drifting apart.
 */

import { lookAtQuat } from './math';
import { isCamera } from './types';
import type { CameraObject, PlanObject, Vec3 } from './types';

const transformOf = (o: PlanObject): NonNullable<PlanObject['transform']> =>
  o.transform ?? (o.transform = { position_m: [0, 0, 0] });

/**
 * Move an object, keeping the rest of its transform meaningful.
 *
 * A camera with an aim target is re-aimed at that target: the target is the recorded
 * intent, and a camera carried across the room that keeps its old orientation is
 * pointing at nothing in particular while still claiming otherwise. A camera that
 * was rotated by hand has no target, so its orientation is left exactly as it is --
 * that hand rotation was the intent.
 */
export function setPosition(obj: PlanObject, position: Vec3): void {
  const t = transformOf(obj);
  t.position_m = [position[0], position[1], position[2]];

  const target = t.aimTarget_m;
  if (target) {
    // A target that has ended up under the lens cannot define a direction; leave the
    // last good orientation rather than throwing mid-drag.
    const far = Math.hypot(
      target[0] - position[0], target[1] - position[1], target[2] - position[2],
    ) > 1e-9;
    if (far) t.rotation_quat = lookAtQuat(position, target);
  }

  // Advisory, but it is what the equipment table prints as tripod height.
  if (isCamera(obj)) {
    const cam = obj as CameraObject;
    if (cam.mount) cam.mount.height_m = position[2];
  }
}

/**
 * Point a camera at a world point and record that as its intent.
 *
 * The quaternion stays authoritative; the target is what lets a later move re-derive
 * it instead of silently disagreeing with it.
 */
export function setAimTarget(cam: CameraObject, target: Vec3): void {
  const t = transformOf(cam);
  t.aimTarget_m = [target[0], target[1], target[2]];
  t.rotation_quat = lookAtQuat(t.position_m, t.aimTarget_m);
}

/**
 * Adopt a hand-set orientation.
 *
 * This invalidates the recorded aim rather than leaving a target the quaternion no
 * longer agrees with -- `checkPlan` would otherwise report an aim-mismatch the user
 * deliberately created.
 */
export function setRotation(obj: PlanObject, quat: [number, number, number, number]): void {
  const t = transformOf(obj);
  t.rotation_quat = [quat[0], quat[1], quat[2], quat[3]];
  t.aimTarget_m = null;
}
