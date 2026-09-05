/**
 * Canonical JSON writer. Mirror of python/fireplan/serialize.py.
 *
 * The two must produce byte-identical output: a plan saved from the editor and the
 * same plan saved from Python have to be the same file, or every handoff shows up
 * as a spurious diff. `web/src/core/__tests__/serialize.test.ts` asserts this
 * against the committed fixture.
 */

import { maxVersion, requiredFormatVersion, type PlanDocument } from './types';

/** 1 um -- finer than any tape measure on a test site, coarse enough to kill float noise. */
const FLOAT_DECIMALS = 6;

const TOP = ['format', 'version', 'meta', 'units', 'coordinateSystem', 'environment', 'objects'];
const META = ['title', 'testId', 'author', 'organization', 'siteName', 'created', 'modified', 'revision', 'notes', 'source'];
const SOURCE = ['tool', 'file', 'chid', 'importedAt', 'originOffset_m'];
const UNITS = ['length', 'angle', 'power', 'temperature', 'display'];
const UNITS_DISPLAY = ['length', 'angle'];
const COORD = ['convention', 'origin', 'northAzimuth_rad'];
const ENV = ['floorSize_m', 'ceilingHeight_m', 'ambientTemperature_C', 'notes'];

const TRANSFORM = ['position_m', 'rotation_quat', 'aimTarget_m'];
const DISPLAY = ['color', 'visible', 'locked'];
const CAMERA_SPEC = [
  'modality', 'presetId', 'resolution_px', 'sensor_mm', 'focalLength_mm', 'zoomFactor',
  'principalPoint_px', 'distortion', 'intrinsicsSource', 'spectralBand_um', 'framerate_hz',
];
const DISTORTION = ['model', 'coefficients'];
const MOUNT = ['type', 'height_m'];
const FOOTPRINT = ['shape', 'diameter_m', 'size_m'];
const FIRE = ['fuel', 'hrr_kw', 'radiativeFraction', 'hrrCurve'];
const DUCT = ['diameter_m', 'length_m'];
const OPENING = ['id', 'offset_m', 'width_m', 'height_m', 'sillHeight_m'];
const GAUGE = ['kind', 'range_kw_m2', 'viewAngle_deg', 'waterCooled', 'serial'];
const THERMOCOUPLE = ['tcType', 'beadDiameter_mm', 'sheathed', 'maxTemperature_C'];

const OBJECT_ORDER: Record<string, string[]> = {
  camera: ['id', 'type', 'name', 'transform', 'camera', 'mount', 'recording', 'display', 'notes'],
  burner: ['id', 'type', 'name', 'transform', 'footprint', 'rimHeight_m', 'fire', 'display', 'notes'],
  hood: ['id', 'type', 'name', 'transform', 'opening_m', 'height_m', 'skirtDepth_m', 'duct', 'display', 'notes'],
  wall: ['id', 'type', 'name', 'transform', 'polyline_m', 'height_m', 'thickness_m', 'baseHeight_m', 'openings', 'display', 'notes'],
  ceiling: ['id', 'type', 'name', 'transform', 'polygon_m', 'height_m', 'thickness_m', 'display', 'notes'],
  heatFluxSensor: ['id', 'type', 'name', 'transform', 'gauge', 'mount', 'display', 'notes'],
  thermocouple: ['id', 'type', 'name', 'transform', 'beadOffsets_m', 'thermocouple', 'mount', 'display', 'notes'],
  obstruction: ['id', 'type', 'name', 'transform', 'size_m', 'display', 'notes'],
};

type Json = unknown;
type Obj = Record<string, Json>;

const isPlainObject = (v: Json): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Own-property membership, never `in`.
 *
 * `'constructor' in {}` is true, and so is `'toString' in {}`: those names live on
 * every object's prototype. With `in`, a legitimate extra key called `constructor`
 * was treated as already emitted and dropped, and an unknown object whose `type`
 * was `constructor` was routed to the known-type path and handed
 * `Object.prototype.constructor` as its key order -- which is not iterable, so the
 * save threw. Uncommon names, but preserving unknown content is a promise this
 * format makes (CONVENTIONS section 6), and a promise with a hole in it is not one.
 */
const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

function roundFloats(value: Json): Json {
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value;
    const f = 10 ** FLOAT_DECIMALS;
    return Math.round(value * f) / f;
  }
  if (Array.isArray(value)) return value.map(roundFloats);
  if (isPlainObject(value)) {
    const out: Obj = Object.create(null);
    for (const k of Object.keys(value)) out[k] = roundFloats(value[k]);
    return out;
  }
  return value;
}

/** Known keys in order, then anything else in its existing order.
 *  The tail is what keeps unknown keys from a newer format version alive. */
function order(d: Obj, keys: string[]): Obj {
  // A JSON key named __proto__ is data, not the legacy prototype setter.
  const out: Obj = Object.create(null);
  const emitted = new Set<string>();
  for (const k of keys) {
    if (hasOwn(d, k)) {
      out[k] = d[k];
      emitted.add(k);
    }
  }
  for (const k of Object.keys(d)) if (!emitted.has(k)) out[k] = d[k];
  return out;
}

const orderIfObject = (v: Json, keys: string[]): Json =>
  isPlainObject(v) ? order(v, keys) : v;

