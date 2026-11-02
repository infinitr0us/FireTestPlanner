import * as i18n from '../ui/i18n';
/**
 * Canonical JSON writer. Mirror of python/fireplan/serialize.py.
 *
 * The two must produce byte-identical output: a plan saved from the editor and the
 * same plan saved from Python have to be the same file, or every handoff shows up
 * as a spurious diff. `core.test.ts` and `ft-in-format.test.ts` assert this against
 * shared fixtures, including the display-only format 1.5 preference.
 */

import { curvePeak, curveProblem } from './hrr';
import type { HrrCurve } from './types';
import { roundMicro } from './math';
import { maxVersion, requiredFormatVersion, zoomIsDefault, type PlanDocument } from './types';

const TOP = ['format', 'version', 'meta', 'units', 'coordinateSystem', 'environment', 'objects', 'testData'];
const META = ['title', 'testId', 'series', 'author', 'organization', 'siteName', 'created', 'modified', 'revision', 'notes', 'source'];
const SOURCE = ['tool', 'file', 'chid', 'importedAt', 'originOffset_m'];
const UNITS = ['length', 'angle', 'power', 'temperature', 'display'];
const UNITS_DISPLAY = ['length', 'angle'];
const COORD = ['convention', 'origin', 'northAzimuth_rad'];
const ENV = ['floorSize_m', 'ceilingHeight_m', 'ambientTemperature_C', 'notes'];

const TRANSFORM = ['position_m', 'rotation_quat', 'aimTarget_m'];
const DISPLAY = ['color', 'visible', 'locked', 'opacity', 'colorMode'];
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
const LINK = ['id', 'kind', 'path', 'label', 'timeOffset_s', 'plot', 'sequence'];
const PLOT = ['importedAt', 'samples'];
const SEQUENCE = ['importedAt', 'grid', 'bounds_m', 'frames'];
const GRID = ['voxelSize_m', 'pitch_m', 'resolution'];
const TEST_DATA = ['id', 'name', 'role', 'file', 'table', 'timeOffset_s', 'channels', 'manifest'];
const TABLE = ['sheet', 'shape', 'headerRow', 'unitsRow', 'dataRow', 'timeColumn', 'unitsSheet'];
const MAPPING = ['channel', 'object', 'bead', 'scale', 'offset'];
const DATA_MANIFEST = ['size', 'modified', 'rows', 'channels'];
const MANIFEST_CHANNEL = ['name', 'unit', 'samples', 't0', 't1'];

