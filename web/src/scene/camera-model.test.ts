/**
 * The scene rules that can be pinned without a WebGL context: the projection the
 * picture-in-picture uses, what a pick is allowed to hit, and which layer a
 * ceiling lives on.
 */

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { imagePlaneExtents, projectToPixels } from '../core/plan';
import type { CameraObject, CeilingObject, WallObject } from '../core/types';
import { applyPlanCameraProjection, isShown, shownHits } from './camera-model';

const camera = (over: Partial<CameraObject['camera']> = {}): CameraObject => ({
  id: 'c', type: 'camera',
  transform: { position_m: [0, 0, 0], rotation_quat: [0, 0, 0, 1] },
  camera: {
    modality: 'RGB', resolution_px: [1000, 500], sensor_mm: [10, 10], focalLength_mm: 10, ...over,
  },
});

/** Where the plan's own projection puts a world point, in normalised device
 *  coordinates -- the frame the preview is drawn in. */
function ndcOf(plan: CameraObject, point: [number, number, number]): THREE.Vector3 {
  const cam = new THREE.PerspectiveCamera();
  const p = plan.transform!.position_m;
  const q = plan.transform!.rotation_quat!;
  cam.position.set(p[0], p[1], p[2]);
  cam.quaternion.set(q[0], q[1], q[2], q[3]);
  cam.updateMatrixWorld(true);
  applyPlanCameraProjection(cam, plan);
  return new THREE.Vector3(...point).project(cam);
}

describe('the preview projection', () => {
  it('agrees with the framing verdict for non-square pixels', () => {
    // A square sensor read out at 2:1 has fx = 2 fy. Built from vfov and aspect,
    // the preview showed this camera seeing [0.75, 0, -1] comfortably in frame;
    // `projectToPixels` puts it at u = 1249.5 in a 1000-pixel image.
    const plan = camera();
    expect(projectToPixels(plan, [0.75, 0, -1]).u).toBeCloseTo(1249.5, 6);
    expect(ndcOf(plan, [0.75, 0, -1]).x).toBeGreaterThan(1);
    // The right edge of the image is at u = 999.5, i.e. x/z = 0.5.
    expect(ndcOf(plan, [0.5, 0, -1]).x).toBeCloseTo(1, 6);
    expect(ndcOf(plan, [0, 0.5, -1]).y).toBeCloseTo(1, 6);
  });

  it('maps every pixel the same way the core does', () => {
    // NDC x of a point is 2 (u + 0.5) / W - 1 under the pixel-centre convention,
    // for any camera -- including one with an off-centre principal point.
    for (const plan of [camera(), camera({ principalPoint_px: [250, 200] })]) {
      const [w, h] = plan.camera.resolution_px;
      for (const point of [[0.3, 0.1, -2], [-0.4, -0.2, -1.5], [0.05, 0.25, -3]] as const) {
        const { u, v } = projectToPixels(plan, [...point]);
        const ndc = ndcOf(plan, [...point]);
        expect(ndc.x).toBeCloseTo((2 * (u + 0.5)) / w - 1, 6);
        expect(ndc.y).toBeCloseTo(1 - (2 * (v + 0.5)) / h, 6);
      }
    }
  });

  it('shifts the frame, not just its size, for an off-centre principal point', () => {
    const e = imagePlaneExtents(camera({ principalPoint_px: [250, 200] }));
    expect(e.left).toBeCloseTo(-250.5 / 1000, 9);
    expect(e.right).toBeCloseTo(749.5 / 1000, 9);
    expect(e.top).toBeCloseTo(200.5 / 500, 9);
    expect(e.bottom).toBeCloseTo(-299.5 / 500, 9);
    // And the centred case is symmetric, matching tan(fov / 2) exactly.
    const c = imagePlaneExtents(camera());
    expect(c.right).toBeCloseTo(-c.left, 12);
    expect(c.right).toBeCloseTo(0.5, 12);
  });
});

describe('what a pick may hit', () => {
  it('skips a mesh whose group is hidden, however deep it sits', () => {
    // Three's raycaster tests layers but not visibility, so a hidden wall kept
    // catching the clicks and measurements aimed at the gauge behind it.
    const root = new THREE.Group();
    const hidden = new THREE.Group();
    const inner = new THREE.Group();
    const mesh = new THREE.Mesh();
    inner.add(mesh);
    hidden.add(inner);
    root.add(hidden);
    const shown = new THREE.Mesh();
    root.add(shown);

    hidden.visible = false;
    expect(isShown(mesh, root)).toBe(false);
    expect(isShown(shown, root)).toBe(true);
    // The root itself is not consulted: it is the scene container, not an object.
    root.visible = false;
    expect(isShown(shown, root)).toBe(true);

    const hits = [{ object: mesh, distance: 1 }, { object: shown, distance: 2 }];
    expect(shownHits(hits, root).map((h) => h.distance)).toEqual([2]);
  });
});

describe('ceilings and the plan camera', () => {
  beforeAll(() => {
    // The builders make a CSS2D label per object, which needs a `document`. A stub
    // with the handful of members `CSS2DObject` and `makeLabel` touch is enough.
    const element = () => ({
      className: '', textContent: '',
      style: { setProperty(): void {} } as Record<string, unknown>,
      setAttribute(): void {},
      remove(): void {},
    });
    (globalThis as { document?: unknown }).document = { createElement: element };
  });

  it('puts every part of a ceiling on its own layer, and nothing else there', async () => {
    // Plan mode hides ceilings by switching this layer off on the editor's camera.
    // Leaving them out of the scene instead made the camera preview -- which
    // renders the same scene -- show a camera pointed at a ceiling seeing sky.
    const { buildCeiling, buildWall, LAYER_CEILING, LAYER_DEFAULT } = await import('./builders');
    const slab: CeilingObject = {
      id: 'c', type: 'ceiling', transform: { position_m: [0, 0, 0] },
      polygon_m: [[-1, -1], [1, -1], [1, 1], [-1, 1]], height_m: 3,
    };
    const wall: WallObject = {
      id: 'w', type: 'wall', transform: { position_m: [0, 0, 0] },
      polyline_m: [[0, 0], [2, 0]], height_m: 2.4,
    };
    const onCeiling = new THREE.Layers();
    onCeiling.set(LAYER_CEILING);
    const onDefault = new THREE.Layers();
    onDefault.set(LAYER_DEFAULT);

    let ceilingNodes = 0;
    buildCeiling(slab).traverse((o) => {
      ceilingNodes += 1;
      expect(o.layers.test(onCeiling)).toBe(true);
      expect(o.layers.test(onDefault)).toBe(false);
    });
    expect(ceilingNodes).toBeGreaterThan(1);

    buildWall(wall).traverse((o) => {
      expect(o.layers.test(onDefault)).toBe(true);
      expect(o.layers.test(onCeiling)).toBe(false);
    });

    // The preview camera enables both; the plan camera enables all but the ceiling.
    const preview = new THREE.Camera();
    preview.layers.set(LAYER_DEFAULT);
    preview.layers.enable(LAYER_CEILING);
    expect(preview.layers.test(onCeiling)).toBe(true);
    const plan = new THREE.Camera();
    plan.layers.enableAll();
    plan.layers.disable(LAYER_CEILING);
    expect(plan.layers.test(onCeiling)).toBe(false);
    expect(plan.layers.test(onDefault)).toBe(true);
  });
});
