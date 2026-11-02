import { describe, expect, it } from 'vitest';
import { curveAt, curvePeak, GROWTH_RATES, t2Curve } from '../core/hrr';
import type { Series } from '../core/test-data';
import {
  curveFromTestSeries, curveMode, curveTable, importedLabel, parseCurveTable, t2Draft, t2FromDraft, type T2Draft,
} from './hrr-curve-model';

describe('a pasted curve table', () => {
  it('reads tab, comma and semicolon columns, with a header row', () => {
    const tab = parseCurveTable('Time (s)\tHRR (kW)\n0\t0\n60\t168.8\n300\t1000\n');
    expect(tab.curve).toEqual({ points: [[0, 0], [60, 168.8], [300, 1000]], source: 'table' });
    expect(tab.summary).toBe('3 points from 0 s to 300 s, peak 1000 kW at 300 s');
    expect(parseCurveTable('t,Q\r\n0,0\r\n10,50\r\n').curve!.points).toEqual([[0, 0], [10, 50]]);
    expect(parseCurveTable('0;0\n10;50\n20;0').curve!.points).toEqual([[0, 0], [10, 50], [20, 0]]);
    // Spaces, as text copied from a report, and blank lines in between.
    expect(parseCurveTable('  0  0\n\n 10   50 ').curve!.points).toEqual([[0, 0], [10, 50]]);
  });

  it('reads a decimal comma beside a tab or semicolon, and thousands separators beside decimal points', () => {
    expect(parseCurveTable('0\t0\n12,5\t1,5').curve!.points).toEqual([[0, 0], [12.5, 1.5]]);
    expect(parseCurveTable('0;0\n12,5;1000').curve!.points).toEqual([[0, 0], [12.5, 1000]]);
    expect(parseCurveTable('0\t0.5\n60\t1,000.5').curve!.points).toEqual([[0, 0.5], [60, 1000.5]]);
    // Trailing empty cells from a spreadsheet selection are not a third column.
    expect(parseCurveTable('0\t0\t\n10\t5\t').curve!.points).toEqual([[0, 0], [10, 5]]);
  });

  it.each([
    ['', 'Paste two columns: time (s) and HRR (kW), one point per row.'],
    ['time\tkW\n0\t5', 'A curve needs at least two points; the table has 1.'],
    ['0\t0\n10\t5\n10\t6', 'Row 3: time 10 s does not follow 10 s; times must increase strictly.'],
    ['0\t0\n10\t5\n5\t6', 'Row 3: time 5 s does not follow 10 s; times must increase strictly.'],
    ['0\t0\n10\t-5', 'Row 2: -5 kW is negative; a heat release rate is 0 kW or more.'],
    ['-10\t0\n10\t5', 'Row 1: time -10 s is before ignition; times start at 0 s or later.'],
    ['0\t0\n10\t5\t7', 'Row 2 has 3 values; paste two columns, time (s) and HRR (kW).'],
    ['0\t0\n10', 'Row 2 has 1 value; paste two columns, time (s) and HRR (kW).'],
    ['0\t0\n10\tlots', 'Row 2: "lots" is not a number.'],
    ['time\tkW\nseconds\tkW\n0\t1\n5\t2', 'Row 2: "seconds" is not a number.'],
  ])('refuses %j with a clear message', (text, message) => {
    expect(parseCurveTable(text).error).toBe(message);
  });

  it('writes a curve back as a table that reads to the same points', () => {
    const curve = t2Curve({ alpha_kW_s2: GROWTH_RATES.fast, peak_kW: 80, hold_s: 30, decay_s: 30 });
    const again = parseCurveTable(curveTable(curve)).curve!;
    again.points.forEach(([t, q], i) => {
      expect(t).toBeCloseTo(curve.points[i][0], 6);
      expect(q).toBeCloseTo(curve.points[i][1], 6);
    });
  });
});

