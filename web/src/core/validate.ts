import * as i18n from '../ui/i18n';
import { curveProblem } from './hrr';
import { asBuiltProblem } from './asbuilt';
/**
 * Structural validation at load time.
 *
 * This is deliberately NOT a JSON Schema implementation. `schema/` is normative and
 * `fireplan.validate_schema()` is the authoritative gate; this module does a
 * different job: catch the structural damage that would make the editor render
 * garbage or crash, and say which object is at fault in words the user can act on.
 *
 * Kept in step with the schema by `core.test.ts`, which asserts it rejects the same
 * cases the Python schema test rejects.
 */

import { HEX_COLOR, parsePlan } from './plan';
import { linkedFilesProblem } from './linked-files';
import { testDataProblem } from './test-data';
import type { Issue, PlanDocument, PlanObject } from './types';
import { FORMAT, GAS_SPECIES } from './types';

const MODALITIES = ['RGB', 'LWIR', 'MWIR', 'SWIR', 'NIR', 'other'];
const SHAPES = ['circle', 'square', 'rectangle'];
const TC_TYPES = ['K', 'J', 'T', 'E', 'N', 'R', 'S', 'B'];
const MOUNT_TYPES = ['tripod', 'pole', 'ceiling', 'wall', 'handheld', 'other'];
/** Instruments can sit on the floor. A camera in format 1.0 could not say so, and
 *  the 1.1 schema still keeps the two enums apart, so this check does too. */
const INSTRUMENT_MOUNT_TYPES = [...MOUNT_TYPES, 'floor'];
const GAUGE_KINDS = ['schmidt-boelter', 'gardon', 'thermopile', 'plate-thermometer', 'thin-skin', 'other'];

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isNumberArray = (v: unknown, length: number): boolean =>
  Array.isArray(v) && v.length === length && v.every(isFiniteNumber);

const isPositive = (v: unknown): boolean => isFiniteNumber(v) && v > 0;

const isPairList = (v: unknown, minPairs: number): boolean =>
  Array.isArray(v) && v.length >= minPairs && v.every((p) => isNumberArray(p, 2));

/** An optional field: absent and null are both "unstated" throughout this format. */
const isStated = (v: unknown): boolean => v !== undefined && v !== null;

/**
 * An optional length that the builders feed straight into geometry.
 *
 * These are the numbers a builder multiplies into a mesh without looking:
 * `thickness_m`, `baseHeight_m`, `skirtDepth_m`, `rimHeight_m`. A string or NaN in
 * one of them is a NaN geometry the schema would have rejected, and it reached the
 * renderer because only the required fields were being checked.
 */