/**
 * Drop a 1.1-only key that is present but null.
 *
 * Null and absent mean the same thing to every reader of this format, and the
 * version derivation agrees -- a null `zoomFactor` does not make a file 1.1. But
 * the 1.0 schema closes `camera.camera` and `burner.fire` with
 * `additionalProperties: false`, so it rejects the KEY, whatever its value. Left
 * in place, a hand-edited or third-party plan carrying an explicit null round-trips
 * through this writer into a file that declares 1.0.0 and fails its own validator.
 * The 1.1 schema's own advice is that writers omit it; the inspector already
 * deletes it at its default. Mirror of `_drop_null_1_1` in
 * python/fireplan/serialize.py.
 */
function dropNull1_1(block: Obj, key: string): void {
  if (block[key] === null) delete block[key];
}

function canonObject(raw: Obj): Obj {
  const o: Obj = { ...raw };

  if (hasOwn(o, 'transform')) o.transform = orderIfObject(o.transform, TRANSFORM);
  if (hasOwn(o, 'display')) o.display = orderIfObject(o.display, DISPLAY);

  switch (o.type) {
    case 'camera': {
      if (isPlainObject(o.camera)) {
        const spec = order(o.camera, CAMERA_SPEC);
        if (isPlainObject(spec.distortion)) spec.distortion = order(spec.distortion, DISTORTION);
        dropNull1_1(spec, 'zoomFactor');
        o.camera = spec;
      }
      if (hasOwn(o, 'mount')) o.mount = orderIfObject(o.mount, MOUNT);
      break;
    }
    case 'burner': {
      if (hasOwn(o, 'footprint')) o.footprint = orderIfObject(o.footprint, FOOTPRINT);
      if (hasOwn(o, 'fire')) {
        const fire = orderIfObject(o.fire, FIRE);
        if (isPlainObject(fire)) dropNull1_1(fire, 'radiativeFraction');
        o.fire = fire;
      }
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
    case 'heatFluxSensor': {
      if (hasOwn(o, 'gauge')) o.gauge = orderIfObject(o.gauge, GAUGE);
      if (hasOwn(o, 'mount')) o.mount = orderIfObject(o.mount, MOUNT);
      break;
    }
    case 'thermocouple': {
      if (hasOwn(o, 'thermocouple')) o.thermocouple = orderIfObject(o.thermocouple, THERMOCOUPLE);
      if (hasOwn(o, 'mount')) o.mount = orderIfObject(o.mount, MOUNT);
      break;
    }
    default:
      break;
  }

  return roundFloats(order(o, OBJECT_ORDER[String(o.type)])) as Obj;
}

/** Whether `type` is one this version defines -- an own key of the order table,
 *  never a prototype name masquerading as one. */
const isKnownObjectType = (type: unknown): boolean =>
  typeof type === 'string' && hasOwn(OBJECT_ORDER, type);

/**
 * An object whose `type` this version does not recognise.
 *
 * Only the two blocks this version genuinely owns are canonicalised: `transform`,
 * because the editor can drag an unknown object and would otherwise write float
 * noise into it, and `display`, because it can be hidden or locked. Everything else
 * -- key order, unknown keys, and full numeric precision -- is re-emitted exactly as
 * it arrived, not so much as a digit touched. Rounding a coefficient whose meaning we
 * do not know, or reordering fields against a schema we have never seen, is data loss
 * dressed up as tidiness, and CONVENTIONS.md section 6 promises it will not happen.
 *
 * Byte parity with Python needs nothing here: `JSON.stringify` is the reference
 * spelling of a number, and `serialize.py` reproduces it (`_js_number`).
 */
function canonUnknownObject(raw: Obj): Obj {
  const out: Obj = { ...raw };
  if (isPlainObject(out.transform)) out.transform = roundFloats(order(out.transform, TRANSFORM));
  if (isPlainObject(out.display)) out.display = roundFloats(order(out.display, DISPLAY));
  return out;
}

export function canonicalize(data: PlanDocument): Obj {
  const d: Obj = { ...(data as unknown as Obj) };

  // The declared version tracks what the file actually contains, and only ever
  // upward. A plan that uses nothing past 1.0 keeps saying 1.0.0, so it still
  // opens in a build that predates 1.1; the moment it grows a sensor or a zoom
  // factor it says so, rather than claiming a compatibility it no longer has.
  // A version this build does not recognise is left alone, not downgraded.
  d.version = maxVersion(String(d.version ?? ''), requiredFormatVersion(data));

  if (hasOwn(d, 'meta')) {
    const meta = orderIfObject(d.meta, META);
    if (isPlainObject(meta) && isPlainObject(meta.source)) {
      meta.source = order(meta.source, SOURCE);
    }
    d.meta = meta;
  }
  if (isPlainObject(d.units)) {
    const units = order(d.units, UNITS);
    if (isPlainObject(units.display)) units.display = order(units.display, UNITS_DISPLAY);
    d.units = units;
  }
  if (hasOwn(d, 'coordinateSystem')) d.coordinateSystem = orderIfObject(d.coordinateSystem, COORD);
  if (hasOwn(d, 'environment')) d.environment = orderIfObject(d.environment, ENV);
  if (Array.isArray(d.objects)) {
    d.objects = d.objects.map((o) => {
      if (!isPlainObject(o)) return o;
      return isKnownObjectType(o.type) ? canonObject(o) : canonUnknownObject(o);
    });
  }

  // Objects have already been through the rounding their own type warrants; the
  // rest of the document is all format 1.0 and rounds wholesale.
  const ordered = order(d, TOP);
  const out: Obj = Object.create(null);
  for (const k of Object.keys(ordered)) {
    out[k] = k === 'objects' ? ordered[k] : roundFloats(ordered[k]);
  }
  return out;
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