describe('the t² form', () => {
  const draft = (over: Partial<T2Draft> = {}): T2Draft => ({ rate: 'fast', alpha: '0.0469', peak: '80', hold: '300', decay: '300', ...over });

  it('makes the shared t² curve and reads out its time to peak', () => {
    const result = t2FromDraft(draft());
    const growth = Math.sqrt(80 / GROWTH_RATES.fast);
    expect(result.error).toBe(false);
    expect(result.readout).toBe('Time to peak 41.3 s · holds to 341.3 s · ends at 641.3 s');
    expect(result.curve!.source).toBe('t2-fast');
    expect(curvePeak(result.curve!)).toBe(80);
    expect(curveAt(result.curve!, 20)).toBeCloseTo(GROWTH_RATES.fast * 400, 9);
    expect(result.curve!.points.some(([t, q]) => t === growth && q === 80)).toBe(true);
    expect(t2FromDraft(draft({ rate: 'custom', alpha: '0,05' })).curve!.source).toBe('t2');
    expect(t2FromDraft(draft({ rate: 'custom', alpha: '0,05' })).readout).toMatch(/^Time to peak 40 s · /);
  });

  it('names each invalid field and keeps the apply off', () => {
    const result = t2FromDraft(draft({ rate: 'custom', alpha: '-1', peak: '', hold: '-2', decay: '0' }));
    expect(result.curve).toBeNull();
    expect(result.invalid).toEqual(['alpha', 'peak', 'hold', 'decay']);
    expect(result.readout).toBe('α must be a positive number of kW/s²; the peak must be above 0 kW; the hold must be 0 s or longer; the decay must be longer than 0 s.');
    expect(t2FromDraft(draft({ peak: '0' })).readout).toBe('The peak must be above 0 kW.');
    expect(t2FromDraft(draft({ rate: 'slow', peak: '1e6', hold: '1e6' }))).toMatchObject({ curve: null, error: true });
  });

  it('starts from the burner rate, and reads a t² curve back into its parameters', () => {
    expect(t2Draft(80)).toEqual({ rate: 'medium', alpha: '0.01172', peak: '80', hold: '300', decay: '300' });
    expect(t2Draft(null).peak).toBe('1000');
    const fast = t2FromDraft(draft({ peak: '300', hold: '25', decay: '45' })).curve!;
    expect(t2Draft(300, fast)).toEqual({ rate: 'fast', alpha: '0.0469', peak: '300', hold: '25', decay: '45' });
    // The Python writer's plain "t2" source: the rate is recognised from α.
    expect(t2Draft(300, { ...fast, source: 't2' }).rate).toBe('fast');
    const custom = t2FromDraft(draft({ rate: 'custom', alpha: '0.05', peak: '500', hold: '0', decay: '100' })).curve!;
    expect(t2Draft(500, custom)).toEqual({ rate: 'custom', alpha: '0.05', peak: '500', hold: '0', decay: '100' });
  });
});

describe('curve provenance', () => {
  it('tells the way a curve was made from its source', () => {
    expect(curveMode(null)).toBe('steady');
    expect(curveMode({ points: [[0, 0], [1, 1]], source: 't2-fast' })).toBe('t2');
    expect(curveMode({ points: [[0, 0], [1, 1]], source: 't2' })).toBe('t2');
    expect(curveMode({ points: [[0, 0], [1, 1]], source: 'table' })).toBe('table');
    expect(curveMode({ points: [[0, 0], [1, 1]], source: 'measured:logger' })).toBe('measured');
    expect(curveMode({ points: [[0, 0], [1, 1]], source: 'simulated:fds' })).toBe('measured');
    expect(curveMode({ points: [[0, 0], [1, 1]], source: 'fds-ramp:FIRE_RAMP' })).toBe('imported');
    expect(curveMode({ points: [[0, 0], [1, 1]] })).toBe('imported');
    expect(importedLabel('fds-ramp:FIRE_RAMP')).toBe('From FDS: FIRE_RAMP');
    expect(importedLabel('fds-tau_q')).toBe('From FDS: TAU_Q');
    expect(importedLabel('design')).toBe('Imported: design');
    expect(importedLabel(undefined)).toBe('Imported');
  });
});

describe('a curve from test data', () => {
  const series = (t: number[], values: number[], role: Series['role'] = 'measured'): Series => ({
    sourceId: 'logger', sourceName: 'Synthetic logger', role, objectId: 'burner', bead: null, unit: 'kW',
    t: Float64Array.from(t), values: Float64Array.from(values), missing: 0,
  });

  it('thins to 200 points, drops samples before ignition, clamps negatives and says so', () => {
    const t = Array.from({ length: 1000 }, (_, i) => i - 10);
    const values = t.map((s) => (s === 400 ? -3 : s === 500 ? -1 : Math.max(0, s)));
    const { curve, message } = curveFromTestSeries(series(t, values));
    expect(curve.source).toBe('measured:logger');
    expect(curve.points.length).toBeLessThanOrEqual(200);
    expect(curve.points[0][0]).toBe(0);
    expect(curve.points.at(-1)![0]).toBe(989);
    expect(curve.points.every(([, q]) => q >= 0)).toBe(true);
    expect(message).toBe(`Kept ${curve.points.length} of 990 samples, with the extremes. Dropped 10 samples before ignition. Clamped 2 negative HRR samples to 0 kW.`);
    expect(curveFromTestSeries(series([0, 5], [1, 2], 'simulated')).curve.source).toBe('simulated:logger');
    expect(curveFromTestSeries(series([0, 5], [1, 2])).message).toBe('Kept 2 of 2 samples, with the extremes.');
  });

  it('refuses a series with fewer than two samples after ignition', () => {
    expect(() => curveFromTestSeries(series([-5, 3], [1, 2]))).toThrow('Synthetic logger has 1 sample at or after ignition; a curve needs two.');
  });
});
