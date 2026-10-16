/**
 * Camera preset library.
 *
 * Two layers. The seeded presets come from the repo-root `presets/cameras.json`
 * rather than a copy, so the editor and `tools/build_fixtures.py` cannot drift
 * apart (Vite is configured with `server.fs.allow` so the dev server can read
 * above `web/`). On top of those sit the user's own presets, added from the GUI
 * for gear this build has never heard of.
 *
 * **Custom presets are not a plan file.** There is no sidecar to copy alongside a
 * plan, nothing to lose when a plan is emailed, and nothing to keep in step with
 * the seeded library. Where they are kept depends on how the app was started:
 *
 * - **Desktop shell:** in the shell's own per-profile `settings.json`, via
 *   `adoptShellPresets`. Not `localStorage`, because browser storage is scoped to
 *   the ORIGIN and the shell asks the OS for a free loopback port on every launch
 *   — so every launch was a different origin, and therefore a different empty
 *   namespace, while the UI promised the library would survive a restart.
 * - **Browser tab:** `localStorage`, which is the right store there because the
 *   origin is stable.
 *
 * That is safe only because of an invariant the format has had since 1.0: placing
 * a camera copies every intrinsic inline, and `presetId` is a hint. A plan opened
 * on a machine whose preset library is empty is still fully specified, and
 * `presetFromCamera` can lift the preset back out of it — which is how a preset
 * travels between machines without ever being a file.
 */

import library from '../../../presets/cameras.json';
import type { CameraObject, CameraSpec, IntrinsicsSource, Modality, Vec2 } from './types';

/** The two closed enums a stored preset can carry into a plan. `validate.ts` holds
 *  the same lists for the load boundary; these are the write boundary. */
const MODALITIES: Modality[] = ['RGB', 'LWIR', 'MWIR', 'SWIR', 'NIR', 'other'];
const INTRINSICS_SOURCES: IntrinsicsSource[] = ['nominal', 'datasheet', 'calibrated'];

const oneOf = <T extends string>(allowed: T[], v: unknown, fallback: T): T =>
  (allowed as string[]).includes(String(v)) ? (v as T) : fallback;

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
  /**
   * The camera body this preset is one lens of, as the user reads it ("FLIR
   * A8303sc"). Presets sharing a body are offered as that camera's lenses: the
   * palette lists the body once, and the inspector switches between them (see
   * `lenses.ts`). Seeded presets only; a user's preset is a single camera.
   */
  body?: string;
  /** The lens the palette places for its body. Exactly one per body. */
  bodyDefault?: boolean;
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
    body: typeof p.body === 'string' && p.body ? p.body : undefined,
    bodyDefault: p.bodyDefault === true ? true : undefined,
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

/**
 * Stored entries `coerce` refused, kept verbatim and written back after the good
 * ones. Dropping them from memory is right -- they must not reach the intrinsics
 * maths -- but the next save used to write the library without them, so one bad
 * field in a hand-edited file cost the user that preset for good.
 */
let refused: unknown[] = [];

/** localStorage key a stored library that is not JSON at all is moved to, once,
 *  before the first write replaces it. */
const UNREADABLE_KEY = `${STORAGE_KEY}.unreadable`;

/**
 * Set when the desktop shell's store could not be reached. This page's origin
 * carries a new loopback port on every launch, so browser storage there would keep
 * the library only until the window closes -- while the UI said it would last.
 */
let sessionOnly = false;

/**
 * Whether the LAST WRITE actually landed somewhere that survives a restart, or
 * null before there has been a write to observe.
 *
 * The distinction matters because the UI is worded from it. Answering from "is
 * there somewhere to write to" — which is all `presetsArePersistent` used to do —
 * says yes for a browser that hands out a `localStorage` object and then rejects
 * every `setItem`, and said yes for the desktop build that lost the whole library
 * on the next launch.
 */
let lastWriteDurable: boolean | null = null;

