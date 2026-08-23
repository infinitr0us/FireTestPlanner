/** Constructors for new plan objects, with defaults that are sane for a fire test
 *  rather than merely non-crashing. */

import { lookAtQuat } from './math';
import { firePointSourceM, fuelSurfaceZM, nextId, primaryBurner } from './plan';
import { specFromPreset, type CameraPreset } from './presets';
import type {
  BurnerObject,
  CameraObject,
  CeilingObject,
  HeatFluxSensorObject,
  HoodObject,
  PlanDocument,
  ThermocoupleObject,
  Vec3,
  WallObject,
} from './types';

/**
 * A sensible aim point: mid-flame if the plan has a burner with a known HRR,
 * otherwise 0.5 m above the origin. Cameras pointed at the pan rim miss the part
 * of the fire anyone actually wants to film, and a heat flux gauge aimed there is
 * not aimed at the emitter the point-source model assumes.
 */
export function defaultAimTarget(doc: PlanDocument): Vec3 {
  const source = firePointSourceM(doc);
  if (source) return source;
  const burner = primaryBurner(doc);
  return burner ? [0, 0, fuelSurfaceZM(burner) + 0.5] : [0, 0, 0.5];
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

export function createCeiling(doc: PlanDocument, position: Vec3 = [0, 0, 0]): CeilingObject {
  const [x, y] = position;
  const half = 3;
  return {
    id: nextId(doc, 'ceiling'),
    type: 'ceiling',
    name: 'Ceiling',
    transform: { position_m: [0, 0, 0] },
    polygon_m: [
      [x - half, y - half],
      [x + half, y - half],
      [x + half, y + half],
      [x - half, y + half],
    ],
    height_m: 3,
    thickness_m: 0.15,
  };
}

/**
 * A heat flux gauge, aimed at the fire.
 *
 * Aimed rather than axis-aligned because the gauge's orientation is not decoration:
 * the cos(theta) it contributes is a first-order term in what it reads, so a gauge
 * dropped facing an arbitrary direction would report a number that means nothing.
 */
export function createHeatFluxSensor(
  doc: PlanDocument,
  position: Vec3 = [-1.5, 0, 0.5],
): HeatFluxSensorObject {
  const target = defaultAimTarget(doc);
  return {
    id: nextId(doc, 'hf'),
    type: 'heatFluxSensor',
    name: 'Heat flux gauge',
    transform: {
      position_m: position,
      rotation_quat: lookAtQuat(position, target),
      aimTarget_m: target,
    },
    gauge: {
      kind: 'schmidt-boelter',
      range_kw_m2: 50,
      viewAngle_deg: 180,
      waterCooled: true,
      serial: null,
    },
    mount: { type: 'tripod', height_m: position[2] },
  };
}

/** A single-bead thermocouple. Add beads in the inspector to make it a rake --
 *  same object, longer list, which is why there is no separate 'tree' type. */
export function createThermocouple(
  doc: PlanDocument,
  position: Vec3 = [0.6, 0, 0.5],
): ThermocoupleObject {
  return {
    id: nextId(doc, 'tc'),
    type: 'thermocouple',
    name: 'Thermocouple',
    transform: { position_m: position },
    beadOffsets_m: [0],
    thermocouple: {
      tcType: 'K',
      beadDiameter_mm: 1.5,
      sheathed: true,
      maxTemperature_C: null,
    },
    // `position[2]`, not 0: `setPosition` rewrites this on every move because "a
    // gauge whose recorded mount height contradicts its own Z is a drawing waiting
    // to be wrong", and a thermocouple created 0.5 m up and recorded at 0 was born
    // wrong and stayed that way until first dragged.
    mount: { type: 'pole', height_m: position[2] },
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
