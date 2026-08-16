/**
 * Camera preset library.
 *
 * Sourced from the repo-root `presets/cameras.json` rather than a copy, so the
 * editor and `tools/build_fixtures.py` cannot drift apart. Vite is configured with
 * `server.fs.allow` so the dev server can read above `web/`.
 *
 * Presets are a convenience only: placing a camera copies every intrinsic inline
 * into the plan, so a plan opened without this library is still fully specified.
 */

import library from '../../../presets/cameras.json';
import type { CameraSpec, IntrinsicsSource, Modality, Vec2 } from './types';

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

export const CAMERA_PRESETS: CameraPreset[] = (library.presets as unknown[]).map((raw) => {
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

export const findPreset = (id: string): CameraPreset | undefined =>
  CAMERA_PRESETS.find((p) => p.id === id);

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

/** Focal length that yields a given horizontal field of view, so the UI can accept
 *  an FOV even though only sensor + focal length are stored. */
export const focalLengthForHfov = (sensorWidthMm: number, hfovRad: number): number =>
  sensorWidthMm / (2 * Math.tan(hfovRad / 2));
