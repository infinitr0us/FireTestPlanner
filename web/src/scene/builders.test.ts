/**
 * What a ray through a built object finds, without a GPU. Labels are DOM nodes
 * and are stubbed out; nothing here casts at them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { lookAtQuat } from '../core/math';
import { burnerFlameHeightM, reconstructedFlames, standoffM } from '../core/plan';
import type { BurnerObject, CameraObject, PlanDocument, ReconstructedFlameObject, WallObject } from '../core/types';
import { shownHits } from './camera-model';
import { buildBurner, buildCamera, buildFlameProxy, buildWall, labelPoint, buildNewInstrument } from './builders';
import { createVelocityProbe, createGasSampling, createLoadCell } from '../core/factory';
import { newPlan, objectColor } from '../core/plan';

vi.mock('./labels', async () => {
  const three = await import('three');
  return { makeLabel: () => new three.Object3D(), disposeLabel: () => undefined };
});

const PLAN = fileURLToPath(new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url));
const doc = JSON.parse(readFileSync(PLAN, 'utf8')) as PlanDocument;
const linked = (): ReconstructedFlameObject => reconstructedFlames(doc)[0];
const unlinked = (): ReconstructedFlameObject => ({ ...linked(), linkedFiles: [] });

it('builds distinct instrument glyphs with recorded transforms and explicit colors', () => {
  const plan = newPlan(), probe = createVelocityProbe(plan), gas = createGasSampling(plan), cell = createLoadCell(plan);
  cell.platform_m = [1, 0.5]; cell.display = { color: '#123456' };
  for (const [obj, shape] of [[probe, 'CylinderGeometry'], [gas, 'TorusGeometry'], [cell, 'BoxGeometry']] as const) {
    const built = buildNewInstrument(obj), mesh = built.children[0] as THREE.Mesh;
    expect(built.userData.planId).toBe(obj.id);
    expect(mesh.geometry.type).toBe(shape);
    expect('#' + (mesh.material as THREE.MeshStandardMaterial).color.getHexString()).toBe(objectColor(obj));
    expect(built.position.toArray()).toEqual(obj.transform!.position_m);
  }
  delete probe.transform!.rotation_quat;
  expect((buildNewInstrument(probe).children[0] as THREE.Mesh).geometry.type).toBe('SphereGeometry');
});

/**
 * The viewport's two readings of one ray, cast straight down at (x, y): the object
 * `pick` selects, and the surface point `pickPoint` measures -- the nearest hit
 * that is not selection-only, or null where the ruler falls through to the floor.
 */
function fromAbove(root: THREE.Group, x: number, y: number): { picked: string | null; measured: THREE.Vector3 | null } {
  root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(x, y, 10), new THREE.Vector3(0, 0, -1));
  const hits = shownHits(ray.intersectObjects(root.children, true), root);
  let picked: string | null = null;
  for (let node: THREE.Object3D | null = hits[0]?.object ?? null; node && picked === null; node = node.parent) {
    if (typeof node.userData.planId === 'string') picked = node.userData.planId;
  }
  const surface = hits.find((h) => !h.object.userData.selectionOnly);
  return { picked, measured: surface ? surface.point.clone() : null };
}

describe('the flame proxy', () => {
  it('selects the flame through its envelope but is not a surface a ruler can land on', () => {
    // The envelope spans every frame; the frame on screen may be empty.
    const root = new THREE.Group();
    root.add(buildFlameProxy(linked()));
    const reading = fromAbove(root, 0, 0);
    expect(reading.picked).toBe('flame-main');
    expect(reading.measured).toBeNull();
  });

  it('marks the unlinked placeholder the same way', () => {
    // A 0.25 m wireframe for a link not yet made: the ruler used to read z = 0.25
    // at its centre, where the floor is.
    const root = new THREE.Group();
    root.add(buildFlameProxy(unlinked()));
    const reading = fromAbove(root, 0, 0);
    expect(reading.picked).toBe('flame-main');
    expect(reading.measured).toBeNull();
  });

  it('lets the ruler through to the equipment behind either marker', () => {
    // A wall top under the placeholder: the measurement lands on it, not on the marker.
    const wall = buildWall({
      id: 'w', type: 'wall', polyline_m: [[-1, 0], [1, 0]], height_m: 0.1, thickness_m: 0.3, baseHeight_m: 0, openings: [],
    });
    for (const flame of [linked(), unlinked()]) {
      const root = new THREE.Group();
      root.add(buildFlameProxy(flame), wall);
      const reading = fromAbove(root, 0, 0);
      expect(reading.picked).toBe('flame-main');
      expect(reading.measured?.z).toBeCloseTo(0.1, 6);
    }
  });

  it('is skipped entirely, for picking and measuring, while the flame is hidden', () => {
    const root = new THREE.Group();
    root.add(buildFlameProxy({ ...unlinked(), display: { visible: false } }));
    expect(fromAbove(root, 0, 0)).toEqual({ picked: null, measured: null });
  });
});

