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
import { isMounted } from './types';
import type { CameraObject, HeatFluxSensorObject, PlanObject, Vec3 } from './types';

/** Anything that records what it is pointed at. Cameras, and since 1.1 gauges. */
export type AimableObject = CameraObject | HeatFluxSensorObject;

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

  // Advisory, but it is what the equipment table prints as tripod height. Every
  // object that carries a mount block gets it, not just cameras: a gauge whose
  // recorded mount height contradicts its own Z is a drawing waiting to be wrong.
  if (isMounted(obj) && obj.mount) obj.mount.height_m = position[2];
}

/**
 * Point a camera or a gauge at a world point and record that as its intent.
 *
 * The quaternion stays authoritative; the target is what lets a later move re-derive
 * it instead of silently disagreeing with it. Returns false, having changed nothing,
 * when the target is the object's own position.
 */
export function setAimTarget(cam: AimableObject, target: Vec3): boolean {
  const t = transformOf(cam);
  const p = t.position_m;
  // The same guard `setPosition` carries, and for a sharper reason: since 1.1 an
  // instrument standing on the point source is a modelled state, not a mishap
  // (`gauge-in-fire`), and "Aim at fire" on one of those asks for the direction
  // from a point to itself. `lookAtQuat` throws on that -- and it was being called
  // AFTER `aimTarget_m` had been written, so the exception escaped the click
  // handler leaving a document aimed at its own position and the user told
  // nothing. Refuse the whole edit instead; the caller reports it.
  if (Math.hypot(target[0] - p[0], target[1] - p[1], target[2] - p[2]) < 1e-9) return false;
  t.aimTarget_m = [target[0], target[1], target[2]];
  t.rotation_quat = lookAtQuat(t.position_m, t.aimTarget_m);
  return true;
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
