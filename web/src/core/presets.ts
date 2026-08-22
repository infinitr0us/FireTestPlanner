/**
 * Camera preset library.
 *
 * Two layers. The seeded presets come from the repo-root `presets/cameras.json`
 * rather than a copy, so the editor and `tools/build_fixtures.py` cannot drift
 * apart (Vite is configured with `server.fs.allow` so the dev server can read
 * above `web/`). On top of those sit the user's own presets, added from the GUI
 * for gear this build has never heard of.
 *
 * **Custom presets are not a file.** They live in the browser's `localStorage`,
 * which the desktop shell's WebView2 persists per user profile — so there is no
 * sidecar to copy alongside a plan, nothing to lose when a plan is emailed, and
 * nothing to keep in step with the seeded library.
 *
 * That is safe only because of an invariant the format has had since 1.0: placing
 * a camera copies every intrinsic inline, and `presetId` is a hint. A plan opened
 * on a machine whose preset library is empty is still fully specified, and
 * `presetFromCamera` can lift the preset back out of it — which is how a preset
 * travels between machines without ever being a file.
 */

import library from '../../../presets/cameras.json';
import type { CameraObject, CameraSpec, IntrinsicsSource, Modality, Vec2 } from './types';

export interface CameraPreset {
  id: string;
  label: string;
  modality: Modality;
  resolution_px: [number, number];
  sensor_mm: Vec2;
  focalLength_mm: number;
  spectralBand_um: Vec2 | null;
  framerate_hz: number | null;
  intrinsicsSource: IntrinsicsSource;
  note?: string;
}

const STORAGE_KEY = 'fire-test-plan.cameraPresets.v1';

export const BUILTIN_CAMERA_PRESETS: CameraPreset[] = (library.presets as unknown[]).map((raw) => {
  const p = raw as Record<string, unknown>;
  return {
    id: String(p.id),
    label: String(p.label),
    modality: p.modality as Modality,
    resolution_px: p.resolution_px as [number, number],
    sensor_mm: p.sensor_mm as Vec2,
    focalLength_mm: Number(p.focalLength_mm),
    spectralBand_um: (p.spectralBand_um as Vec2 | null) ?? null,
    framerate_hz: (p.framerate_hz as number | null) ?? null,
    intrinsicsSource: p.intrinsicsSource as IntrinsicsSource,
    note: p.$note ? String(p.$note) : undefined,
  };
});

// -- persistence ----------------------------------------------------------

/**
 * Mirror of what is in storage, and the fallback when there is no storage at all.
 *
 * `localStorage` throws rather than returning null in a surprising number of
 * places — a private window, a `file://` page under some policies, storage
 * disabled outright. None of those should cost the user the preset they just
 * made for the rest of the session, so every access is guarded and the in-memory
 * copy is what the UI actually reads.
 */
let custom: CameraPreset[] = [];
let loaded = false;

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** Accept only what we would have written. A hand-edited or corrupted entry is
 *  dropped rather than allowed to reach the intrinsics maths as NaN. */
function coerce(raw: unknown): CameraPreset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const res = p.resolution_px;
  const sensor = p.sensor_mm;
  const pair = (v: unknown): v is [number, number] =>
    Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);

  if (typeof p.id !== 'string' || p.id.length === 0) return null;
  if (!pair(res) || !pair(sensor)) return null;
  const focal = Number(p.focalLength_mm);
  if (!Number.isFinite(focal) || focal <= 0) return null;

  const band = p.spectralBand_um;
  const rate = Number(p.framerate_hz);
  return {
    id: p.id,
    label: typeof p.label === 'string' && p.label ? p.label : p.id,
    modality: (p.modality as Modality) ?? 'other',
    resolution_px: [Math.round(res[0]), Math.round(res[1])],
    sensor_mm: [sensor[0], sensor[1]],
    focalLength_mm: focal,
    spectralBand_um: pair(band) ? [band[0], band[1]] : null,
    framerate_hz: Number.isFinite(rate) && rate > 0 ? rate : null,
    intrinsicsSource: (p.intrinsicsSource as IntrinsicsSource) ?? 'nominal',
    note: typeof p.note === 'string' ? p.note : undefined,
  };
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (!store) return;
  try {
    const text = store.getItem(STORAGE_KEY);
    if (!text) return;
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      custom = parsed.map(coerce).filter((p): p is CameraPreset => p !== null);
    }
  } catch {
    // A corrupted entry is not worth refusing to start over. Leave it in place
    // rather than clearing it -- the user may be able to recover it by hand.
    custom = [];
  }
}