// -- review 2026-09-22 ------------------------------------------------------

/** Whether a horizontal ray through (x, z), heading +Y, meets the wall. */
function wallAt(wall: THREE.Group, x: number, z: number): boolean {
  wall.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(x, -5, z), new THREE.Vector3(0, 1, 0));
  return ray.intersectObjects(wall.children, true).length > 0;
}

const wallWith = (openings: WallObject['openings']): WallObject => ({
  id: 'w', type: 'wall', polyline_m: [[0, 0], [4, 0]], height_m: 2.5, thickness_m: 0.2, baseHeight_m: 0, openings,
});

describe('wall openings (SCN-7)', () => {
  it('cuts the union of overlapping openings', () => {
    // A door (1-2 m, to 2.1 m) and a window running into it (1.6-2.6 m, 1.0-1.6 m):
    // each used to build its sill and lintel back across the other.
    const wall = buildWall(wallWith([
      { offset_m: 1, width_m: 1, sillHeight_m: 0, height_m: 2.1 },
      { offset_m: 1.6, width_m: 1, sillHeight_m: 1, height_m: 0.6 },
    ] as WallObject['openings']));
    for (const z of [0.5, 1.3, 1.9]) expect(wallAt(wall, 1.8, z)).toBe(false);
    expect(wallAt(wall, 1.8, 2.3)).toBe(true); // the door's lintel
    expect([0.5, 1.3, 1.9].map((z) => wallAt(wall, 2.4, z))).toEqual([true, false, true]);
    expect(wallAt(wall, 3.5, 1.3)).toBe(true);
  });

  it('builds a lone opening from the same three boxes as before', () => {
    const wall = buildWall(wallWith([{ offset_m: 1, width_m: 1, sillHeight_m: 0, height_m: 2.1 }] as WallObject['openings']));
    expect(wall.children.filter((c) => (c as THREE.Mesh).isMesh)).toHaveLength(3);
  });
});

describe('scene geometry (review 2026-09-22)', () => {
  const burner = (): BurnerObject => structuredClone(doc.objects.find((o) => o.id === 'burner-main')) as BurnerObject;

  it('starts the predicted flame at the fuel surface the checks use (SCN-6)', () => {
    for (const rim of [0, 0.1]) {
      const b = { ...burner(), rimHeight_m: rim };
      const group = buildBurner(b, true);
      const cone = group.children.find((c) => c.userData.selectionOnly)!;
      const box = new THREE.Box3().setFromObject(cone);
      expect(box.min.z).toBeCloseTo(rim, 6);
      expect(box.max.z).toBeCloseTo(rim + burnerFlameHeightM(b)!, 6);
    }
  });

  it('draws a non-unit quaternion as the rotation it stands for (SCN-4)', () => {
    const wall = buildWall({ ...wallWith([]), transform: { position_m: [0, 0, 0], rotation_quat: [0, 0, 1, 1] } });
    expect(wall.quaternion.length()).toBeCloseTo(1, 12);
    wall.updateMatrixWorld(true);
    const end = new THREE.Vector3(4, 0, 0).applyMatrix4(wall.matrixWorld);
    expect([end.x, end.y, end.z].map((v) => Number(v.toFixed(9)))).toEqual([0, 4, 0]);
  });

  it('reaches past the fire from any standoff (SCN-8)', () => {
    for (const x of [3, 15, 20]) {
      const position: [number, number, number] = [-x, 0, 1.5];
      const cam = {
        id: 'c', type: 'camera', transform: { position_m: position, rotation_quat: lookAtQuat(position, [0, 0, 0]) },
        camera: { modality: 'RGB', resolution_px: [1920, 1080], sensor_mm: [6.17, 4.55], focalLength_mm: 4.3 },
      } as CameraObject;
      const group = buildCamera(cam, true);
      const lines = group.getObjectByProperty('type', 'LineSegments')!;
      const box = new THREE.Box3().setFromBufferAttribute(
        (lines as THREE.LineSegments).geometry.getAttribute('position') as THREE.BufferAttribute);
      expect(-box.min.z).toBeGreaterThan(standoffM(cam));
    }
  });

  it('labels an L-shaped ceiling over the slab (SCN-11)', () => {
    const l: Array<[number, number]> = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
    const [x, y] = labelPoint(l);
    expect(x >= 0 && x <= 4 && y >= 0 && y <= 1 || x >= 0 && x <= 1 && y >= 0 && y <= 4).toBe(true);
    expect(labelPoint([[0, 0], [2, 0], [2, 2], [0, 2]])).toEqual([1, 1]);
  });
});
