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
import type { Issue, PlanDocument, PlanObject } from './types';
import { FORMAT } from './types';

const MODALITIES = ['RGB', 'LWIR', 'MWIR', 'SWIR', 'NIR', 'other'];
const SHAPES = ['circle', 'square', 'rectangle'];
const TC_TYPES = ['K', 'J', 'T', 'E', 'N', 'R', 'S', 'B'];

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isNumberArray = (v: unknown, length: number): boolean =>
  Array.isArray(v) && v.length === length && v.every(isFiniteNumber);

const isPositive = (v: unknown): boolean => isFiniteNumber(v) && v > 0;

const isPairList = (v: unknown, minPairs: number): boolean =>
  Array.isArray(v) && v.length >= minPairs && v.every((p) => isNumberArray(p, 2));

export function validateStructure(doc: PlanDocument): Issue[] {
  const out: Issue[] = [];
  const err = (code: string, message: string, objectId?: string): void => {
    out.push(objectId === undefined
      ? { severity: 'error', code, message }
      : { severity: 'error', code, message, objectId });
  };

  if (doc.format !== FORMAT) {
    err('bad-format', `Expected format "${FORMAT}", found "${String(doc.format)}".`);
  }
  if (typeof doc.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.version)) {
    err('bad-version', `Version should look like "1.0.0", found "${String(doc.version)}".`);
  }
  if (doc.units?.length !== 'm') {
    err('bad-units',
      `Stored lengths must be metres; this file declares "${String(doc.units?.length)}". ` +
      'Display units live under units.display and never change stored values.');
  }
  if (doc.coordinateSystem?.convention !== 'Z-up-right-handed') {
    err('bad-convention',
      `Unsupported coordinate convention "${String(doc.coordinateSystem?.convention)}".`);
  }
  if (!Array.isArray(doc.objects)) {
    err('bad-objects', 'The "objects" field is missing or is not a list.');
    return out; // nothing further is checkable
  }

  const seen = new Set<string>();
  doc.objects.forEach((obj, index) => {
    const where = `Object ${index + 1}`;

    if (typeof obj?.id !== 'string' || obj.id.length === 0) {
      err('bad-id', `${where} has no usable id.`);
      return;
    }
    if (seen.has(obj.id)) err('duplicate-id', `Object id "${obj.id}" is used more than once.`, obj.id);
    seen.add(obj.id);

    if (typeof obj.type !== 'string' || obj.type.length === 0) {
      err('bad-type', `Object "${obj.id}" has no type.`, obj.id);
      return;
    }

    // Advisory, but it reaches HTML and SVG attributes in the drawing export, so a
    // value the schema would reject is rejected here too rather than sanitised
    // silently at each consumer.
    const color = obj.display?.color;
    if (color !== undefined && color !== null && !(typeof color === 'string' && HEX_COLOR.test(color))) {
      err('bad-color',
        `Object "${obj.id}" has display.color ${JSON.stringify(color)}; expected "#rrggbb".`, obj.id);
    }

    const t = obj.transform;
    if (t !== undefined) {
      if (!isNumberArray(t.position_m, 3)) {
        err('bad-position', `Object "${obj.id}" has an invalid position_m; expected three numbers.`, obj.id);
      }
      if (t.rotation_quat !== undefined && !isNumberArray(t.rotation_quat, 4)) {
        err('bad-rotation', `Object "${obj.id}" has an invalid rotation_quat; expected four numbers.`, obj.id);
      }
      if (t.aimTarget_m !== undefined && t.aimTarget_m !== null && !isNumberArray(t.aimTarget_m, 3)) {
        err('bad-aim', `Object "${obj.id}" has an invalid aimTarget_m.`, obj.id);
      }
    }

    validateByType(obj, err);
  });

  return out;
}

type Reporter = (code: string, message: string, objectId?: string) => void;

