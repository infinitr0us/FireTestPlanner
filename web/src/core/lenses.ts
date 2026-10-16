/**
 * Lens choice for a camera body that ships with several lenses.
 *
 * The A8303sc's datasheet lists four lenses for one body. Each is a seeded preset of
 * its own (`flir-a8303sc-50mm`), grouped by `body`, rather than one preset carrying
 * a list of focal lengths. A camera's `presetId` then still names the lens it was
 * planned with; a plan opened in a build that predates the grouping still finds its
 * preset, or reports it as foreign; and nothing in the file format changes. The lens
 * is `focalLength_mm`, as it always was (CONVENTIONS section 4).
 *
 * A lens swap changes less than a preset change does. The body's settings -- its
 * resolution (a sub-window), frame rate and band -- stay as the user left them, and
 * so does the zoom, which belongs to the shot. A calibration does not survive it: a
 * principal point and distortion were measured through the old lens.
 */

import { framingOf, groundSampleDistanceM, hfovDegOf, vfovDegOf, type Framing } from './plan';
import { BUILTIN_CAMERA_PRESETS, presetGrade, type CameraPreset } from './presets';
import type { CameraObject, CameraSpec, PlanDocument, Vec2 } from './types';

/**
 * The lenses of the body `presetId` is one lens of, shortest focal length first.
 * Empty when the preset is not part of a body with several lenses, or is not a
 * seeded preset at all: a user's own preset is a single camera.
 */
export function lensesOf(presetId: string | null | undefined): CameraPreset[] {
  const preset = BUILTIN_CAMERA_PRESETS.find((p) => p.id === presetId);
  if (!preset?.body) return [];
  const lenses = BUILTIN_CAMERA_PRESETS.filter((p) => p.body === preset.body);
  return lenses.length > 1 ? lenses.sort((a, b) => a.focalLength_mm - b.focalLength_mm) : [];
}

/** The lens the palette places for a body: the one marked `bodyDefault`. */
function defaultLens(body: string, presets: CameraPreset[]): CameraPreset {
  const lenses = presets.filter((p) => p.body === body);
  return lenses.find((p) => p.bodyDefault) ?? lenses[0];
}

/**
 * A preset list with each body listed once, at the place of its first lens, by the
 * lens it should be placed with. What the palette and the preset picker show.
 */
export function collapseBodies(presets: CameraPreset[]): CameraPreset[] {
  const seen = new Set<string>();
  const out: CameraPreset[] = [];
  for (const p of presets) {
    if (lensesOf(p.id).length === 0) {
      out.push(p);
    } else if (!seen.has(p.body!)) {
      seen.add(p.body!);
      out.push(defaultLens(p.body!, presets));
    }
  }
  return out;
}

/** How a list names a preset: by its body when the lens is chosen separately. */
export const listedLabel = (p: CameraPreset): string =>
  (lensesOf(p.id).length > 0 ? p.body! : p.label);

/** A lens as it is engraved: "50 mm", or "25.13 mm" for a calibrated value. */
export const lensName = (focalLengthMm: number): string =>
  `${Number(focalLengthMm.toFixed(2))} mm`;

/**
 * The camera's lens among its body's lenses, or null when its focal length is none
 * of them -- typed by hand, back-solved from a typed field of view, or calibrated.
 * Matched on the focal length, which is what forms the image, not on `presetId`.
 */
export function currentLensOf(cam: CameraObject): CameraPreset | null {
  const f = cam.camera.focalLength_mm;
  return lensesOf(cam.camera.presetId)
    .find((lens) => Math.abs(lens.focalLength_mm - f) <= 1e-9 * Math.max(1, f)) ?? null;
}

/**
 * The lens to print beside a camera, for the crew who mount it: "50 mm" and listed
 * when it is one of its body's lenses, the focal length itself and not listed when
 * it is none of them (never rounded to the nearest, as on screen). Null for a camera
 * without a lens choice.
 */
export function printedLensOf(cam: CameraObject): { name: string; listed: boolean } | null {
  if (lensesOf(cam.camera.presetId).length === 0) return null;
  const mine = currentLensOf(cam);
  return { name: lensName(mine?.focalLength_mm ?? cam.camera.focalLength_mm), listed: mine !== null };
}

/**
 * Fit another of the body's lenses: the focal length and the preset it came from.
 * Everything the body owns is kept, and so is the zoom. A principal point and
 * distortion are dropped, and a `calibrated` label steps down to the lens preset's
 * grade, because they describe the lens that came off.
 */
export function applyLensToSpec(current: CameraSpec, lens: CameraPreset): CameraSpec {
  const next: CameraSpec = {
    ...current,
    presetId: lens.id,
    focalLength_mm: lens.focalLength_mm,
    resolution_px: [...current.resolution_px] as [number, number],
    sensor_mm: [...current.sensor_mm] as Vec2,
    spectralBand_um: current.spectralBand_um ? ([...current.spectralBand_um] as Vec2) : current.spectralBand_um,
  };
  if (current.principalPoint_px != null || current.distortion != null
    || current.intrinsicsSource === 'calibrated') {
    next.principalPoint_px = null;
    next.distortion = null;
  }
  if (current.intrinsicsSource === 'calibrated') next.intrinsicsSource = presetGrade(lens.intrinsicsSource);
  return next;
}

/** The same camera, where it stands and as it is aimed, with another lens fitted. */
export const withLens = (cam: CameraObject, lens: CameraPreset): CameraObject =>
  ({ ...cam, camera: applyLensToSpec(cam.camera, lens) });

export interface LensComparisonRow {
  /** The listed lens, or null for the camera's own focal length when it is none of them. */
  lens: CameraPreset | null;
  focalLength_mm: number;
  /** The lens the camera has now. */
  current: boolean;
  /** At the camera's zoom, like every other field of view in the inspector. */
  hfovDeg: number;
  vfovDeg: number;
  /** At the slant standoff, square to the axis: the inspector's "Resolution at the fire". */
  mmPerPx: number;
  /** Null when the plan has no fire to frame. */
  framing: Framing | null;
}

/**
 * Every lens of the camera's body, fitted to this camera where it stands: what each
 * would see of the fire and at what detail. Empty for a camera without a lens
 * choice. The current lens is the camera itself, calibration and all; the others
 * are what choosing them under Lens would give, through the same `applyLensToSpec`.
 */
export function compareLenses(doc: PlanDocument, cam: CameraObject): LensComparisonRow[] {
  const lenses = lensesOf(cam.camera.presetId);
  if (lenses.length === 0) return [];
  const mine = currentLensOf(cam);
  const row = (c: CameraObject, lens: CameraPreset | null, current: boolean): LensComparisonRow => ({
    lens,
    focalLength_mm: c.camera.focalLength_mm,
    current,
    hfovDeg: hfovDegOf(c),
    vfovDeg: vfovDegOf(c),
    mmPerPx: groundSampleDistanceM(c) * 1000,
    framing: framingOf(doc, c),
  });
  const rows = lenses.map((lens) => (lens === mine ? row(cam, lens, true) : row(withLens(cam, lens), lens, false)));
  if (!mine) rows.push(row(cam, null, true));
  return rows.sort((a, b) => a.focalLength_mm - b.focalLength_mm);
}