const OBJECT_ORDER: Record<string, string[]> = {
  camera: ['id', 'type', 'name', 'transform', 'asBuilt', 'camera', 'mount', 'recording', 'linkedFiles', 'display', 'notes'],
  burner: ['id', 'type', 'name', 'transform', 'asBuilt', 'footprint', 'rimHeight_m', 'fire', 'linkedFiles', 'display', 'notes'],
  hood: ['id', 'type', 'name', 'transform', 'asBuilt', 'opening_m', 'height_m', 'skirtDepth_m', 'duct', 'display', 'notes'],
  wall: ['id', 'type', 'name', 'transform', 'asBuilt', 'polyline_m', 'height_m', 'thickness_m', 'baseHeight_m', 'openings', 'display', 'notes'],
  ceiling: ['id', 'type', 'name', 'transform', 'asBuilt', 'polygon_m', 'height_m', 'thickness_m', 'display', 'notes'],
  heatFluxSensor: ['id', 'type', 'name', 'transform', 'asBuilt', 'gauge', 'mount', 'linkedFiles', 'display', 'notes'],
  velocityProbe: ['id', 'type', 'name', 'transform', 'asBuilt', 'range_m_s', 'linkedFiles', 'display', 'notes'],
  gasSampling: ['id', 'type', 'name', 'transform', 'asBuilt', 'species', 'inDuct', 'linkedFiles', 'display', 'notes'],
  loadCell: ['id', 'type', 'name', 'transform', 'asBuilt', 'capacity_kg', 'platform_m', 'linkedFiles', 'display', 'notes'],
  thermocouple: ['id', 'type', 'name', 'transform', 'asBuilt', 'beadOffsets_m', 'thermocouple', 'mount', 'linkedFiles', 'display', 'notes'],
  obstruction: ['id', 'type', 'name', 'transform', 'asBuilt', 'size_m', 'display', 'notes'],
  reconstructedFlame: ['id', 'type', 'name', 'transform', 'asBuilt', 'burnerId', 'representation', 'linkedFiles', 'display', 'notes'],
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

/** Geometry to 1 µm -- finer than any tape measure on a test site, coarse enough to
 *  kill float noise. `roundMicro` is the one rule both writers share. */
function roundFloats(value: Json): Json {
  if (typeof value === 'number') return roundMicro(value);
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
  if (isPlainObject(o.asBuilt)) {
    o.asBuilt = order(o.asBuilt, ['transform', 'measured', 'note']);
    (o.asBuilt as Obj).transform = orderIfObject((o.asBuilt as Obj).transform, TRANSFORM);
  }
  if (hasOwn(o, 'display')) o.display = orderIfObject(o.display, DISPLAY);

  switch (o.type) {
    case 'camera': {
      if (isPlainObject(o.camera)) {
        const spec = order(o.camera, CAMERA_SPEC);
        if (isPlainObject(spec.distortion)) spec.distortion = order(spec.distortion, DISTORTION);
        dropNull1_1(spec, 'zoomFactor');
        // 1x is the absence of a zoom, and CONVENTIONS section 4 says a writer omits it
        // rather than writing 1 -- which is also what keeps such a plan at 1.0.0.
        if (zoomIsDefault(spec.zoomFactor)) delete spec.zoomFactor;
        o.camera = spec;
      }
      if (hasOwn(o, 'mount')) o.mount = orderIfObject(o.mount, MOUNT);
      break;
    }
    case 'burner': {
      if (hasOwn(o, 'footprint')) o.footprint = orderIfObject(o.footprint, FOOTPRINT);
      if (hasOwn(o, 'fire')) {
        const fire = orderIfObject(o.fire, FIRE);
        if (isPlainObject(fire)) {
          dropNull1_1(fire, 'radiativeFraction');
          const problem = curveProblem(fire.hrrCurve); if (problem) throw new Error(problem);
          if (fire.hrrCurve != null) {
            fire.hrr_kw = curvePeak(fire.hrrCurve as HrrCurve);
            fire.hrrCurve = order(fire.hrrCurve as unknown as Obj, ['points', 'source']);
          }
        }
        o.fire = isPlainObject(fire) ? order(fire, FIRE) : fire;
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

  if (Array.isArray(o.linkedFiles)) {
    o.linkedFiles = o.linkedFiles.map((raw) => {
      if (!isPlainObject(raw)) return raw;
      const link = order(raw, LINK);
      // Reserved, and 0 is its absence: a link that carries no offset must not be
      // told apart from one that carries an offset of nothing.
      if (link.timeOffset_s === null || link.timeOffset_s === 0) delete link.timeOffset_s;
      if (isPlainObject(link.plot)) link.plot = order(link.plot, PLOT);
      if (isPlainObject(link.sequence)) {
        const sequence = order(link.sequence, SEQUENCE);
        if (isPlainObject(sequence.grid)) sequence.grid = order(sequence.grid, GRID);
        link.sequence = sequence;
      }
      return link;
    });
  }
  const result = roundFloats(order(o, OBJECT_ORDER[String(o.type)])) as Obj;
  // Recorded measurements are not geometry: preserve their supplied precision.
  if (Array.isArray(o.linkedFiles)) result.linkedFiles = o.linkedFiles;
  // Keep time precision so nearby knots cannot collapse when saving.
  if (o.type === 'burner' && isPlainObject(o.fire) && o.fire.hrrCurve != null) {
    const curve = o.fire.hrrCurve as HrrCurve;
    ((result.fire as Obj).hrrCurve as HrrCurve).points = curve.points.map(([t, q]) => [t, roundMicro(q)]);
  }
  return result;
}

/** Whether `type` is one this version defines -- an own key of the order table,
 *  never a prototype name masquerading as one. */
const isKnownObjectType = (type: unknown): boolean =>
  typeof type === 'string' && hasOwn(OBJECT_ORDER, type);

/**
 * An object whose `type` this version does not recognise.
 *
 * Only the blocks this version owns are canonicalised: `transform`, `asBuilt`,
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
  if (isPlainObject(out.asBuilt)) {
    const a = order(out.asBuilt, ['transform', 'measured', 'note']);
    a.transform = orderIfObject(a.transform, TRANSFORM);
    out.asBuilt = roundFloats(a);
    // Move only the block this format owns; preserve all unknown field order.
    const keys = Object.keys(out).filter(k => k !== 'asBuilt');
    keys.splice(keys.indexOf('transform') + 1, 0, 'asBuilt');
    return order(out, keys);
  }
  return out;
}

export function canonicalize(data: PlanDocument): Obj {
  const d: Obj = { ...(data as unknown as Obj) };

  // The declared version tracks what the file actually contains. A plan that
  // uses nothing past 1.0 keeps saying 1.0.0, so it still
  // opens in a build that predates 1.1; the moment it grows a sensor or a zoom
  // factor it says so, rather than claiming a compatibility it no longer has.
  // A version this build does not recognise is left alone, not downgraded.
  const required = requiredFormatVersion(data);
  // Format 1.7 is declared only while a 1.7 feature is present, including after removal.
  d.version = d.version === '1.7.0' && required !== '1.7.0'
    ? required : maxVersion(String(d.version ?? ''), required);

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

  if (Array.isArray(d.testData)) {
    if (!d.testData.length) delete d.testData;
    else d.testData = d.testData.map(raw => {
      if (!isPlainObject(raw)) return raw;
      const source = order(raw, TEST_DATA);
      if (isPlainObject(source.file)) {
        const link = order(source.file, LINK);
        if (link.timeOffset_s === null || link.timeOffset_s === 0) delete link.timeOffset_s;
        source.file = link;
      }
      source.table = orderIfObject(source.table, TABLE);
      if (Array.isArray(source.channels)) source.channels = source.channels.map(c => orderIfObject(c, MAPPING));
      if (isPlainObject(source.manifest)) {
        const manifest = order(source.manifest, DATA_MANIFEST);
        if (Array.isArray(manifest.channels)) manifest.channels = manifest.channels.map(c => orderIfObject(c, MANIFEST_CHANNEL));
        source.manifest = manifest;
      }
      return source;
    });
  }

  // Objects already have their type's rounding. Test data is recorded precision;
  // the remaining format 1.0 blocks round normally.
  const ordered = order(d, TOP);
  const out: Obj = Object.create(null);
  for (const k of Object.keys(ordered)) {
    out[k] = k === 'objects' || k === 'testData' ? ordered[k] : roundFloats(ordered[k]);
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

/**
 * NaN and Infinity are not JSON. `JSON.stringify` quietly writes them as `null`,
 * which turned a bad number into a missing one -- a file that then failed to load,
 * a long way from whatever produced it. Python's writer refuses them; so does this,
 * with the same words (CONVENTIONS section 6).
 */
function refuseNonFinite(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(i18n.t("Out of range float values are not JSON compliant: {p1}", { p1: value }));
  }
  return value;
}

/** Serialise to canonical JSON text, newline-terminated. */
export function serializePlan(data: PlanDocument): string {
  return collapseNumericArrays(JSON.stringify(canonicalize(data), refuseNonFinite, 2)) + '\n';
}