function validateByType(obj: PlanObject, err: Reporter): void {
  const id = obj.id;
  const raw = obj as unknown as Record<string, unknown>;

  switch (obj.type) {
    case 'camera': {
      const cam = raw.camera as Record<string, unknown> | undefined;
      if (!cam) {
        err('bad-camera', `Camera "${id}" has no camera block.`, id);
        return;
      }
      if (!MODALITIES.includes(String(cam.modality))) {
        err('bad-modality',
          `Camera "${id}" has modality "${String(cam.modality)}"; expected one of ${MODALITIES.join(', ')}.`, id);
      }
      if (!isNumberArray(cam.resolution_px, 2) || (cam.resolution_px as number[]).some((v) => v <= 0)) {
        err('bad-resolution', `Camera "${id}" has an invalid resolution_px; expected two positive numbers.`, id);
      }
      if (!isNumberArray(cam.sensor_mm, 2) || (cam.sensor_mm as number[]).some((v) => v <= 0)) {
        err('bad-sensor', `Camera "${id}" has an invalid sensor_mm; expected two positive numbers.`, id);
      }
      if (!isPositive(cam.focalLength_mm)) {
        // Without this, every derived quantity is NaN and the frustum vanishes.
        err('bad-focal-length', `Camera "${id}" has no positive focalLength_mm.`, id);
      }
      // Zero or negative would take the effective focal length to zero and every
      // derived quantity with it, exactly as a bad focal length would.
      if (cam.zoomFactor !== undefined && cam.zoomFactor !== null && !isPositive(cam.zoomFactor)) {
        err('bad-zoom', `Camera "${id}" has a non-positive zoomFactor; omit it to mean 1×.`, id);
      }
      if (raw.recording !== undefined && raw.recording !== null) {
        err('reserved-recording',
          `Camera "${id}" populates "recording", which format 1.x reserves and requires to be null.`, id);
      }
      break;
    }

    case 'burner': {
      const fp = raw.footprint as Record<string, unknown> | undefined;
      if (!fp) {
        err('bad-footprint', `Burner "${id}" has no footprint.`, id);
        return;
      }
      if (!SHAPES.includes(String(fp.shape))) {
        err('bad-shape', `Burner "${id}" has shape "${String(fp.shape)}"; expected one of ${SHAPES.join(', ')}.`, id);
      } else if (fp.shape === 'circle') {
        if (!isPositive(fp.diameter_m)) err('bad-diameter', `Circular burner "${id}" needs a positive diameter_m.`, id);
      } else if (!isNumberArray(fp.size_m, 2) || (fp.size_m as number[]).some((v) => v <= 0)) {
        err('bad-size', `Burner "${id}" needs a size_m of two positive numbers.`, id);
      }
      const fire = raw.fire as Record<string, unknown> | undefined;
      if (fire?.hrr_kw !== undefined && fire.hrr_kw !== null && !isPositive(fire.hrr_kw)) {
        err('bad-hrr', `Burner "${id}" has a non-positive hrr_kw.`, id);
      }
      break;
    }

    case 'hood': {
      if (!isNumberArray(raw.opening_m, 2) || (raw.opening_m as number[]).some((v) => v <= 0)) {
        err('bad-opening', `Hood "${id}" needs an opening_m of two positive numbers.`, id);
      }
      if (!isPositive(raw.height_m)) err('bad-height', `Hood "${id}" needs a positive height_m.`, id);
      break;
    }

    case 'wall': {
      if (!isPairList(raw.polyline_m, 2)) {
        err('bad-polyline', `Wall "${id}" needs a polyline_m of at least two [x, y] points.`, id);
      }
      if (!isPositive(raw.height_m)) err('bad-height', `Wall "${id}" needs a positive height_m.`, id);
      break;
    }

    case 'ceiling': {
      if (!isPairList(raw.polygon_m, 3)) {
        err('bad-polygon', `Ceiling "${id}" needs a polygon_m of at least three [x, y] points.`, id);
      }
      if (!isPositive(raw.height_m)) err('bad-height', `Ceiling "${id}" needs a positive height_m.`, id);
      break;
    }

    case 'heatFluxSensor': {
      const g = raw.gauge as Record<string, unknown> | undefined;
      if (g) {
        if (g.range_kw_m2 !== undefined && g.range_kw_m2 !== null && !isPositive(g.range_kw_m2)) {
          err('bad-range', `Heat flux gauge "${id}" has a non-positive range_kw_m2.`, id);
        }
        const view = g.viewAngle_deg;
        if (view !== undefined && view !== null
            && (!isPositive(view) || (view as number) > 180)) {
          err('bad-view-angle',
            `Heat flux gauge "${id}" has viewAngle_deg ${String(view)}; expected 0 to 180.`, id);
        }
      }
      break;
    }

    case 'thermocouple': {
      const offsets = raw.beadOffsets_m;
      if (offsets !== undefined
          && (!Array.isArray(offsets) || offsets.length === 0 || !offsets.every(isFiniteNumber))) {
        err('bad-beads',
          `Thermocouple "${id}" needs beadOffsets_m to be a non-empty list of numbers.`, id);
      }
      const tc = raw.thermocouple as Record<string, unknown> | undefined;
      if (tc?.tcType !== undefined && tc.tcType !== null && !TC_TYPES.includes(String(tc.tcType))) {
        err('bad-tc-type',
          `Thermocouple "${id}" has tcType "${String(tc.tcType)}"; expected one of ${TC_TYPES.join(', ')}.`,
          id);
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
  if (issues.length > limit) lines.push(`  • …and ${issues.length - limit} more.`);
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
