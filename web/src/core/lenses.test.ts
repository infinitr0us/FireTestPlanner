/**
 * Lens choice for a body with several lenses: the A8303sc's four, from the bundled
 * datasheet. The fields of view are pinned from the arithmetic in the comments,
 * not from the code under test -- 1280 x 720 at 14 um is a 17.92 x 10.08 mm array.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  applyLensToSpec,
  collapseBodies,
  compareLenses,
  currentLensOf,
  lensesOf,
  lensName,
  listedLabel,
  withLens,
} from './lenses';
import { cameras, framingOf, hfovDegOf, parsePlan, vfovDegOf } from './plan';
import { BUILTIN_CAMERA_PRESETS, findPreset, specFromPreset, type CameraPreset } from './presets';
import type { CameraObject, PlanDocument } from './types';

const EXAMPLE_TEXT = readFileSync(
  fileURLToPath(new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url)),
  'utf8',
);
const example = (): PlanDocument => parsePlan(EXAMPLE_TEXT);
const mwir = (doc: PlanDocument): CameraObject => cameras(doc).find((c) => c.id === 'cam-mwir')!;
const lens = (mm: number): CameraPreset => findPreset(`flir-a8303sc-${mm}mm`)!;
const focals = (presets: CameraPreset[]): number[] => presets.map((p) => p.focalLength_mm);

describe('the A8303sc lenses', () => {
  it('offers the four the datasheet prints, whichever lens a camera has', () => {
    // "Available Lenses: 17mm, 25 mm, 50 mm, 100 mm" -- the A8300sc datasheet, docs/datasheets/README.md.
    for (const mm of [17, 25, 50, 100]) {
      expect(focals(lensesOf(`flir-a8303sc-${mm}mm`))).toEqual([17, 25, 50, 100]);
    }
    expect(lensesOf('flir-a700-24deg')).toEqual([]);
    expect(lensesOf('gopro-hero-wide')).toEqual([]);
    expect(lensesOf(null)).toEqual([]);
    expect(lensesOf('not-a-preset')).toEqual([]);
  });

  it('derives each field of view from the 17.92 x 10.08 mm array', () => {
    const fov = (mm: number): [number, number] => {
      const cam = { camera: specFromPreset(lens(mm)) } as CameraObject;
      return [hfovDegOf(cam), vfovDegOf(cam)];
    };
    // 2 atan(17.92 / 34) = 55.58, 2 atan(10.08 / 34) = 33.03
    expect(fov(17)[0]).toBeCloseTo(55.58, 1);
    expect(fov(17)[1]).toBeCloseTo(33.03, 1);
    // 2 atan(17.92 / 100) = 20.32, 2 atan(10.08 / 100) = 11.51
    expect(fov(50)[0]).toBeCloseTo(20.32, 1);
    expect(fov(50)[1]).toBeCloseTo(11.51, 1);
    // 2 atan(17.92 / 200) = 10.24, 2 atan(10.08 / 200) = 5.77
    expect(fov(100)[0]).toBeCloseTo(10.24, 1);
    expect(fov(100)[1]).toBeCloseTo(5.77, 1);
  });

  it('keeps every body to one default and lenses that differ only in focal length', () => {
    const bodies = new Set(BUILTIN_CAMERA_PRESETS.flatMap((p) => (p.body ? [p.body] : [])));
    expect(bodies.size).toBeGreaterThan(0);
    for (const body of bodies) {
      const members = BUILTIN_CAMERA_PRESETS.filter((p) => p.body === body);
      expect(members.filter((p) => p.bodyDefault)).toHaveLength(1);
      expect(new Set(focals(members)).size).toBe(members.length);
      const [first] = members;
      for (const p of members) {
        expect(p.modality).toBe(first.modality);
        expect(p.resolution_px).toEqual(first.resolution_px);
        expect(p.sensor_mm).toEqual(first.sensor_mm);
        expect(p.spectralBand_um).toEqual(first.spectralBand_um);
        expect(p.framerate_hz).toBe(first.framerate_hz);
        expect(p.intrinsicsSource).toBe(first.intrinsicsSource);
      }
    }
    expect(lens(25).bodyDefault).toBe(true);
  });
});

describe('listing a body once', () => {
  it('lists it where its first lens was, by the lens the palette places', () => {
    const custom: CameraPreset = { ...lens(50), id: 'my-a8303-50', label: 'My A8303', body: undefined, bodyDefault: undefined };
    const listed = collapseBodies([...BUILTIN_CAMERA_PRESETS, custom]);
    const ids = listed.map((p) => p.id);
    expect(ids.filter((id) => id.startsWith('flir-a8303sc-'))).toEqual(['flir-a8303sc-25mm']);
    const firstLens = BUILTIN_CAMERA_PRESETS.findIndex((p) => p.body === 'FLIR A8303sc');
    expect(ids.indexOf('flir-a8303sc-25mm')).toBe(firstLens);
    // Every other preset is listed as it was, the user's own last.
    expect(ids).toEqual([
      ...BUILTIN_CAMERA_PRESETS.filter((p) => !p.body || p.bodyDefault).map((p) => p.id),
      'my-a8303-50',
    ]);
    expect(listed.map(listedLabel)).toContain('FLIR A8303sc');
    expect(listedLabel(custom)).toBe('My A8303');
    expect(listedLabel(findPreset('gopro-hero-wide')!)).toBe(findPreset('gopro-hero-wide')!.label);
  });

  it('names a lens as it is engraved', () => {
    expect(lensName(100)).toBe('100 mm');
    expect(lensName(25.1349)).toBe('25.13 mm');
  });
});

describe('changing the lens', () => {
  it('changes the lens and keeps the body settings and the zoom', () => {
    const current = { ...specFromPreset(lens(25)), zoomFactor: 2, framerate_hz: 30, resolution_px: [640, 360] as [number, number] };
    const before = JSON.stringify(current);
    const next = applyLensToSpec(current, lens(100));
    expect(next.focalLength_mm).toBe(100);
    expect(next.presetId).toBe('flir-a8303sc-100mm');
    expect(next.zoomFactor).toBe(2);
    expect(next.framerate_hz).toBe(30);
    expect(next.resolution_px).toEqual([640, 360]);
    expect(next.intrinsicsSource).toBe('datasheet');
    expect(JSON.stringify(current)).toBe(before);
    expect(next.resolution_px).not.toBe(current.resolution_px);
  });

  it('drops a calibration made through the old lens', () => {
    const calibrated = {
      ...specFromPreset(lens(25)),
      focalLength_mm: 25.13,
      principalPoint_px: [641.2, 357.9] as [number, number],
      distortion: { model: 'opencv' as const, coefficients: [-0.1, 0.02, 0, 0, 0] },
      intrinsicsSource: 'calibrated' as const,
    };
    const next = applyLensToSpec(calibrated, lens(50));
    expect(next.principalPoint_px).toBeNull();
    expect(next.distortion).toBeNull();
    expect(next.intrinsicsSource).toBe('datasheet');
    // A plain grade is the user's to keep.
    expect(applyLensToSpec({ ...specFromPreset(lens(25)), intrinsicsSource: 'nominal' }, lens(50)).intrinsicsSource)
      .toBe('nominal');
  });

  it('recognises the lens by its focal length', () => {
    const cam = mwir(example());
    expect(currentLensOf(cam)?.id).toBe('flir-a8303sc-25mm');
    cam.camera.focalLength_mm = 50; // typed by hand; the preset still says 25 mm
    expect(currentLensOf(cam)?.id).toBe('flir-a8303sc-50mm');
    cam.camera.focalLength_mm = 35;
    expect(currentLensOf(cam)).toBeNull();
    cam.camera.presetId = 'flir-a700-24deg';
    cam.camera.focalLength_mm = 25;
    expect(currentLensOf(cam)).toBeNull();
  });
});

describe('the lens comparison', () => {
  it('fits every lens to the camera where it stands', () => {
    const doc = example();
    const cam = mwir(doc);
    const rows = compareLenses(doc, cam);
    expect(rows.map((r) => r.lens?.focalLength_mm)).toEqual([17, 25, 50, 100]);
    expect(rows.map((r) => r.current)).toEqual([false, true, false, false]);

    const at = (mm: number) => rows.find((r) => r.focalLength_mm === mm)!;
    // The current row is the Coverage readout's own numbers.
    expect(at(25).hfovDeg).toBeCloseTo(hfovDegOf(cam), 9);
    expect(at(25).framing).toEqual(framingOf(doc, cam));
    // Detail scales with the focal length: 50 mm halves the millimetres per pixel.
    expect(at(50).mmPerPx).toBeCloseTo(at(25).mmPerPx / 2, 9);
    expect(at(100).mmPerPx).toBeCloseTo(at(25).mmPerPx / 4, 9);
    // A longer lens never frames more of the same plume from the same place.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].framing!.fraction).toBeLessThanOrEqual(rows[i - 1].framing!.fraction);
    }
    expect(at(100).framing!.fraction).toBeLessThan(at(25).framing!.fraction);
  });

  it('shows what choosing a lens would actually give', () => {
    const doc = example();
    const chosen = example();
    const cam = mwir(chosen);
    cam.camera = applyLensToSpec(cam.camera, lens(50));
    const row = compareLenses(doc, mwir(doc)).find((r) => r.focalLength_mm === 50)!;
    expect(row.hfovDeg).toBeCloseTo(hfovDegOf(cam), 9);
    expect(row.framing).toEqual(framingOf(chosen, cam));
    expect(compareLenses(chosen, cam).find((r) => r.current)!.focalLength_mm).toBe(50);
  });

  it('keeps the camera\'s zoom in every row', () => {
    const doc = example();
    const cam = mwir(doc);
    cam.camera.zoomFactor = 2;
    const rows = compareLenses(doc, cam);
    // 25 mm at 2x forms the image at 50 mm: 2 atan(17.92 / 100) = 20.32.
    expect(rows.find((r) => r.focalLength_mm === 25)!.hfovDeg).toBeCloseTo(20.32, 1);
    expect(rows.find((r) => r.focalLength_mm === 50)!.hfovDeg).toBeCloseTo(10.24, 1);
  });

  it('adds the camera\'s own focal length when it is not a listed lens', () => {
    const doc = example();
    const cam = mwir(doc);
    cam.camera.focalLength_mm = 35;
    const rows = compareLenses(doc, cam);
    expect(rows.map((r) => r.focalLength_mm)).toEqual([17, 25, 35, 50, 100]);
    const own = rows.find((r) => r.current)!;
    expect(own.lens).toBeNull();
    expect(own.focalLength_mm).toBe(35);
  });

  it('leaves framing to a plan with a fire', () => {
    const doc = example();
    doc.objects = doc.objects.filter((o) => o.type !== 'burner');
    const rows = compareLenses(doc, mwir(doc));
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.framing === null)).toBe(true);
    expect(rows.every((r) => r.mmPerPx > 0)).toBe(true);
  });

  it('is empty for a camera with no lens choice', () => {
    const doc = example();
    const gopro = cameras(doc).find((c) => c.camera.presetId === 'gopro-hero-wide')!;
    expect(compareLenses(doc, gopro)).toEqual([]);
    expect(withLens(mwir(doc), lens(17)).camera.focalLength_mm).toBe(17);
  });
});
