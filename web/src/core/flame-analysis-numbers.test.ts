import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cumulative, firstOrderResponse, integrate, joinPath, keyNumbers, parseEventManifest, parseSeriesCsv, projectHull, type Series } from './flame-analysis';
import type { CameraObject } from './types';

const data = (t: number[], v: number[]): Series => ({ t: Float64Array.from(t), v: Float64Array.from(v) });
export const fixture = (id: string) => {
  const root = new URL('../../../fixtures/flame-analysis/', import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
  const event = parseEventManifest(read(`${id}/event.json`));
  const series = new Map(event.series.map((s) => [s.id, parseSeriesCsv(read(joinPath(id, s.file)), s.time, s.value)]));
  return { event, series };
};

describe('event heat and coverage (B1, B3, B4)', () => {
  it.each(['E1', 'E2'])('%s: every final heat equals its raw key number', (id) => {
    const { event, series } = fixture(id), keys = keyNumbers(event, series);
    for (const key of [keys.hood!, ...keys.estimates]) {
      const curve = cumulative(series.get(key.id)!, ...keys.window);
      expect(curve.v[curve.t.indexOf(keys.window[0])]).toBe(0);
      expect(curve.v.at(-1)).toBeCloseTo(key.heat_kJ, 10);
      expect(key.coverage).toBeCloseTo(1, 10);
      curve.t.forEach((t, i) => { if (t < keys.window[0]) expect(curve.v[i]).toBeNaN(); });
    }
  });
  it('clips and interpolates both boundaries, retains signed heat, and breaks gaps', () => {
    const s = data([0, 2, 4, 6, 8, 10], [-10, 10, NaN, 20, 40, 60]);
    const total = integrate(s, 1, 9, true), curve = cumulative(s, 1, 9);
    expect(total).toEqual({ value: 110, covered_s: 4, coverage: 0.5 });
    expect(curve.v.at(-1)).toBe(total.value);
    expect([...curve.t]).toEqual([0, 1, 2, 4, 6, 8, 9]);
    expect(curve.v[3]).toBeNaN();
    expect(curve.v[4]).toBe(5);
    expect(integrate(data([0, 1], [-10, -10]), 0, 1)).toBe(-10);
  });
  it.each([undefined, 'total'] as const)('does not compare a convective hood with basis %s', (basis) => {
    const { event, series } = fixture('E1');
    event.series.find((s) => s.role === 'estimated')!.basis = basis;
    const estimate = keyNumbers(event, series).estimates[0];
    expect(estimate.peakRatio).toBeNull(); expect(estimate.heatRatio).toBeNull();
    expect(estimate.heat_kJ).toBeCloseTo(204.3165, 6);
    expect(estimate.comparison).toBe(basis ? 'different' : 'unstated');
  });
  it('reports no coverage even when isolated samples still define a peak', () => {
    const { event } = fixture('E1');
    event.instants.t_s = [0, 1, 2];
    const series = new Map(event.series.map((s) => [s.id, data([0, 1, 2], [10, NaN, 10])]));
    const keys = keyNumbers(event, series);
    expect(keys.hood).toMatchObject({ heat_kJ: 0, coverage: 0, peak: { value: 10 } });
    expect(keys.estimates[0].heatRatio).toBeNull(); expect(keys.estimates[0].peakRatio).toBeNull();
    series.set(keys.hood!.id, data([0, 1, 2], [NaN, NaN, NaN]));
    expect(keyNumbers(event, series).hood!.coverage).toBe(0);
  });
  it.each([0.9949, 0.995, 1])('requires both sides to cover 99.5 percent: %s', (coverage) => {
    const { event } = fixture('E1');
    event.instants.t_s = [0, 1];
    const all = new Map(event.series.map((s) => [s.id, data([0, 1], [10, 10])]));
    for (const partialId of ['hood', 'hrr-from-volume']) {
      const hoodId = event.series.find((s) => s.role === 'measured')!.id;
      const partial = partialId === 'hood' ? hoodId : partialId;
      const series = new Map(all); series.set(partial, data([0, coverage], [10, 10]));
      const estimate = keyNumbers(event, series).estimates[0];
      expect(estimate.heatRatio === null).toBe(coverage < 0.995);
      expect(estimate.peakRatio === null).toBe(coverage < 0.995);
    }
  });
});

describe('response before heat (B2)', () => {
  it('E1 response heat is 0.0942522732 MJ over the event', () => {
    const { event, series } = fixture('E1');
    const s = series.get('hrr-from-volume')!;
    const filtered = firstOrderResponse(s, 2.3);
    const curve = cumulative(filtered, event.instants.t_s[0], event.instants.t_s.at(-1)!);
    expect(curve.v.at(-1)! / 1000).toBeCloseTo(0.0942522732, 9);
    expect(keyNumbers(event, series).estimates[0].heat_kJ).toBeCloseTo(204.3165, 6);
  });
});

describe('quantitative cube footprints (B14, reviewer R14)', () => {
  const camera = { transform: { position_m: [0, 0, 0] }, camera: { resolution_px: [200, 200], sensor_mm: [2, 4], focalLength_mm: 10 } } as CameraObject;
  it('uses both focal lengths and corner depth: about 35.07 percent, with overlay unchanged', () => {
    const p = projectHull(camera, [0, 0, -10], 0.1);
    const [x0, y0, x1, y1] = p.rectangles!;
    expect(p.size).toBe(10);
    expect((x1 - x0) * (y1 - y0) / 144).toBeCloseTo(0.3507206608, 9);
    expect((x1 - x0) / (y1 - y0)).toBeCloseTo(2, 10);
  });
  it('skips a cube crossing the camera plane and keeps each cube depth', () => {
    const p = projectHull(camera, [0, 0, -10, 0, 0, -20, 0, 0, -0.01], 0.1);
    expect(p.rectangles).toHaveLength(8);
    expect(p.rectangles![2] - p.rectangles![0]).toBeGreaterThan(2 * (p.rectangles![6] - p.rectangles![4]));
  });
});