const checkOptionalLength = (
  raw: Record<string, unknown>, key: string, id: string, err: Reporter,
  { positive = false, signed = false, label }: { positive?: boolean; signed?: boolean; label: string },
): void => {
  const v = raw[key];
  if (!isStated(v)) return;
  const ok = positive ? isPositive(v) : isFiniteNumber(v) && (signed || v >= 0);
  if (!ok) {
    err(`bad-${key.replace(/_m$/, '').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      i18n.t("{p1} \"{p2}\" has {p3} {p4}; expected a {p5} number, or null.", { p1: label, p2: id, p3: key, p4: JSON.stringify(v), p5: positive ? i18n.t("positive") : signed ? i18n.t("finite") : i18n.t("non-negative") }), id);
  }
};

export function validateStructure(doc: PlanDocument): Issue[] {
  const out: Issue[] = [];
  const err = (code: string, message: string, objectId?: string): void => {
    out.push(objectId === undefined
      ? { severity: 'error', code, message }
      : { severity: 'error', code, message, objectId });
  };

  if (doc.format !== FORMAT) {
    err('bad-format', i18n.t("Expected format \"{p1}\", found \"{p2}\".", { p1: FORMAT, p2: String(doc.format) }));
  }
  if (typeof doc.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.version)) {
    err('bad-version', i18n.t("Version should look like \"1.0.0\", found \"{p1}\".", { p1: String(doc.version) }));
  }
  if (doc.units?.length !== 'm') {
    err('bad-units',
      i18n.t("Stored lengths must be metres; this file declares \"{p1}\". Display units live under units.display and never change stored values.", { p1: String(doc.units?.length) }));
  }
  if (doc.coordinateSystem?.convention !== 'Z-up-right-handed') {
    err('bad-convention',
      i18n.t("Unsupported coordinate convention \"{p1}\".", { p1: String(doc.coordinateSystem?.convention) }));
  }
  validateTopLevel(doc, err);
  const dataProblem = testDataProblem(doc.testData);
  if (dataProblem) err('bad-test-data', dataProblem);
  if (!Array.isArray(doc.objects)) {
    err('bad-objects',
      i18n.t("The \"objects\" field is missing or is not a list. Nothing in it can be read, and opening the file anyway would drop it on the next save."));
    return out; // nothing further is checkable
  }

  const seen = new Set<string>();
  doc.objects.forEach((obj, index) => {
    const where = i18n.t("Object {p1}", { p1: index + 1 });

    if (typeof obj?.id !== 'string' || obj.id.length === 0) {
      err('bad-id', i18n.t("{p1} has no usable id.", { p1: where }));
      return;
    }
    if (seen.has(obj.id)) err('duplicate-id', i18n.t("Object id \"{p1}\" is used more than once.", { p1: obj.id }), obj.id);
    seen.add(obj.id);

    if (typeof obj.type !== 'string' || obj.type.length === 0) {
      err('bad-type', i18n.t("Object \"{p1}\" has no type.", { p1: obj.id }), obj.id);
      return;
    }

    // Advisory, but it reaches HTML and SVG attributes in the drawing export, so a
    // value the schema would reject is rejected here too rather than sanitised
    // silently at each consumer.
    const color = obj.display?.color;
    if (color !== undefined && color !== null && !(typeof color === 'string' && HEX_COLOR.test(color))) {
      err('bad-color',
        i18n.t("Object \"{p1}\" has display.color {p2}; expected \"#rrggbb\".", { p1: obj.id, p2: JSON.stringify(color) }), obj.id);
    }
    // Format 1.4 adds these to `display` for every object, not only flames; the
    // schema checks them wherever they appear, so this does too.
    const display = obj.display as Record<string, unknown> | undefined | null;
    if (isStated(display?.opacity) && !(isFiniteNumber(display!.opacity) && display!.opacity >= 0 && display!.opacity <= 1)) {
      err('bad-opacity', i18n.t("Object \"{p1}\" has display.opacity outside 0–1.", { p1: obj.id }), obj.id);
    }
    if (isStated(display?.colorMode) && !['height', 'solid'].includes(String(display!.colorMode))) {
      err('bad-color-mode', i18n.t("Object \"{p1}\" has display.colorMode {p2}; expected \"height\" or \"solid\".", { p1: obj.id, p2: JSON.stringify(display!.colorMode) }), obj.id);
    }

    const t = obj.transform;
    if (t !== undefined && !isPlainObject(t)) {
      // `transform: null` used to escape as a raw TypeError reading position_m.
      err('bad-transform', i18n.t("Object \"{p1}\" has a transform that is not an object.", { p1: obj.id }), obj.id);
    } else if (t !== undefined) {
      if (!isNumberArray(t.position_m, 3)) {
        err('bad-position', i18n.t("Object \"{p1}\" has an invalid position_m; expected three numbers.", { p1: obj.id }), obj.id);
      }
      if (t.rotation_quat !== undefined && !isNumberArray(t.rotation_quat, 4)) {
        err('bad-rotation', i18n.t("Object \"{p1}\" has an invalid rotation_quat; expected four numbers.", { p1: obj.id }), obj.id);
      }
      if (t.aimTarget_m !== undefined && t.aimTarget_m !== null && !isNumberArray(t.aimTarget_m, 3)) {
        err('bad-aim', i18n.t("Object \"{p1}\" has an invalid aimTarget_m.", { p1: obj.id }), obj.id);
      }
    }

    const surveyProblem = asBuiltProblem(obj);
    if (surveyProblem) err('bad-as-built', i18n.t("Object \"{p1}\": {p2}", { p1: obj.id, p2: surveyProblem }), obj.id);
    const linkProblem = linkedFilesProblem(obj);
    if (linkProblem) err('bad-linked-files', i18n.t("Object \"{p1}\": {p2}", { p1: obj.id, p2: linkProblem }), obj.id);
    validateByType(obj, err);
  });

  return out;
}

type Reporter = (code: string, message: string, objectId?: string) => void;

const LENGTH_UNITS = ['m', 'cm', 'mm', 'ft', 'ft-in', 'in'];
const ANGLE_UNITS = ['deg', 'rad'];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The blocks above `objects` that the UI consumes without looking.
 *
 * Object geometry was gated from the start, but the top level was not: a display
 * unit the conversion table has no row for turns every length on screen into NaN,
 * an ambient temperature spelled as a string reaches `numberField` and throws out
 * of the inspector before the toolbar exists, and a title that is not text breaks
 * the file name a save suggests. The schema rejects all of these; so does this.
 */
function validateTopLevel(doc: PlanDocument, err: Reporter): void {
  const raw = doc as unknown as Record<string, unknown>;

  const display = (raw.units as Record<string, unknown> | undefined)?.display;
  if (isStated(display)) {
    if (!isPlainObject(display)) {
      err('bad-display-units', i18n.t("units.display should be an object with optional length and angle."));
    } else {
      if (isStated(display.length) && !LENGTH_UNITS.includes(String(display.length))) {
        err('bad-display-units',
          i18n.t("Display length unit \"{p1}\" is not one of {p2}.", { p1: String(display.length), p2: LENGTH_UNITS.join(', ') }));
      }
      if (isStated(display.angle) && !ANGLE_UNITS.includes(String(display.angle))) {
        err('bad-display-units',
          i18n.t("Display angle unit \"{p1}\" is not one of {p2}.", { p1: String(display.angle), p2: ANGLE_UNITS.join(', ') }));
      }
    }
  }

  const azimuth = (raw.coordinateSystem as Record<string, unknown> | undefined)?.northAzimuth_rad;
  if (isStated(azimuth) && !isFiniteNumber(azimuth)) {
    err('bad-north-azimuth', i18n.t("coordinateSystem.northAzimuth_rad should be a number or null, found {p1}.", { p1: JSON.stringify(azimuth) }));
  }

  const meta = raw.meta;
  if (isStated(meta)) {
    if (!isPlainObject(meta)) {
      err('bad-meta', i18n.t("The \"meta\" block should be an object."));
    } else if (isStated(meta.title) && typeof meta.title !== 'string') {
      err('bad-meta', i18n.t("meta.title should be text, found {p1}.", { p1: JSON.stringify(meta.title) }));
    }
  }

  const env = raw.environment;
  if (!isStated(env)) return;
  if (!isPlainObject(env)) {
    err('bad-environment', i18n.t("The \"environment\" block should be an object."));
    return;
  }
  // Two numbers, as the schema's vec2 says; a zero floor draws nothing and hurts
  // nothing, while NaN or text becomes a NaN plane geometry.
  if (isStated(env.floorSize_m) && !isNumberArray(env.floorSize_m, 2)) {
    err('bad-environment', i18n.t("environment.floorSize_m should be two numbers."));
  }
  if (isStated(env.ceilingHeight_m) && !isPositive(env.ceilingHeight_m)) {
    err('bad-environment', i18n.t("environment.ceilingHeight_m should be a positive number or null, found {p1}.", { p1: JSON.stringify(env.ceilingHeight_m) }));
  }
  if (isStated(env.ambientTemperature_C) && !isFiniteNumber(env.ambientTemperature_C)) {
    err('bad-environment', i18n.t("environment.ambientTemperature_C should be a number or null, found {p1}.", { p1: JSON.stringify(env.ambientTemperature_C) }));
  }
  if (isStated(env.notes) && typeof env.notes !== 'string') {
    err('bad-environment', i18n.t("environment.notes should be text or null."));
  }
}

/** `mount.type` for whichever enum this object's type is held to. Advisory data,
 *  but it is printed on the equipment table and it is closed in the schema, so a
 *  value that would fail `fireplan.validate_schema()` fails here too. */
function checkMount(
  raw: Record<string, unknown>, allowed: string[], id: string, err: Reporter,
): void {
  const mount = raw.mount as Record<string, unknown> | undefined;
  if (mount && isStated(mount.type) && !allowed.includes(String(mount.type))) {
    err('bad-mount-type',
      i18n.t("Object \"{p1}\" has mount.type \"{p2}\"; expected one of {p3}.", { p1: id, p2: String(mount.type), p3: allowed.join(', ') }), id);
  }
}

function validateByType(obj: PlanObject, err: Reporter): void {
  const id = obj.id;
  const raw = obj as unknown as Record<string, unknown>;

  switch (obj.type) {
    case 'camera': {
      const cam = raw.camera as Record<string, unknown> | undefined;
      if (!cam) {
        err('bad-camera', i18n.t("Camera \"{p1}\" has no camera block.", { p1: id }), id);
        return;
      }
      if (!MODALITIES.includes(String(cam.modality))) {
        err('bad-modality',
          i18n.t("Camera \"{p1}\" has modality \"{p2}\"; expected one of {p3}.", { p1: id, p2: String(cam.modality), p3: MODALITIES.join(', ') }), id);
      }
      // Whole pixels, as the schema says: a fractional count loaded here and was
      // truncated by fireplan, so the two engines computed different fx and cx.
      if (!isNumberArray(cam.resolution_px, 2)
          || (cam.resolution_px as number[]).some((v) => v <= 0 || !Number.isInteger(v))) {
        err('bad-resolution', i18n.t("Camera \"{p1}\" has an invalid resolution_px; expected two positive whole numbers.", { p1: id }), id);
      }
      if (!isNumberArray(cam.sensor_mm, 2) || (cam.sensor_mm as number[]).some((v) => v <= 0)) {
        err('bad-sensor', i18n.t("Camera \"{p1}\" has an invalid sensor_mm; expected two positive numbers.", { p1: id }), id);
      }
      if (!isPositive(cam.focalLength_mm)) {
        // Without this, every derived quantity is NaN and the frustum vanishes.
        err('bad-focal-length', i18n.t("Camera \"{p1}\" has no positive focalLength_mm.", { p1: id }), id);
      }
      if (isStated(cam.principalPoint_px) && !isNumberArray(cam.principalPoint_px, 2)) {
        err('bad-principal-point',
          i18n.t("Camera \"{p1}\" has an invalid principalPoint_px; expected two numbers, or null.", { p1: id }), id);
      }
      // Zero or negative would take the effective focal length to zero and every
      // derived quantity with it, exactly as a bad focal length would.
      if (cam.zoomFactor !== undefined && cam.zoomFactor !== null && !isPositive(cam.zoomFactor)) {
        err('bad-zoom', i18n.t("Camera \"{p1}\" has a non-positive zoomFactor; omit it to mean 1×.", { p1: id }), id);
      }
      if (raw.recording !== undefined && raw.recording !== null) {
        err('reserved-recording',
          i18n.t("Camera \"{p1}\" populates \"recording\", which format 1.x reserves and requires to be null.", { p1: id }), id);
      }
      checkMount(raw, MOUNT_TYPES, id, err);
      break;
    }

    case 'burner': {
      const fp = raw.footprint as Record<string, unknown> | undefined;
      if (!fp) {
        err('bad-footprint', i18n.t("Burner \"{p1}\" has no footprint.", { p1: id }), id);
        return;
      }
      if (!SHAPES.includes(String(fp.shape))) {
        err('bad-shape', i18n.t("Burner \"{p1}\" has shape \"{p2}\"; expected one of {p3}.", { p1: id, p2: String(fp.shape), p3: SHAPES.join(', ') }), id);
      } else if (fp.shape === 'circle') {
        if (!isPositive(fp.diameter_m)) err('bad-diameter', i18n.t("Circular burner \"{p1}\" needs a positive diameter_m.", { p1: id }), id);
      } else if (!isNumberArray(fp.size_m, 2) || (fp.size_m as number[]).some((v) => v <= 0)) {
        err('bad-size', i18n.t("Burner \"{p1}\" needs a size_m of two positive numbers.", { p1: id }), id);
      }
      checkOptionalLength(raw, 'rimHeight_m', id, err, { label: i18n.t("Burner") });
      const fire = raw.fire as Record<string, unknown> | undefined;
      const problem = curveProblem(fire?.hrrCurve);
      if (problem) err('bad-hrr-curve', i18n.t("Burner \"{p1}\": {p2}", { p1: id, p2: problem }), id);
      if (isStated(fire?.hrr_kw) && !(isPositive(fire!.hrr_kw) || (fire?.hrrCurve != null && fire.hrr_kw === 0))) {
        err('bad-hrr', i18n.t("Burner \"{p1}\" has a non-positive hrr_kw.", { p1: id }), id);
      }
      // Not merely a schema range. `radiativeFractionOf` substitutes the 0.3
      // default for anything outside it, so an out-of-range value that loads is a
      // plan whose every predicted heat flux is computed from a number other than
      // the one stored in the file and shown in the inspector.
      const rf = fire?.radiativeFraction;
      if (isStated(rf) && !(isFiniteNumber(rf) && rf > 0 && rf <= 1)) {
        err('bad-radiative-fraction',
          i18n.t("Burner \"{p1}\" has radiativeFraction {p2}; expected a number greater than 0 and at most 1.", { p1: id, p2: JSON.stringify(rf) }), id);
      }
      break;
    }

    case 'hood': {
      if (!isNumberArray(raw.opening_m, 2) || (raw.opening_m as number[]).some((v) => v <= 0)) {
        err('bad-opening', i18n.t("Hood \"{p1}\" needs an opening_m of two positive numbers.", { p1: id }), id);
      }
      if (!isPositive(raw.height_m)) err('bad-height', i18n.t("Hood \"{p1}\" needs a positive height_m.", { p1: id }), id);
      checkOptionalLength(raw, 'skirtDepth_m', id, err, { label: i18n.t("Hood") });
      const duct = raw.duct as Record<string, unknown> | undefined | null;
      if (isStated(duct)) {
        if (typeof duct !== 'object' || !isPositive(duct!.diameter_m)) {
          err('bad-duct', i18n.t("Hood \"{p1}\" has a duct without a positive diameter_m.", { p1: id }), id);
        } else if (isStated(duct!.length_m) && !isPositive(duct!.length_m)) {
          err('bad-duct', i18n.t("Hood \"{p1}\" has a duct with a non-positive length_m.", { p1: id }), id);
        }
      }
      break;
    }

    case 'wall': {
      if (!isPairList(raw.polyline_m, 2)) {
        err('bad-polyline', i18n.t("Wall \"{p1}\" needs a polyline_m of at least two [x, y] points.", { p1: id }), id);
      }
      if (!isPositive(raw.height_m)) err('bad-height', i18n.t("Wall \"{p1}\" needs a positive height_m.", { p1: id }), id);
      checkOptionalLength(raw, 'thickness_m', id, err, { positive: true, label: i18n.t("Wall") });
      // All supported schemas allow walls to start below the floor.
      checkOptionalLength(raw, 'baseHeight_m', id, err, { signed: true, label: i18n.t("Wall") });
      // The builder slices, sorts and subtracts these. A wall whose `openings` is
      // an object rather than a list passed structural validation, was installed,
      // and then threw out of the builder -- leaving a broken document on screen
      // and offering to save it.
      const openings = raw.openings;
      if (isStated(openings)) {
        if (!Array.isArray(openings)) {
          err('bad-openings', i18n.t("Wall \"{p1}\" has openings that are not a list.", { p1: id }), id);
        } else {
          openings.forEach((o, i) => {
            const op = o as Record<string, unknown> | null;
            const okShape = typeof op === 'object' && op !== null
              && isFiniteNumber(op.offset_m) && op.offset_m >= 0
              && isPositive(op.width_m) && isPositive(op.height_m)
              && (!isStated(op.sillHeight_m) || (isFiniteNumber(op.sillHeight_m) && op.sillHeight_m >= 0));
            if (!okShape) {
              err('bad-openings',
                i18n.t("Wall \"{p1}\" opening {p2} needs offset_m ≥ 0, positive width_m and height_m, and a non-negative sillHeight_m if any.", { p1: id, p2: i + 1 }), id);
            }
          });
        }
      }
      break;
    }

    case 'ceiling': {
      if (!isPairList(raw.polygon_m, 3)) {
        err('bad-polygon', i18n.t("Ceiling \"{p1}\" needs a polygon_m of at least three [x, y] points.", { p1: id }), id);
      }
      if (!isPositive(raw.height_m)) err('bad-height', i18n.t("Ceiling \"{p1}\" needs a positive height_m.", { p1: id }), id);
      checkOptionalLength(raw, 'thickness_m', id, err, { positive: true, label: i18n.t("Ceiling") });
      break;
    }

    case 'velocityProbe':
      checkOptionalLength(raw, 'range_m_s', id, err, { positive: true, label: i18n.t("Velocity probe") });
      break;
    case 'gasSampling':
      if (!Array.isArray(raw.species) || !raw.species.every(s => GAS_SPECIES.includes(s))
          || new Set(raw.species).size !== raw.species.length) err('bad-species', i18n.t("Gas sample \"{p1}\" needs distinct supported species.", { p1: id }), id);
      if (typeof raw.inDuct !== 'boolean') err('bad-in-duct', i18n.t("Gas sample \"{p1}\" needs a boolean inDuct.", { p1: id }), id);
      break;
    case 'loadCell':
      checkOptionalLength(raw, 'capacity_kg', id, err, { positive: true, label: i18n.t("Load cell") });
      if (isStated(raw.platform_m) && (!isNumberArray(raw.platform_m, 2) || (raw.platform_m as number[]).some(v => v <= 0)))
        err('bad-platform', i18n.t("Load cell \"{p1}\" needs two positive platform dimensions or null.", { p1: id }), id);
      break;
    case 'heatFluxSensor': {
      const g = raw.gauge as Record<string, unknown> | undefined;
      if (g) {
        if (isStated(g.range_kw_m2) && !isPositive(g.range_kw_m2)) {
          err('bad-range', i18n.t("Heat flux gauge \"{p1}\" has a non-positive range_kw_m2.", { p1: id }), id);
        }
        const view = g.viewAngle_deg;
        if (isStated(view) && (!isPositive(view) || (view as number) > 180)) {
          err('bad-view-angle',
            i18n.t("Heat flux gauge \"{p1}\" has viewAngle_deg {p2}; expected 0 to 180.", { p1: id, p2: String(view) }), id);
        }
        if (isStated(g.kind) && !GAUGE_KINDS.includes(String(g.kind))) {
          err('bad-gauge-kind',
            i18n.t("Heat flux gauge \"{p1}\" has kind \"{p2}\"; expected one of {p3}.", { p1: id, p2: String(g.kind), p3: GAUGE_KINDS.join(', ') }), id);
        }
      }
      checkMount(raw, INSTRUMENT_MOUNT_TYPES, id, err);
      break;
    }

    case 'thermocouple': {
      const offsets = raw.beadOffsets_m;
      if (offsets !== undefined
          && (!Array.isArray(offsets) || offsets.length === 0 || !offsets.every(isFiniteNumber))) {
        err('bad-beads',
          i18n.t("Thermocouple \"{p1}\" needs beadOffsets_m to be a non-empty list of numbers.", { p1: id }), id);
      }
      const tc = raw.thermocouple as Record<string, unknown> | undefined;
      if (isStated(tc?.tcType) && !TC_TYPES.includes(String(tc!.tcType))) {
        err('bad-tc-type',
          i18n.t("Thermocouple \"{p1}\" has tcType \"{p2}\"; expected one of {p3}.", { p1: id, p2: String(tc!.tcType), p3: TC_TYPES.join(', ') }),
          id);
      }
      if (isStated(tc?.beadDiameter_mm) && !isPositive(tc!.beadDiameter_mm)) {
        err('bad-bead-diameter',
          i18n.t("Thermocouple \"{p1}\" has a non-positive beadDiameter_mm.", { p1: id }), id);
      }
      checkMount(raw, INSTRUMENT_MOUNT_TYPES, id, err);
      break;
    }

    case 'obstruction': {
      // Three positive numbers or the box is a degenerate mesh, and the builders
      // would put a zero-volume ghost into the scene.
      if (!isNumberArray(raw.size_m, 3) || (raw.size_m as number[]).some((v) => v <= 0)) {
        err('bad-size', i18n.t("Obstruction \"{p1}\" needs a size_m of three positive numbers.", { p1: id }), id);
      }
      break;
    }

    case 'reconstructedFlame': {
      // The manifest itself is checked with the link (linkedFilesProblem); what is
      // left is the two fields that name things.
      if (isStated(raw.burnerId) && (typeof raw.burnerId !== 'string' || !raw.burnerId)) {
        err('bad-burner-id', i18n.t("Reconstructed flame \"{p1}\" has a burnerId that is not a name.", { p1: id }), id);
      }
      if (isStated(raw.representation) && raw.representation !== 'voxels') {
        err('bad-representation',
          i18n.t("Reconstructed flame \"{p1}\" has representation {p2}; this build knows only \"voxels\".", { p1: id, p2: JSON.stringify(raw.representation) }), id);
      }
      break;
    }

    default:
      // Unknown types are legitimate and round-trip verbatim; nothing to check.
      break;
  }
}

/** One-paragraph summary suitable for an alert when a file cannot be opened. */
export function describeErrors(issues: Issue[], limit = 8): string {
  const lines = issues.slice(0, limit).map((i) => `  • ${i.message}`);
  if (issues.length > limit) lines.push(i18n.t("  • …and {p1} more.", { p1: issues.length - limit }));
  return lines.join('\n');
}

/** Thrown by `parseAndValidatePlan`, carrying the issues for the caller to show. */
export class PlanValidationError extends Error {
  constructor(readonly issues: Issue[]) {
    super(describeErrors(issues));
    this.name = 'PlanValidationError';
  }
}

/**
 * The single load boundary: parse, validate, and only then hand back a document.
 *
 * Every entry point goes through here -- Open, a plan named on the desktop shell's
 * command line, and a plan baked into a shared page -- so the same file is accepted
 * or rejected identically however it arrives. Validating before anything adopts the
 * document is the point: `replaceDocument` mutates store state before it emits, so a
 * document that fails a builder halfway through would already be installed.
 */
export function parseAndValidatePlan(text: string): PlanDocument {
  const doc = parsePlan(text);
  const errors = validateStructure(doc);
  if (errors.length > 0) throw new PlanValidationError(errors);
  return doc;
}
