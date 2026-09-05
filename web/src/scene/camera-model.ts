/**
 * The bits of Three.js scene work that are pure enough to unit test: the projection
 * a plan camera implies, and whether a picked node is actually on screen.
 *
 * Kept apart from viewport.ts, which needs a WebGL context and a DOM to even
 * construct, so the two rules below can be pinned in a plain Node test.
 */

import * as THREE from 'three';

import { imagePlaneExtents } from '../core/plan';
import type { CameraObject } from '../core/types';

/**
 * Give `camera` the projection `plan` describes -- the same fx, fy and principal
 * point `projectToPixels` uses -- rather than a symmetric frustum from a vertical
 * field of view and a pixel aspect ratio.
 *
 * The two agree only for square pixels and a centred principal point. A 2:1 image
 * on a square sensor has fx = 2 fy, and the preview built from vfov and aspect
 * showed the camera seeing 50 percent wider than the framing verdict said; an
 * off-centre calibrated principal point shifts the frame and a symmetric frustum
 * cannot show that at all. `makePerspective` takes the four edges directly, so the
 * picture-in-picture is the image the plan's numbers describe.
 *
 * Callers must not call `updateProjectionMatrix()` afterwards: that rebuilds the
 * symmetric matrix from `fov` and `aspect` and undoes this.
 */
export function applyPlanCameraProjection(
  camera: THREE.PerspectiveCamera, plan: CameraObject, near = 0.05, far = 300,
): void {
  const e = imagePlaneExtents(plan);
  camera.near = near;
  camera.far = far;
  camera.projectionMatrix.makePerspective(
    e.left * near, e.right * near, e.top * near, e.bottom * near, near, far,
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/**
 * Whether `node` is drawn: itself and every ancestor up to (not including) `root`
 * visible.
 *
 * Three's raycaster tests layers but not visibility, so a hidden object's meshes
 * still answered picks and measurements -- hiding a wall did not let a click reach
 * the gauge behind it, and the measure tool snapped to a surface nobody could see.
 * Visibility is set on the object's group, so the whole chain has to be walked.
 */
export function isShown(node: THREE.Object3D, root: THREE.Object3D | null = null): boolean {
  for (let n: THREE.Object3D | null = node; n !== null && n !== root; n = n.parent) {
    if (!n.visible) return false;
  }
  return true;
}

/** `hits` with everything that is not actually drawn taken out, order kept. */
export const shownHits = <T extends { object: THREE.Object3D }>(hits: T[], root: THREE.Object3D): T[] =>
  hits.filter((hit) => isShown(hit.object, root));
