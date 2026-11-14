import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisPlots, dashOf, readoutDecimals, readoutText, type Band, type PlotSpec } from './flame-analysis-plots';
import { fakeDocument } from './flame-analysis-test-support';

afterEach(() => vi.unstubAllGlobals());

/** The plots, with their first plot drawn at a size as its resize observer would. */
function board(spec: PlotSpec, window: [number, number], reveal = false, bands: Band[] = []): any {
  fakeDocument();
  const plots: any = new AnalysisPlots([spec], window, window[0], bands, [], () => {}, { reveal });
  const plot = plots.plots[0];
  plot.host.clientWidth = 400; plot.host.clientHeight = 200;
  plots.draw(plot);
  return plots;
}
const drawn = (spec: PlotSpec, window: [number, number]): any => board(spec, window).plots[0].svg;
const clipWidth = (plots: any): number => Number(plots.plots[0].svg.querySelector('clipPath').children[0].getAttribute('width'));

describe('drawing as the event plays', () => {
  const spec: PlotSpec = { id: 'volume', title: 'Flame volume', unit: 'm³', lines: [
    { label: 'every instant', role: 'reconstructed', nth: 0, thin: true, t: Float64Array.from([10, 11, 12]), v: Float64Array.from([0.002, 0.0796, 0.01]) },
  ] };
  it('ends the lines and the bands at the cursor, and follows it both ways', () => {
    const plots = board(spec, [10, 12], true, [{ from: 10.5, to: 11.5, kind: 'noHull' }]);
    // The plot rectangle runs from 44 to 390 px for the window 10 s to 12 s.
    plots.setTime(11);
    expect(clipWidth(plots)).toBeCloseTo(173, 6);
    plots.setTime(10);
    expect(clipWidth(plots)).toBe(0);
    plots.setTime(12);
    expect(clipWidth(plots)).toBeCloseTo(346, 6);
    const clip = plots.plots[0].svg.querySelector('clipPath').getAttribute('id');
    const band = plots.plots[0].svg.querySelectorAll('rect').find((r: any) => /flame-analysis__band/.test(r.getAttribute('class') ?? ''));
    expect(band.getAttribute('clip-path')).toBe(`url(#${clip})`);
  });
  it('keeps the whole plot without it', () => {
    const plots = board(spec, [10, 12]);
    plots.setTime(10);
    expect(clipWidth(plots)).toBeCloseTo(346, 6);
  });
});

describe('legend readings', () => {
  const line = (v: number[]) => ({ label: 'x', role: 'measured' as const, nth: 0, t: Float64Array.from(v.map((_, i) => i)), v: Float64Array.from(v) });
  it('give four significant digits at the plot’s largest value, then the same decimals to every reading', () => {
    expect(readoutDecimals({ id: 'v', title: 'v', unit: 'm³', lines: [line([0.002, 0.0796, 0.15])] }, [0, 2])).toBe(4);
    expect(readoutDecimals({ id: 'h', title: 'h', unit: 'kW', lines: [line([12, 366.2])] }, [0, 1])).toBe(1);
    expect(readoutDecimals({ id: 'h', title: 'h', unit: 'm', lines: [line([1.31])] }, [0, 0])).toBe(3);
    // Values outside the window and the plot's scale count as shown.
    expect(readoutDecimals({ id: 'v', title: 'v', unit: 'ft³', scale: 35.3146667, lines: [line([0.08, 9])] }, [0, 0])).toBe(3);
    expect(readoutDecimals({ id: 'z', title: 'z', unit: 'kW', lines: [line([0, 0])] }, [0, 1])).toBe(0);
  });
  it('keep their width as the cursor moves, never read minus zero, and dash a missing value', () => {
    expect(readoutText(0.002134, 4)).toBe('0.0021');
    expect(readoutText(0.0796, 4)).toBe('0.0796');
    expect(readoutText(-0.00001, 4)).toBe('0.0000');
    expect(readoutText(null, 2)).toBe('–');
    expect(readoutText(Number.NaN, 2)).toBe('–');
  });
});

describe('plot lines and the plot area', () => {
  // A hood record of the whole test: samples well before and after the event's instants.
  const spec: PlotSpec = { id: 'hrr', title: 'Heat release rate', unit: 'kW', lines: [
    { label: 'Hood', role: 'measured', nth: 0, t: Float64Array.from([8, 9, 9.5, 10, 11, 12, 12.5, 13, 14]), v: Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
    { label: 'Estimate', role: 'estimated', nth: 0, t: Float64Array.from([10, 11, 12]), v: Float64Array.from([4, 6, 5]) },
  ] };
  it('clips every line to the plot rectangle, so a longer series stops at the axis', () => {
    const svg = drawn(spec, [10, 12]);
    const clip = svg.querySelector('clipPath');
    const rect = clip.children[0];
    expect([Number(rect.getAttribute('x')), Number(rect.getAttribute('width'))]).toEqual([44, 400 - 10 - 44]);
    const paths = svg.querySelectorAll('path');
    expect(paths).toHaveLength(2);
    for (const path of paths) expect(path.getAttribute('clip-path')).toBe(`url(#${clip.getAttribute('id')})`);
    // The hood's line does start left of the axis (it has a sample half a second before); the clip hides that part.
    const xs = [...paths[0].getAttribute('d').matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeLessThan(44);
    expect(Math.max(...xs)).toBeGreaterThan(390);
  });
  it('tells a second measured line from the first, and leaves the other roles as they were', () => {
    expect(dashOf({ role: 'measured', nth: 0 })).toBe('');
    expect(dashOf({ role: 'measured', nth: 1 })).not.toBe('');
    expect(dashOf({ role: 'measured', nth: 1 })).not.toBe(dashOf({ role: 'estimated', nth: 0 }));
    expect(dashOf({ role: 'reconstructed', nth: 1 })).toBe('');
    expect(dashOf({ role: 'predicted', nth: 0 })).toBe('10 4');
  });
  it('gives each drawing a clip of its own', () => {
    const first = drawn(spec, [10, 12]).querySelector('clipPath').getAttribute('id');
    const second = drawn(spec, [10, 12]).querySelector('clipPath').getAttribute('id');
    expect(first).not.toBe(second);
  });
});