function persist(): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(custom));
  } catch {
    // Quota exhausted or storage denied. The in-memory list still works for this
    // session, so the user's preset is not lost until they close the app.
  }
}

/** True when custom presets will survive a restart. The UI says so rather than
 *  letting someone build a library that silently evaporates. */
export const presetsArePersistent = (): boolean => storage() !== null;

// -- library --------------------------------------------------------------

/** Seeded presets first, then the user's own. Recomputed on each call, because
 *  the list changes while the app is running. */
export function cameraPresets(): CameraPreset[] {
  load();
  return [...BUILTIN_CAMERA_PRESETS, ...custom];
}

export const customCameraPresets = (): CameraPreset[] => {
  load();
  return [...custom];
};

export const findPreset = (id: string): CameraPreset | undefined =>
  cameraPresets().find((p) => p.id === id);

export const isCustomPreset = (id: string): boolean =>
  customCameraPresets().some((p) => p.id === id);

/** A stable, readable id from a label, uniquified against the whole library. */
export function presetIdFromLabel(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'camera';
  const taken = new Set(cameraPresets().map((p) => p.id));
  if (!taken.has(slug)) return slug;
  for (let i = 2; ; i += 1) {
    if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`;
  }
}

/**
 * Add or replace a custom preset.
 *
 * Seeded presets are not overwritable: they are the ones backed by a datasheet in
 * `docs/datasheets/`, and quietly shadowing one would make `intrinsicsSource:
 * "datasheet"` a claim nobody could check. Saving under a builtin's id gets a
 * fresh id instead.
 */
export function saveCustomPreset(preset: CameraPreset): CameraPreset {
  load();
  const clashesWithBuiltin = BUILTIN_CAMERA_PRESETS.some((p) => p.id === preset.id);
  const stored: CameraPreset = clashesWithBuiltin
    ? { ...preset, id: presetIdFromLabel(preset.label) }
    : { ...preset };

  const at = custom.findIndex((p) => p.id === stored.id);
  if (at >= 0) custom[at] = stored;
  else custom.push(stored);
  persist();
  return stored;
}

export function deleteCustomPreset(id: string): boolean {
  load();
  const before = custom.length;
  custom = custom.filter((p) => p.id !== id);
  if (custom.length === before) return false;
  persist();
  return true;
}

/** Test seam. Not used by the app, which never wants to drop a user's library. */
export function resetCustomPresets(): void {
  custom = [];
  loaded = true;
  const store = storage();
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to undo; the in-memory list is already empty.
  }
}

// -- conversion -----------------------------------------------------------

/** Copy a preset's intrinsics inline, which is what makes plans self-contained. */
export function specFromPreset(preset: CameraPreset): CameraSpec {
  return {
    modality: preset.modality,
    presetId: preset.id,
    resolution_px: [...preset.resolution_px] as [number, number],
    sensor_mm: [...preset.sensor_mm] as Vec2,
    focalLength_mm: preset.focalLength_mm,
    principalPoint_px: null,
    distortion: null,
    intrinsicsSource: preset.intrinsicsSource,
    spectralBand_um: preset.spectralBand_um ? ([...preset.spectralBand_um] as Vec2) : null,
    framerate_hz: preset.framerate_hz,
  };
}

/**
 * The inverse: lift a preset back out of a camera that is already in a plan.
 *
 * This is what "Save as preset" runs, and it is also how a preset crosses
 * machines — open someone else's plan, and the camera in it carries everything
 * the preset needed. `zoomFactor` is deliberately not carried: the lens belongs
 * to the preset, the zoom setting belongs to the shot.
 */
export function presetFromCamera(cam: CameraObject, label: string, id?: string): CameraPreset {
  const spec = cam.camera;
  return {
    id: id ?? presetIdFromLabel(label),
    label,
    modality: spec.modality,
    resolution_px: [...spec.resolution_px] as [number, number],
    sensor_mm: [...spec.sensor_mm] as Vec2,
    focalLength_mm: spec.focalLength_mm,
    spectralBand_um: spec.spectralBand_um ? ([...spec.spectralBand_um] as Vec2) : null,
    framerate_hz: spec.framerate_hz ?? null,
    intrinsicsSource: spec.intrinsicsSource ?? 'nominal',
  };
}

/** Focal length that yields a given horizontal field of view, so the UI can accept
 *  an FOV even though only sensor + focal length are stored. */
export const focalLengthForHfov = (sensorWidthMm: number, hfovRad: number): number =>
  sensorWidthMm / (2 * Math.tan(hfovRad / 2));