/** The desktop shell's store, installed at boot. Null in an ordinary browser tab. */
let remote: ((presets: unknown[]) => Promise<boolean>) | null = null;

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
    // A cast is not a check. `?? 'other'` catches only missing and null, so a
    // hand-edited `"GAMMA"` used to survive, reach a placed camera, and be written
    // into the plan -- after which the app refuses to open its own file.
    modality: oneOf(MODALITIES, p.modality, 'other'),
    resolution_px: [Math.round(res[0]), Math.round(res[1])],
    sensor_mm: [sensor[0], sensor[1]],
    focalLength_mm: focal,
    spectralBand_um: pair(band) ? [band[0], band[1]] : null,
    framerate_hz: Number.isFinite(rate) && rate > 0 ? rate : null,
    intrinsicsSource: presetGrade(oneOf(INTRINSICS_SOURCES, p.intrinsicsSource, 'nominal')),
    note: typeof p.note === 'string' ? p.note : undefined,
  };
}

/**
 * The most a preset can claim for its numbers.
 *
 * `calibrated` means "measured from THIS physical unit" (CONVENTIONS section 4): a
 * principal point and distortion belong to one camera body and lens, not to the
 * model. A preset is a reusable specification -- it is applied to whatever camera
 * is placed next, on whatever body turns up on the day -- and it carries neither
 * of those fields. Lifting a preset out of a calibrated camera used to keep the
 * label while dropping the calibration, so a new camera arrived saying
 * `calibrated` with a null principal point, and the Python reader's
 * `is_reconstruction_ready` believed it. The label is stepped down to
 * `datasheet`: the focal length and sensor are real figures for this model,
 * correct to unit-to-unit variation, which is exactly what that grade means.
 */
export const presetGrade = (source: IntrinsicsSource): IntrinsicsSource =>
  (source === 'calibrated' ? 'datasheet' : source);

/**
 * Install a stored library: coerce each entry, keep the refused ones verbatim, and
 * give each preset an id no other preset has.
 *
 * An id is how a placed camera names its preset and how Delete finds one. A stored
 * entry reusing a shipped preset's id showed up twice in the palette and offered
 * "Delete preset" on the shipped one; two entries sharing an id could not be told
 * apart. The first keeps the id; a later one gets the next free `-2`, `-3`.
 */
function adopt(stored: unknown[]): void {
  custom = [];
  refused = [];
  const taken = new Set(BUILTIN_CAMERA_PRESETS.map((p) => p.id));
  for (const raw of stored) {
    const preset = coerce(raw);
    if (preset === null) {
      refused.push(raw);
      continue;
    }
    let id = preset.id;
    for (let i = 2; taken.has(id); i += 1) id = `${preset.id}-${i}`;
    taken.add(id);
    custom.push({ ...preset, id });
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const store = storage();
  if (!store) return;
  let text: string | null = null;
  try {
    text = store.getItem(STORAGE_KEY);
    if (!text) return;
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) adopt(parsed);
    else throw new Error('not a list');
  } catch {
    // A corrupted library is not worth refusing to start over, and it is not ours
    // to destroy: the next save would overwrite it, so it is moved aside first,
    // where the user can still recover it by hand.
    custom = [];
    refused = [];
    try {
      if (text !== null && store.getItem(UNREADABLE_KEY) === null) store.setItem(UNREADABLE_KEY, text);
    } catch {
      // Storage refused the copy as well; nothing more can be done from here.
    }
  }
}

function persist(): void {
  const stored: unknown[] = [...custom, ...refused];
  if (remote) {
    // Fire and forget: the library is already correct in memory and the next click
    // must not wait on a disk write. The ANSWER is kept, though — it is what the
    // UI is worded from.
    void remote(stored).then(
      (ok) => { lastWriteDurable = ok; },
      () => { lastWriteDurable = false; },
    );
    return;
  }
  const store = sessionOnly ? null : storage();
  if (!store) {
    lastWriteDurable = false;
    return;
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(stored));
    lastWriteDurable = true;
  } catch {
    // Quota exhausted or storage denied. The in-memory list still works for this
    // session, so the user's preset is not lost until they close the app — but the
    // UI has to stop saying it will outlive the session.
    lastWriteDurable = false;
  }
}

