/** Constructors for new plan objects, with defaults that are sane for a fire test
 *  rather than merely non-crashing. */

import { lookAtQuat } from './math';
import { flameTipZM, fuelSurfaceZM, nextId, primaryBurner } from './plan';
import { specFromPreset, type CameraPreset } from './presets';
import type {
  BurnerObject,
  CameraObject,
  HoodObject,
  PlanDocument,
  Vec3,
  WallObject,
} from './types';

/**
 * A sensible aim point: mid-flame if the plan has a burner with a known HRR,
 * otherwise 0.5 m above the origin. Cameras pointed at the pan rim miss the part
 * of the fire anyone actually wants to film.
 */
export function defaultAimTarget(doc: PlanDocument): Vec3 {
  const burner = primaryBurner(doc);
  if (!burner) return [0, 0, 0.5];
  const base = fuelSurfaceZM(burner);
  const tip = flameTipZM(burner);
  return tip === null ? [0, 0, base + 0.5] : [0, 0, (base + tip) / 2];
}

export function createBurner(doc: PlanDocument, position: Vec3 = [0, 0, 0]): BurnerObject {
  return {
    id: nextId(doc, 'burner'),
    type: 'burner',
    name: 'Fuel pan',
    transform: { position_m: position },
    footprint: { shape: 'square', size_m: [0.3, 0.3] },
    rimHeight_m: 0.1,
    fire: { fuel: 'n-heptane', hrr_kw: 100, hrrCurve: null },
  };
}

export function createHood(doc: PlanDocument, position: Vec3 = [0, 0, 0]): HoodObject {
  return {
    id: nextId(doc, 'hood'),
    type: 'hood',
    name: 'Calorimeter hood',
    transform: { position_m: [position[0], position[1], 0] },
    opening_m: [2.4, 2.4],
    height_m: 2.7,
    skirtDepth_m: 0.3,
    duct: { diameter_m: 0.6, length_m: 2 },
  };
}

export function createWall(doc: PlanDocument, position: Vec3 = [0, 0, 0]): WallObject {
  const [x, y] = position;
  return {
    id: nextId(doc, 'wall'),
    type: 'wall',
    name: 'Wall',
    transform: { position_m: [0, 0, 0] },
    polyline_m: [
      [x - 1.5, y],
      [x + 1.5, y],
    ],
    height_m: 2.4,
    thickness_m: 0.1,
    baseHeight_m: 0,
    openings: [],
  };
}

export function createCamera(
  doc: PlanDocument,
  preset: CameraPreset,
  position: Vec3,
): CameraObject {
  const target = defaultAimTarget(doc);
  const quat = lookAtQuat(position, target);
  return {
    id: nextId(doc, `cam-${preset.modality.toLowerCase()}`),
    type: 'camera',
    name: preset.label.split('—')[0].trim(),
    transform: { position_m: position, rotation_quat: quat, aimTarget_m: target },
    camera: specFromPreset(preset),
    mount: { type: 'tripod', height_m: position[2] },
    recording: null,
  };
}

/** Default drop position for a camera placed without a pointer location: on the
 *  -X side at a 3 m standoff and 1.5 m tripod height, spread so successive cameras
 *  form a row rather than stacking. */
export function defaultCameraPosition(doc: PlanDocument): Vec3 {
  const existing = doc.objects.filter((o) => o.type === 'camera').length;
  return [-3, (existing % 5) * 0.5 - 1, 1.5];
}
