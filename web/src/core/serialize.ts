/**
 * Canonical JSON writer. Mirror of python/fireplan/serialize.py.
 *
 * The two must produce byte-identical output: a plan saved from the editor and the
 * same plan saved from Python have to be the same file, or every handoff shows up
 * as a spurious diff. `web/src/core/__tests__/serialize.test.ts` asserts this
 * against the committed fixture.
 */

import type { PlanDocument } from './types';

/** 1 um -- finer than any tape measure on a test site, coarse enough to kill float noise. */
const FLOAT_DECIMALS = 6;

const TOP = ['format', 'version', 'meta', 'units', 'coordinateSystem', 'environment', 'objects'];
const META = ['title', 'testId', 'author', 'organization', 'siteName', 'created', 'modified', 'revision', 'notes'];
const UNITS = ['length', 'angle', 'power', 'temperature', 'display'];
const UNITS_DISPLAY = ['length', 'angle'];
const COORD = ['convention', 'origin', 'northAzimuth_rad'];
const ENV = ['floorSize_m', 'ceilingHeight_m', 'ambientTemperature_C', 'notes'];

const TRANSFORM = ['position_m', 'rotation_quat', 'aimTarget_m'];
const DISPLAY = ['color', 'visible', 'locked'];
const CAMERA_SPEC = [
  'modality', 'presetId', 'resolution_px', 'sensor_mm', 'focalLength_mm',
  'principalPoint_px', 'distortion', 'intrinsicsSource', 'spectralBand_um', 'framerate_hz',
];
const DISTORTION = ['model', 'coefficients'];
const MOUNT = ['type', 'height_m'];
const FOOTPRINT = ['shape', 'diameter_m', 'size_m'];
const FIRE = ['fuel', 'hrr_kw', 'hrrCurve'];
const DUCT = ['diameter_m', 'length_m'];
const OPENING = ['id', 'offset_m', 'width_m', 'height_m', 'sillHeight_m'];

const OBJECT_ORDER: Record<string, string[]> = {
  camera: ['id', 'type', 'name', 'transform', 'camera', 'mount', 'recording', 'display', 'notes'],
  burner: ['id', 'type', 'name', 'transform', 'footprint', 'rimHeight_m', 'fire', 'display', 'notes'],
  hood: ['id', 'type', 'name', 'transform', 'opening_m', 'height_m', 'skirtDepth_m', 'duct', 'display', 'notes'],
  wall: ['id', 'type', 'name', 'transform', 'polyline_m', 'height_m', 'thickness_m', 'baseHeight_m', 'openings', 'display', 'notes'],
  ceiling: ['id', 'type', 'name', 'transform', 'polygon_m', 'height_m', 'thickness_m', 'display', 'notes'],
};
const OBJECT_FALLBACK = ['id', 'type', 'name', 'transform', 'display', 'notes'];

type Json = unknown;
type Obj = Record<string, Json>;

const isPlainObject = (v: Json): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function roundFloats(value: Json): Json {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value === 0 ? 0 : value;
    const f = 10 ** FLOAT_DECIMALS;
    const r = Math.round(value * f) / f;
    // Collapse -0 so a mirrored object does not diff against itself.
    return r === 0 ? 0 : r;
  }
  if (Array.isArray(value)) return value.map(roundFloats);
  if (isPlainObject(value)) {
    const out: Obj = {};
    for (const k of Object.keys(value)) out[k] = roundFloats(value[k]);
    return out;
  }
  return value;
}

/** Known keys in order, then anything else in its existing order.
 *  The tail is what keeps unknown keys from a newer format version alive. */
function order(d: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (k in d) out[k] = d[k];
  for (const k of Object.keys(d)) if (!(k in out)) out[k] = d[k];
  return out;
}

const orderIfObject = (v: Json, keys: string[]): Json =>
  isPlainObject(v) ? order(v, keys) : v;

function canonObject(raw: Obj): Obj {
  const o: Obj = { ...raw };

  if ('transform' in o) o.transform = orderIfObject(o.transform, TRANSFORM);
  if ('display' in o) o.display = orderIfObject(o.display, DISPLAY);

  switch (o.type) {
    case 'camera': {
      if (isPlainObject(o.camera)) {
        const spec = order(o.camera, CAMERA_SPEC);
        if (isPlainObject(spec.distortion)) spec.distortion = order(spec.distortion, DISTORTION);
        o.camera = spec;
      }
      if ('mount' in o) o.mount = orderIfObject(o.mount, MOUNT);
      break;
    }
    case 'burner': {
      if ('footprint' in o) o.footprint = orderIfObject(o.footprint, FOOTPRINT);
      if ('fire' in o) o.fire = orderIfObject(o.fire, FIRE);
      break;
    }
    case 'hood': {
      if (isPlainObject(o.duct)) o.duct = order(o.duct, DUCT);
      break;
    }
    case 'wall': {
      if (Array.isArray(o.openings)) {
        o.openings = o.openings.map((x) => orderIfObject(x, OPENING));
      }
      break;
    }
    default:
      break;
  }

  return order(o, OBJECT_ORDER[String(o.type)] ?? OBJECT_FALLBACK);
}

export function canonicalize(data: PlanDocument): Obj {
  const d: Obj = { ...(data as unknown as Obj) };
  if ('meta' in d) d.meta = orderIfObject(d.meta, META);
  if (isPlainObject(d.units)) {
    const units = order(d.units, UNITS);
    if (isPlainObject(units.display)) units.display = order(units.display, UNITS_DISPLAY);
    d.units = units;
  }
  if ('coordinateSystem' in d) d.coordinateSystem = orderIfObject(d.coordinateSystem, COORD);
  if ('environment' in d) d.environment = orderIfObject(d.environment, ENV);
  if (Array.isArray(d.objects)) {
    d.objects = d.objects.map((o) => (isPlainObject(o) ? canonObject(o) : o));
  }
  return roundFloats(order(d, TOP)) as Obj;
}

/**
 * Matches an array whose entire content is numeric. No quotes, braces or nested
 * brackets in the class, so strings and object arrays never match, and a polyline's
 * inner pairs collapse while the outer array stays expanded.
 */
const NUMERIC_ARRAY = /\[[\s0-9eE.,+-]*\]/g;

function collapseNumericArrays(text: string): string {
  return text.replace(NUMERIC_ARRAY, (match) => {
    // Only collapse arrays JSON.stringify actually broke across lines. Without this,
    // a numeric-looking substring inside a `notes` string would get rewritten.
    if (!match.includes('\n')) return match;
    const parts = match
      .slice(1, -1)
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return `[${parts.join(', ')}]`;
  });
}

/** Serialise to canonical JSON text, newline-terminated. */
export function serializePlan(data: PlanDocument): string {
  return collapseNumericArrays(JSON.stringify(canonicalize(data), null, 2)) + '\n';
}
