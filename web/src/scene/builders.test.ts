/**
 * What a ray through a built object finds, without a GPU. Labels are DOM nodes
 * and are stubbed out; nothing here casts at them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { reconstructedFlames } from '../core/plan';
import type { PlanDocument, ReconstructedFlameObject } from '../core/types';
import { shownHits } from './camera-model';
import { buildFlameProxy, buildWall } from './builders';

vi.mock('./labels', async () => {
  const three = await import('three');
  return { makeLabel: () => new three.Object3D(), disposeLabel: () => undefined };
});

const PLAN = fileURLToPath(new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url));
const doc = JSON.parse(readFileSync(PLAN, 'utf8')) as PlanDocument;
const linked = (): ReconstructedFlameObject => reconstructedFlames(doc)[0];
const unlinked = (): ReconstructedFlameObject => ({ ...linked(), linkedFiles: [] });

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
