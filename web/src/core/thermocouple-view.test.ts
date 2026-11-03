import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareLenses, lensesOf } from './lenses';
import {
  IR_SPOT_PX, beadSeparationTone, cameras, parsePlan, thermocouples, thermocoupleViewOf,
} from './plan';
import { serializePlan } from './serialize';

const source = readFileSync(new URL('../../../fixtures/thermocouple-view.ftp.json', import.meta.url), 'utf8');
const fixture = () => parsePlan(source);

describe('thermocouple beads in the planned camera image', () => {
  it('round-trips the Python-written canonical fixture byte for byte', () => {
    expect(serializePlan(fixture())).toBe(source);
  });

  it('keeps near-face beads clear, the far-face bead hidden and the outside bead unblocked', () => {
    const doc = fixture();
    const view = thermocoupleViewOf(doc, cameras(doc)[0])!;
    expect([view.seen, view.outside, view.hidden, view.total]).toEqual([3, 1, 1, 5]);
    expect(view.beads.map(b => [b.thermocoupleId, b.index])).toEqual([
      ['tc-01', 0], ['tc-02', 0], ['tc-03', 0], ['tc-04', 0], ['tc-05', 0],
    ]);
    expect(view.beads.map(b => b.inFrame)).toEqual([true, true, true, true, false]);
    expect(view.beads.map(b => b.blocker?.id ?? null)).toEqual([null, null, null, 'pack', null]);
    expect(view.closest!.a).toBe(view.beads[0]);
    expect(view.closest!.b).toBe(view.beads[1]);
    expect(view.closest!.px).toBeCloseTo(5, 8);
    expect(view.beads[0].nearestPx).toBeCloseTo(5, 8);
    expect(view.beads[1].nearestPx).toBeCloseTo(5, 8);
    expect(view.beads[2].nearestPx).toBeCloseTo(Math.hypot(70, 50), 8);
    expect(view.beads.slice(3).map(b => b.nearestPx)).toEqual([null, null]);
  });

  it('matches hand-derived OpenCV pixels and slant-distance detail for every bead', () => {
    const doc = fixture();
    const view = thermocoupleViewOf(doc, cameras(doc)[0])!;
    // fx=fy=50*1000/20=2500; image centre=(499.5,374.5).
    // Near face: u=499.5+250*x, v=374.5-250*(z-1).
    const pixels = [[499.5, 374.5], [504.5, 374.5], [574.5, 324.5], [499.5, 374.5], [2499.5, 374.5]];
    const distances = [10, Math.hypot(10, 0.02), Math.hypot(10, 0.3, 0.2), 11, Math.hypot(10, 8)];
    view.beads.forEach((b, i) => {
      expect(b.u).toBeCloseTo(pixels[i][0], 6);
      expect(b.v).toBeCloseTo(pixels[i][1], 6);
      expect(b.distanceM).toBeCloseTo(distances[i], 10);
      expect(b.mmPerPx).toBeCloseTo(distances[i] / 2.5, 10);
    });
  });

  it('uses planned poses, transforms rake offsets in order and returns NaN behind the camera', () => {
    const doc = fixture();
    const cam = cameras(doc)[0];
    const tc = thermocouples(doc)[0];
    doc.objects = [cam, tc];
    cam.asBuilt = { transform: { position_m: [100, 0, 0], rotation_quat: [0, 0, 0, 1] }, measured: null, note: null };
    tc.asBuilt = { transform: { position_m: [100, 0, 0] }, measured: null, note: null };
    // A 90 degree turn about Y sends local +Z to world +X.
    tc.transform!.rotation_quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    tc.beadOffsets_m = [0, 0.02];
    const view = thermocoupleViewOf(doc, cam)!;
    expect(view.beads.map(b => b.index)).toEqual([0, 1]);
    expect(view.beads[1].world[0]).toBeCloseTo(0.02, 10);
    expect(view.beads[1].world[1]).toBe(-0.5);
    expect(view.beads[1].world[2]).toBeCloseTo(1, 10);
    expect(view.closest!.px).toBeCloseTo(5, 8);
    tc.transform!.position_m = [0, -11, 1];
    const behind = thermocoupleViewOf(doc, cam)!;
    expect([behind.seen, behind.outside, behind.hidden]).toEqual([0, 2, 0]);
    expect(behind.closest).toBeNull();
    behind.beads.forEach(b => {
      expect(Number.isNaN(b.u) && Number.isNaN(b.v)).toBe(true);
      expect(b.blocker).toBeNull();
      expect(b.nearestPx).toBeNull();
    });
  });

  it('handles no thermocouples, one seen bead, no fire and coincident beads', () => {
    const doc = fixture();
    const cam = cameras(doc)[0];
    const tc = thermocouples(doc)[0];
    doc.objects = [cam];
    expect(thermocoupleViewOf(doc, cam)).toBeNull();
    doc.objects.push(tc);
    const single = thermocoupleViewOf(doc, cam)!;
    expect(single.seen).toBe(1);
    expect(single.closest).toBeNull();
    expect(single.beads[0].nearestPx).toBeNull();
    doc.objects.push({ ...structuredClone(tc), id: 'duplicate' });
    const coincident = thermocoupleViewOf(doc, cam)!;
    expect(coincident.closest!.px).toBe(0);
    expect(coincident.beads.map(b => b.nearestPx)).toEqual([0, 0]);
  });

  it('uses the 3 px spot thresholds at their exact boundaries', () => {
    expect(IR_SPOT_PX).toBe(3);
    expect([2.99, 3, 5.99, 6].map(beadSeparationTone)).toEqual(['bad', 'warn', 'warn', 'good']);
  });

  it('scales closest separation with focal length for every listed lens, retaining zoom', () => {
    const doc = fixture();
    const cam = cameras(doc)[0];
    cam.camera.presetId = 'flir-a8303sc-50mm';
    cam.camera.zoomFactor = 2;
    const lenses = lensesOf(cam.camera.presetId);
    expect(lenses.length).toBeGreaterThan(1);
    const rows = compareLenses(doc, cam);
    expect(rows.map(r => r.lens!.id)).toEqual(lenses.map(l => l.id));
    rows.forEach((row, i) => {
      expect(row.thermocouples!.closest!.px).toBeCloseTo(10 * lenses[i].focalLength_mm / 50, 8);
      expect(row.thermocouples!.closest!.a.thermocoupleId).toBe('tc-01');
      expect(row.thermocouples!.closest!.b.thermocoupleId).toBe('tc-02');
    });
    cam.camera.focalLength_mm = 51.23;
    cam.camera.principalPoint_px = [450, 350];
    expect(compareLenses(doc, cam).find(r => r.current)!.thermocouples)
      .toEqual(thermocoupleViewOf(doc, cam));
    doc.objects = [cam];
    expect(compareLenses(doc, cam).every(r => r.thermocouples === null)).toBe(true);
  });
});
