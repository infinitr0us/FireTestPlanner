import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import shared from '../../../fixtures/hrr/parity.json';
import { curveAt, curveFromSeries, curvePeak, curveProblem, GROWTH_RATES, hrrAt, t2Curve } from './hrr';
import { fdsToPlan } from './fds';
import { burnerFlameHeightM, checkPlan, flameTipZM, heatFluxEstimate, newPlan, thermocoupleBeads } from './plan';
import { plannedSeries, plannedValue } from './planned-value';
import { serializePlan } from './serialize';
import { parseAndValidatePlan, validateStructure } from './validate';
import { isBurner, isHeatFluxSensor, isThermocouple, requiredFormatVersion, type BurnerObject, type HrrCurve } from './types';

const fixture = (path: string) => readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8');
const burner = (): BurnerObject => ({ id: 'b', type: 'burner', footprint: { shape: 'circle', diameter_m: .4 },
  fire: { hrr_kw: 10, hrrCurve: { source: 'test', points: [[5, 0], [10, 100], [20, 25]] } } });

describe('format 1.7 HRR curves', () => {
  it('interpolates, holds endpoints, trusts the peak and keeps steady behaviour', () => {
    const b = burner();
    expect([-10, 5, 7.5, 10, 15, 30].map(t => hrrAt(b, t))).toEqual([0, 0, 50, 100, 62.5, 25]);
    expect(hrrAt(b)).toBe(100);
    expect(burnerFlameHeightM(b, 5)).toBe(0);
    expect(flameTipZM(b, 5)).toBe(0);
    b.fire!.hrrCurve = null;
    expect(hrrAt(b, 7)).toBe(10);
    expect(burnerFlameHeightM(b, 7)).toBe(burnerFlameHeightM(b));
  });

  it('warns on both mismatched values and writes the peak and canonical key order without mutating input', () => {
    const d = newPlan(); d.objects = [burner()];
    expect(checkPlan(d).find(i => i.code === 'hrr-curve-peak')).toMatchObject({ severity: 'warning', message: expect.stringMatching(/10 kW.*100 kW/) });
    expect(requiredFormatVersion(d)).toBe('1.7.0');
    const saved = parseAndValidatePlan(serializePlan(d));
    expect(saved.version).toBe('1.7.0');
    const b = saved.objects[0] as BurnerObject;
    expect(b.fire!.hrr_kw).toBe(100);
    expect(Object.keys(b.fire!.hrrCurve!)).toEqual(['points', 'source']);
    expect(checkPlan(saved).some(i => i.code === 'hrr-curve-peak')).toBe(false);
    expect((d.objects[0] as BurnerObject).fire!.hrr_kw).toBe(10);
    b.fire!.hrrCurve = null;
    expect(JSON.parse(serializePlan(saved)).version).toBe('1.0.0');
    saved.version = '1.8.0';
    expect(JSON.parse(serializePlan(saved)).version).toBe('1.8.0');
    delete (d.objects[0] as BurnerObject).fire!.hrr_kw;
    expect(Object.keys((JSON.parse(serializePlan(d)).objects[0]).fire)).toEqual(['hrr_kw', 'hrrCurve']);
    (d.objects[0] as BurnerObject).fire!.hrrCurve = null;
    expect(requiredFormatVersion(d)).toBe('1.0.0');
  });

  it.each([
    {}, { points: [[0, 1]] }, { points: [[0, 1], [0, 2]] }, { points: [[1, 1], [0, 2]] },
    { points: [[-1, 1], [0, 2]] }, { points: [[0, -1], [1, 2]] }, { points: [[0, 1], [1, Infinity]] },
    { points: [[0, 1], [NaN, 2]] }, { points: [[false, 1], [1, 2]] }, { points: [[0, 1, 3], [1, 2]] },
    { points: [[0, 1], [1, 2]], source: null }, { points: [[0, 1], [1, 2]], extra: 1 },
    { points: Array.from({ length: 10001 }, (_, t) => [t, 1]) },
  ])('rejects a malformed curve at the load and write boundaries: %#', curve => {
    const d = newPlan(), b = burner(); d.objects = [b]; b.fire!.hrrCurve = curve as HrrCurve;
    expect(curveProblem(curve)).not.toBeNull();
    expect(validateStructure(d).some(i => i.code === 'bad-hrr-curve')).toBe(true);
    expect(() => serializePlan(d)).toThrow();
    expect(() => parseAndValidatePlan(JSON.stringify(d))).toThrow();
  });

  it('round-trips zero peaks and close timestamps without collapsing knots', () => {
    const d = newPlan(), b = burner(); d.objects = [b];
    b.fire!.hrrCurve = { points: [[0, 0], [1e-9, 0], [2e-9, 0]] };
    const loaded = parseAndValidatePlan(serializePlan(d));
    expect((loaded.objects[0] as BurnerObject).fire!.hrr_kw).toBe(0);
    expect((loaded.objects[0] as BurnerObject).fire!.hrrCurve!.points[1][0]).toBe(1e-9);
    loaded.objects.push({ id: 'hood', type: 'hood', opening_m: [2, 2], height_m: 3 });
    expect(() => checkPlan(loaded)).not.toThrow();
    b.fire!.hrrCurve = { points: Array.from({ length: 10000 }, (_, t) => [t, 1]) };
    expect(curveProblem(b.fire!.hrrCurve)).toBeNull();
  });

  it.each(['pool-fire-camera-row.ftp.json', 'flame/flame-test.ftp.json', 'fds/room_corner.ftp.json'])('keeps all reference verdicts at the peak: %s', path => {
    const d = parseAndValidatePlan(fixture(path));
    const before = checkPlan(d).filter(i => i.code !== 'version-understated');
    for (const b of d.objects.filter(isBurner)) {
      const peak = hrrAt(b);
      if (peak !== null) b.fire!.hrrCurve = { points: [[0, 0], [60, peak], [90, 0]] };
    }
    expect(checkPlan(d).filter(i => i.code !== 'version-understated')).toEqual(before);
  });

  it('matches Python predictions with independently changing burners and line of sight', () => {
    const d = parseAndValidatePlan(shared.plan), gauge = d.objects.find(isHeatFluxSensor)!, tc = d.objects.find(isThermocouple)!;
    expect(serializePlan(d)).toBe(shared.plan);
    for (const row of shared.predictions) {
      expect(heatFluxEstimate(d, gauge, row.t)!.incidentKwM2).toBeCloseTo(row.flux, 10);
      expect(burnerFlameHeightM(d.objects[0] as BurnerObject, row.t)).toBeCloseTo(row.height, 10);
      const beads = thermocoupleBeads(d, tc, row.t);
      row.beads.forEach((v, i) => v === null ? expect(beads[i].gasTemperatureC).toBeNull() : expect(beads[i].gasTemperatureC).toBeCloseTo(v, 9));
    }
    const first = d.objects[0] as BurnerObject;
    d.objects = d.objects.filter(o => o.id !== 'b2');
    expect(heatFluxEstimate(d, gauge, 0)!.incidentKwM2).toBe(0);
    expect(thermocoupleBeads(d, tc, 0).every(b => b.region === 'outside')).toBe(true);
    first.fire!.hrrCurve = null;
    expect(heatFluxEstimate(d, gauge, 4)).toEqual(heatFluxEstimate(d, gauge));
  });

  it('samples planned predictions at all knots with nonlinear intermediate values and a bounded budget', () => {
    const d = parseAndValidatePlan(shared.plan), series = plannedSeries(d, 'g')!;
    expect(series.t).toEqual(expect.arrayContaining([0, 10, 20, 30]));
    expect(series.t.length).toBe(61);
    series.t.forEach((t, i) => expect(series.values[i]).toBe(plannedValue(d, 'g', undefined, t)!.value));
    expect(plannedValue(d, 'b', undefined, 5)!.value).toBe(200);
    expect(plannedSeries(d, 'missing')).toBeNull();
    expect(plannedSeries(d, 'tc')).toBeNull();
    expect(plannedSeries(d, 'tc', 0)).not.toBeNull();
    const b = d.objects[0] as BurnerObject;
    b.fire!.hrrCurve = { points: Array.from({ length: 10000 }, (_, t) => [t, t % 31]) };
    expect(plannedSeries(d, 'b')!.t.length).toBeLessThanOrEqual(2000);
    for (const b of d.objects.filter(isBurner)) b.fire!.hrrCurve = null;
    expect(plannedSeries(d, 'g')).toBeNull();
  });

  it('makes t² growth with exact corners and thins measured data while reporting clamps', () => {
    expect(Object.values(GROWTH_RATES)).toEqual([.00293, .01172, .0469, .1876]);
    const c = t2Curve({ alpha_kW_s2: .0469, peak_kW: 300, hold_s: 25, decay_s: 45 });
    const growth = Math.sqrt(300 / .0469);
    expect(c.points.map(p => p[0])).toEqual(expect.arrayContaining([growth, growth + 25, growth + 70]));
    expect(curvePeak(c)).toBe(300);
    c.points.forEach(([t, q]) => { if (t < growth) expect(q).toBeCloseTo(.0469 * t * t, 10); });
    expect(curveAt(c, growth + 47.5)).toBeCloseTo(150);
    expect(c.points.at(-1)![1]).toBe(0);
    expect(c.points.length).toBe(shared.t2.points.length);
    c.points.forEach((p, i) => p.forEach((v, j) => expect(v).toBeCloseTo(shared.t2.points[i][j], 10)));
    expect(curveFromSeries(Array.from({ length: 12 }, (_, i) => i), [-1, 0, 10, 2, 20, 3, 30, 4, 40, 5, 50, 0], 8)).toEqual(shared.measured);
    expect(() => curveFromSeries([0, 1], [0, -Infinity])).toThrow();
    expect(() => t2Curve({ alpha_kW_s2: 0, peak_kW: 10, hold_s: 0, decay_s: 10 })).toThrow();
    expect(() => t2Curve({ alpha_kW_s2: 1, peak_kW: 10, hold_s: 0, decay_s: 10, step_s: 1e-10 })).toThrow();
  });

  it.each(shared.imports)('imports $name byte-identically to Python', c => {
    const result = fdsToPlan(c.input, 'case.fds', { importedAt: '2026-08-15T00:00:00Z' });
    result.doc.meta!.created = result.doc.meta!.modified = '2026-08-15T00:00:00Z';
    expect(serializePlan(result.doc)).toBe(c.output);
    const b = result.doc.objects.find(isBurner)!;
    if (['controlled', 'controlled-vent', 'temperature', 'duplicates'].includes(c.name)) {
      expect(b.fire!.hrrCurve).toBeNull();
      expect(result.issues.some(i => i.code === 'fds-hrr-curve-skipped')).toBe(true);
    } else expect(result.issues.some(i => i.code === 'fds-hrr-curve')).toBe(true);
    if (c.name === 'ramp-below-one') expect(b.fire!.hrrCurve!.points).toEqual([[0, 0], [10, 100]]);
    if (c.name === 'ramp-above-one') expect(b.fire!.hrrCurve!.points).toEqual([[0, 40], [10, 400]]);
    if (c.name === 'tau-positive') expect(hrrAt(b, 40)).toBeCloseTo(200 * Math.tanh(1), 10);
    if (c.name === 'tau-negative') expect(hrrAt(b, 40)).toBe(200);
    if (c.name === 'react-combustion') expect(b.fire!.hrrCurve!.points).toEqual([[0, 0], [10, 400]]);
    if (c.name === 'mixed-side-curves') expect(b.fire!.hrrCurve!.points).toEqual([[0, 200], [10, 100]]);
  });
});
