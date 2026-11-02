import { describe, expect, it } from 'vitest';
import {
  beadColor, formatTime, heightRanks, lastIndexAtOrBefore, niceTicks, runs, seriesDash, timeAxis, unionTimes, valueAt, valueExtent,
} from './plot-svg';

describe('plot axes', () => {
  it('keeps seconds up to half an hour and switches to minutes beyond it', () => {
    const short = timeAxis(-120, 479);
    expect(short.unit).toBe('s');
    expect(short.label).toBe('Time from ignition (s)');
    expect(short.ticks).toEqual([-100, 0, 100, 200, 300, 400]);
    expect(timeAxis(0, 1800).unit).toBe('s');
    const long = timeAxis(0, 5400);
    expect(long.unit).toBe('min');
    expect(long.label).toBe('Time from ignition (min)');
    // Ticks stay in seconds and land on round minutes.
    expect(long.ticks).toEqual([0, 1200, 2400, 3600, 4800]);
    expect(formatTime(4800, long)).toBe('80 min');
    expect(formatTime(37.5, short)).toBe('37.5 s');
  });

  it('chooses round ticks and widens a value axis to them', () => {
    expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(21, 23.45)).toEqual([21, 21.5, 22, 22.5, 23]);
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(valueExtent(0, 0.0984)).toEqual({ lo: 0, hi: 0.1, ticks: [0, 0.02, 0.04, 0.06, 0.08, 0.1] });
    expect(valueExtent(21, 23.45)).toEqual({ lo: 21, hi: 23.5, ticks: [21, 21.5, 22, 22.5, 23, 23.5] });
    // A flat series still gets a band to sit in.
    const flat = valueExtent(21, 21);
    expect(flat.lo).toBeLessThan(21);
    expect(flat.hi).toBeGreaterThan(21);
  });
});

describe('reading series at a time', () => {
  const t = [0, 10, 20, 30], v = [1, 2, 3, 4];
  it('takes the last sample at or before the time, and nothing outside the span', () => {
    expect(lastIndexAtOrBefore(t, -1)).toBe(-1);
    expect(lastIndexAtOrBefore(t, 10)).toBe(1);
    expect(lastIndexAtOrBefore(t, 19.9)).toBe(1);
    expect(valueAt(t, v, 25)).toBe(3);
    expect(valueAt(t, v, -5)).toBeNull();
    expect(valueAt(t, v, 31)).toBeNull();
    expect(valueAt([], [], 0)).toBeNull();
  });
  it('merges sample times from several sources without duplicates', () => {
    expect([...unionTimes([[0, 10, 20], Float64Array.of(5, 10, 30)])]).toEqual([0, 5, 10, 20, 30]);
  });
  it('breaks a line where samples are missing for more than three steps', () => {
    expect(runs([0, 1, 2, 3, 10, 11, 12])).toEqual([[0, 4], [4, 7]]);
    expect(runs([0, 1, 2, 3, 4])).toEqual([[0, 5]]);
    expect(runs([0, 5])).toEqual([[0, 2]]);
    expect(runs([])).toEqual([]);
  });
});

describe('series styles', () => {
  it('colours beads by height rank on the shared ramp tokens, lowest darkest', () => {
    const { ranks, count } = heightRanks([1.5, 1, 2, 1]);
    expect(ranks).toEqual([1, 0, 2, 0]);
    expect(count).toBe(3);
    expect(beadColor(0, 3)).toBe('var(--plot-ramp-low)');
    expect(beadColor(1, 3)).toBe('color-mix(in oklab, var(--plot-ramp-high) 50%, var(--plot-ramp-low))');
    expect(beadColor(2, 3)).toBe('var(--plot-ramp-high)');
    expect(beadColor(0, 1)).toBe('var(--plot-ramp-low)');
  });
  it('tells sources apart by dash: solid measured, dashed simulated', () => {
    expect(seriesDash('measured', 0)).toBe('');
    expect(seriesDash('simulated', 0)).not.toBe('');
    expect(seriesDash('measured', 1)).not.toBe(seriesDash('measured', 0));
    expect(seriesDash('simulated', 1)).not.toBe(seriesDash('simulated', 0));
    expect(seriesDash('measured', 1)).not.toBe(seriesDash('simulated', 0));
    // Beyond the family, the last pattern repeats rather than inventing a hue.
    expect(seriesDash('measured', 9)).toBe(seriesDash('measured', 2));
  });
});
