import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisPlots, dashOf, type PlotSpec } from './flame-analysis-plots';
import { fakeDocument } from './flame-analysis-test-support';

afterEach(() => vi.unstubAllGlobals());

/** Draw one plot at a size, as its resize observer would. */
function drawn(spec: PlotSpec, window: [number, number]): any {
  fakeDocument();
  const plots: any = new AnalysisPlots([spec], window, window[0], [], [], () => {});
  const plot = plots.plots[0];
  plot.host.clientWidth = 400; plot.host.clientHeight = 200;
  plots.draw(plot);
  return plot.svg;
}

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
