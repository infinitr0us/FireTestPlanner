import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { asHoodSees, cumulative, firstOrderResponse, hoodOf, integrate, joinPath, keyNumbers, parseEventManifest, parseSeriesCsv, projectHull,
  type EventManifest, type Series } from './flame-analysis';
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

describe('estimates as the hood would record them', () => {
  it('E1 (a hood response time of 2.3 s): the like-for-like comparison beside the raw one', () => {
    const { event, series } = fixture('E1'), keys = keyNumbers(event, series);
    expect(keys.hood!.responseTime_s).toBe(2.3);
    const [volume, area] = keys.estimates;
    // Raw, a 10 Hz peak against a hood still rising at the last instant: about level, and more heat.
    expect(Math.round((volume.peakRatio! - 1) * 100)).toBe(2);
    expect(Math.round((volume.heatRatio! - 1) * 100)).toBe(39);
    // Through the hood's own response: half the peak, a third less heat.
    const seen = firstOrderResponse(series.get(volume.id)!, 2.3);
    expect(volume.asHood!.heat_kJ).toBeCloseTo(integrate(seen, ...keys.window), 10);
    expect(volume.asHood!.heat_kJ).toBeCloseTo(94.2522732, 4);
    expect(Math.round((volume.asHood!.peakRatio! - 1) * 100)).toBe(-50);
    expect(Math.round((volume.asHood!.heatRatio! - 1) * 100)).toBe(-36);
    expect(Math.round((area.asHood!.peakRatio! - 1) * 100)).toBe(-48);
    expect(Math.round((area.asHood!.heatRatio! - 1) * 100)).toBe(-33);
    expect(volume.asHood!.peak.value).toBeLessThan(volume.peak.value);
  });
  it('E2 (format 1.0, no response time) has the raw comparison only', () => {
    const { event, series } = fixture('E2'), keys = keyNumbers(event, series);
    expect(keys.hood!.responseTime_s).toBeUndefined();
    for (const estimate of keys.estimates) {
      expect(estimate.asHood).toBeUndefined();
      expect(estimate.peakRatio).not.toBeNull();
    }
  });
  // A series of the whole test, with a gap between two events: the response at an
  // event cannot be carried across what is not known.
  const twoSeries = (estimate: Series, tau: number | undefined = 2.3) => {
    const event = { instants: { t_s: [0, 1, 2] }, series: [
      { id: 'hood', role: 'measured', quantity: 'hrr', basis: 'convective', ...(tau ? { responseTime_s: tau } : {}) },
      { id: 'estimate', role: 'estimated', quantity: 'hrr', basis: 'convective' },
    ] } as unknown as EventManifest;
    return keyNumbers(event, new Map([['hood', data([0, 1, 2], [10, 10, 10])], ['estimate', estimate]])).estimates[0];
  };
  it('does not carry the response across a gap before the event', () => {
    const estimate = twoSeries(data([-10, -9, 0, 1, 2], [1000, NaN, 0, 0, 0]));
    expect(estimate.coverage).toBe(1);
    // Held through the gap, the old value would read as a 1000 kW peak inside an event
    // whose every sample is zero.
    expect(estimate.asHood!.peak.value).toBe(0);
    expect(estimate.asHood!.heat_kJ).toBe(0);
    expect(estimate.asHood!.peakRatio).toBe(0);
  });
  it('uses the history before the event as far as it is unbroken', () => {
    const whole = data([-10, -9, 0, 1, 2], [1000, 1000, 0, 0, 0]);
    const estimate = twoSeries(whole);
    const expected = firstOrderResponse(whole, 2.3);
    expect(estimate.asHood!.peak.value).toBe(expected.v[2]);
    expect(estimate.asHood!.peak.value).toBe(1000); // still settled on the value before the event
    expect(estimate.asHood!.heat_kJ).toBeCloseTo(integrate(expected, 0, 2), 10);
  });
  it('starts the response where the event has its first sample, however the series reaches it', () => {
    const tau = 2.3;
    const same = (a: Series, b: Series): void => { expect([...a.t]).toEqual([...b.t]); expect([...a.v]).toEqual([...b.v]); };
    // The series begins at the event: the whole series, as before.
    const inside = data([0, 1, 2], [5, 7, 9]);
    same(asHoodSees(inside, tau, 0), firstOrderResponse(inside, tau));
    // A gap, then a run that reaches the event: from the first sample after the gap.
    same(asHoodSees(data([-3, -2, -1, 0, 1], [9, NaN, 4, 5, 6]), tau, 0), firstOrderResponse(data([-1, 0, 1], [4, 5, 6]), tau));
    // The sample at the event's start is itself missing: nothing before it counts.
    same(asHoodSees(data([-1, 0, 1, 2], [50, NaN, 5, 6]), tau, 0), firstOrderResponse(data([0, 1, 2], [NaN, 5, 6]), tau));
    // No sample exactly at the start: the unbroken samples around it.
    same(asHoodSees(data([-0.5, 0.5, 1.5], [3, 4, 5]), tau, 0), firstOrderResponse(data([-0.5, 0.5, 1.5], [3, 4, 5]), tau));
    // Entirely before the event: nothing.
    expect(asHoodSees(data([-3, -2], [1, 2]), tau, 0).t).toHaveLength(0);
  });
  it('takes one hood for the numbers and the response time: the first measured heat release rate', () => {
    const { event, series } = fixture('E1');
    const first = event.series.find((s) => s.id === 'hood')!;
    expect(hoodOf(event)).toBe(first);
    // The response time moves to a second measured series: the reference has none, so
    // nothing is compared as the hood sees it, by the cards or by anything that asks hoodOf.
    const second = { ...first, id: 'hood-total', basis: 'total' as const };
    delete first.responseTime_s;
    event.series.splice(1, 0, second);
    series.set('hood-total', series.get('hood')!);
    expect(hoodOf(event)).toBe(first);
    expect(hoodOf(event)!.responseTime_s).toBeUndefined();
    const keys = keyNumbers(event, series);
    expect(keys.hood!.id).toBe('hood');
    expect(keys.estimates.every((e) => e.asHood === undefined && e.peakRatio !== null)).toBe(true);
  });
  it('gives no like-for-like percentage where the raw one is refused', () => {
    const { event, series } = fixture('E1');
    event.series.find((s) => s.role === 'estimated')!.basis = 'total';
    const estimate = keyNumbers(event, series).estimates[0];
    expect(estimate.asHood!.peakRatio).toBeNull(); expect(estimate.asHood!.heatRatio).toBeNull();
    expect(estimate.asHood!.peak.value).toBeGreaterThan(0);
  });
});