/**
 * True when custom presets will survive a restart, so the UI can say so rather
 * than letting someone build a library that silently evaporates.
 *
 * The last write's outcome where there has been one; only before the first save
 * does this fall back to whether there is anywhere to write to at all.
 */
export const presetsArePersistent = (): boolean =>
  lastWriteDurable ?? (remote !== null || (!sessionOnly && storage() !== null));

/**
 * The desktop shell's store could not be reached: keep the library in memory for
 * this session and say so, rather than write it to an origin the next launch will
 * not have (see `sessionOnly`).
 */
export function keepPresetsForSession(): void {
  remote = null;
  sessionOnly = true;
  lastWriteDurable = null;
}

/**
 * Take over preset storage from the desktop shell.
 *
 * Called once at boot with whatever the shell had in its settings file, before the
 * palette first renders. From then on this module reads and writes there instead
 * of `localStorage`. `stored` goes through `coerce` like anything else that was
 * not written in this session — a settings file is a file a user can edit.
 */
export function adoptShellPresets(
  stored: unknown[],
  save: (presets: unknown[]) => Promise<boolean>,
): void {
  remote = save;
  sessionOnly = false;
  adopt(stored);
  loaded = true;
  lastWriteDurable = null;
}

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

/** Test seam: forget the in-memory library, so the next read loads storage again,
 *  as a fresh page would. */
export function reloadCustomPresets(): void {
  custom = [];
  refused = [];
  loaded = false;
}

/** Test seam. Not used by the app, which never wants to drop a user's library. */
export function resetCustomPresets(): void {
  custom = [];
  refused = [];
  loaded = true;
  remote = null;
  sessionOnly = false;
  lastWriteDurable = null;
  const store = storage();
  try {
    store?.removeItem(STORAGE_KEY);
    store?.removeItem(UNREADABLE_KEY);
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
 * Swap the lens on a camera that is already placed.
 *
 * Everything about the camera comes from the preset except the zoom, which is not
 * a property of the camera at all: "the lens belongs to the preset, the zoom
 * setting belongs to the shot". Replacing the whole spec took the shot with it --
 * an operator who had zoomed in for a tight frame lost it silently on the next
 * preset change, and on a plan where zoom was the only 1.1 feature the file quietly
 * relabelled itself 1.0.0 on the following save. The FOV field has always worked
 * this way round: it back-solves the lens and leaves the zoom alone.
 */
export function applyPresetToSpec(current: CameraSpec, preset: CameraPreset): CameraSpec {
  const next = specFromPreset(preset);
  if (current.zoomFactor != null) next.zoomFactor = current.zoomFactor;
  return next;
}

/**
 * The inverse: lift a preset back out of a camera that is already in a plan.
 *
 * This is what "Save as preset" runs, and it is also how a preset crosses
 * machines — open someone else's plan, and the camera in it carries everything
 * the preset needed. `zoomFactor` is deliberately not carried: the lens belongs
 * to the preset, the zoom setting belongs to the shot. Nor are the principal
 * point and distortion, which belong to one physical unit -- and so a
 * `calibrated` source becomes `datasheet` (see `presetGrade`).
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
    intrinsicsSource: presetGrade(spec.intrinsicsSource ?? 'nominal'),
  };
}

/** Focal length that yields a given horizontal field of view, so the UI can accept
 *  an FOV even though only sensor + focal length are stored. */
export const focalLengthForHfov = (sensorWidthMm: number, hfovRad: number): number =>
  sensorWidthMm / (2 * Math.tan(hfovRad / 2));
