import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseFrameData } from './flame';
import { flameHeightM } from './correlations';
import {
  centredMean, cumulative, fillTemplate, firstOrderResponse, FlameAnalysisError, heskestadSeries, instantAt, integrate,
  joinPath, keyNumbers, localText, parseAnalysisManifest, parseEventManifest, parseMesh, parseOutlines, parseSeriesCsv,
  type Series,
} from './flame-analysis';

const ROOT = new URL('../../../fixtures/flame-analysis/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');
const event = (id: string) => parseEventManifest(read(`${id}/event.json`), `${id}/event.json`);
const series = (id: string, name: string) => {
  const e = event(id);
  const s = e.series.find((x) => x.id === name)!;
  return parseSeriesCsv(read(joinPath(id, s.file)), s.time, s.value, s.file);
};

describe('the synthetic flame analysis test (mirror of python/tests/test_flame_analysis.py)', () => {
  it('reads the test and both events', () => {
    const analysis = parseAnalysisManifest(read('analysis.json'));
    expect(analysis.events.map((e) => e.id)).toEqual(['E1', 'E2']);
    expect(analysis.cameras.map((c) => c.id)).toEqual(['camA', 'camB', 'camC']);
    expect(localText(analysis.title, 'fr')).toBe('Essai synthétique d\'analyse de flamme');
    expect(localText(analysis.steps!.hrr!.text, 'en')).toMatch(/made-up coefficients/);
    const e1 = event('E1'), e2 = event('E2');
    expect(e1.cameras).toEqual(['camA', 'camB', 'camC']);
    expect(e2.cameras).toEqual(['camA', 'camB']);
    expect(e1.instants.t_s).toHaveLength(36);
    expect(e1.images.camC.size_px[0]).toBeLessThan(e1.images.camC.size_px[1]);
  });

  it('reads every series, outline and hull the board needs', async () => {
    for (const id of ['E1', 'E2']) {
      const e = event(id);
      for (const s of e.series) expect(series(id, s.id).t.length).toBeGreaterThan(10);
      for (const cam of e.cameras) {
        const outlines = parseOutlines(read(joinPath(id, fillTemplate(e.files.outlines, cam))), cam, e.instants.t_s.length);
        expect(outlines).toHaveLength(36);
        expect(outlines.some((rings) => rings.length > 0)).toBe(true);
      }
    }
    // The hull at an instant: its count is the metrics volume over the cube volume.
    const e1 = event('E1');
    const i = e1.instants.t_s.indexOf(101.5);
    const bytes = readFileSync(new URL(joinPath('E1', fillTemplate(e1.files.hull, undefined, e1.instants.stem[i])), ROOT));
    const frame = await parseFrameData('hull', new Uint8Array(bytes), 101.5);
    const volume = series('E1', 'volume');
    expect(frame.voxels.length / 3).toBe(Math.round(volume.v[i] / 0.03 ** 3));
  });

  it('computes the key numbers fireplan does', () => {
    const e1 = event('E1');
    const data = new Map(e1.series.map((s) => [s.id, series('E1', s.id)]));
    const k = keyNumbers(e1, data);
    expect(k.window).toEqual([99.5, 103]);
    expect(k.hood!.peak).toEqual({ value: 108.64, t: 103 });
    // numpy: trapezoid over [99.5, 103] of the hood interpolated at both ends.
    expect(k.hood!.heat_kJ).toBeCloseTo(146.585, 9);
    expect(k.estimates.map((x) => x.id)).toEqual(['hrr-from-volume', 'hrr-from-area']);
    expect(k.estimates[0].peakRatio).toBeCloseTo(k.estimates[0].peak.value / 108.64, 12);
    expect(k.height!.peak.value).toBeGreaterThan(1);
  });
});

describe('manifest validation', () => {
  const broken = (change: (d: Record<string, any>) => void): string => {
    const data = JSON.parse(read('E1/event.json'));
    change(data);
    return JSON.stringify(data);
  };
  it.each([
    ['a display template without {cam}', (d: any) => { d.files.display = 'frames/{stem}.png'; }, 'files/display'],
    ['a volume in kW', (d: any) => { d.series[3].unit = 'kW'; }, 'series/3/unit'],
    ['a basis on a volume', (d: any) => { d.series[3].basis = 'convective'; }, 'series/3/basis'],
    ['a path leaving the folder', (d: any) => { d.series[0].file = '../outside.csv'; }, 'series/0/file'],
    ['a drive path', (d: any) => { d.files.hull = 'C:/hull/{stem}.npz'; }, 'files/hull'],
    ['an unknown field', (d: any) => { d.surprise = 1; }, 'surprise'],
    ['another version', (d: any) => { d.version = '1.9.0'; }, 'version'],
  ])('refuses %s', (_, change, place) => {
    expect(() => parseEventManifest(broken(change))).toThrowError(new RegExp(`schema validation[\\s\\S]*${place}`));
  });
  it('refuses an unknown step and repeated ids in analysis.json', () => {
    const data = JSON.parse(read('analysis.json'));
    data.steps.tuning = { text: 'x' };
    expect(() => parseAnalysisManifest(JSON.stringify(data))).toThrowError(/unknown step 'tuning'/);
    delete data.steps.tuning;
    data.cameras[1].id = 'camA';
    expect(() => parseAnalysisManifest(JSON.stringify(data))).toThrowError(/camera ids repeat/);
  });
  it('fills templates with cam and stem only', () => {
    expect(fillTemplate('frames/{cam}/{stem}.png', 'a', 't_1')).toBe('frames/a/t_1.png');
    expect(() => fillTemplate('frames/{camera}/{stem}.png', 'a', 't_1')).toThrow(FlameAnalysisError);
    expect(() => fillTemplate('frames/{cam}/{stem}.png', 'a')).toThrow(FlameAnalysisError);
    expect(() => joinPath('E1', '../E2/event.json')).toThrow(FlameAnalysisError);
  });
});

describe('the frames of an exported video', () => {
  it('holds each instant for as many frames as the speed gives it', async () => {
    const { videoFrames } = await import('../ui/flame-analysis-video');
    const times = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
    // 0.5 s at x1 is 15 frames plus the last; each 0.1 s instant shows for 3 frames.
    expect(videoFrames(times, { from: 0, to: 0.5, speed: 1 })).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5]);
    // At x0.25 the same half second lasts 2 s: 12 frames per instant.
    const slow = videoFrames(times, { from: 0, to: 0.5, speed: 0.25 });
    expect(slow).toHaveLength(61);
    expect(slow.filter((i) => i === 2)).toHaveLength(12);
    // A start between instants shows the one before it; a range of zero is one frame.
    expect(videoFrames(times, { from: 0.15, to: 0.15, speed: 1 })).toEqual([1]);
  });
});

describe('series, outlines and numbers', () => {
  it('reads series CSVs as fireplan does', () => {
    const s = parseSeriesCsv('\ufefft,v\n0,1\n1,\n2,3.5\n', 't', 'v');
    expect([...s.t]).toEqual([0, 1, 2]);
    expect(s.v[0]).toBe(1);
    expect(Number.isNaN(s.v[1])).toBe(true);
    expect(() => parseSeriesCsv('t,v\ns,kW\n0,1\n', 't', 'v')).toThrowError(/row 2/);
    expect(() => parseSeriesCsv('t,v\n0,inf\n', 't', 'v')).toThrowError(/not a finite number/);
    expect(() => parseSeriesCsv('t,v\n0,1\n', 't', 'w')).toThrowError(/no column/);
    expect(() => parseSeriesCsv('t,v\n1,1\n0,1\n', 't', 'v')).toThrowError(/strictly increasing/);
  });
  it('refuses outlines of another camera or length', () => {
    const e2 = event('E2');
    const text = read(joinPath('E2', fillTemplate(e2.files.outlines, 'camA')));
    expect(() => parseOutlines(text, 'camB', 36)).toThrowError(/holds camera camA/);
    expect(() => parseOutlines(text, 'camA', 35)).toThrowError(/36 instants, the event has 35/);
  });
  it('holds an instant until the next', () => {
    const times = [-0.5, 0, 0.1];
    expect(instantAt(times, -1)).toBe(-1);
    expect(instantAt(times, -0.5)).toBe(0);
    expect(instantAt(times, 0.05)).toBe(1);
    expect(instantAt(times, 9)).toBe(2);
  });
  it('averages over one second and integrates by trapezoids', () => {
    const s: Series = { t: Float64Array.from([0, 0.5, 1, 1.5, 2]), v: Float64Array.from([0, 2, NaN, 4, 6]) };
    expect([...centredMean(s)]).toEqual([1, 1, 3, 5, 5]);
    const ramp: Series = { t: Float64Array.from([0, 1, 2]), v: Float64Array.from([0, 10, 20]) };
    expect(integrate(ramp, 0, 2)).toBe(20);
    expect(integrate(ramp, 0.5, 1.5)).toBe(10);
    expect(integrate(ramp, -5, 0)).toBe(0);
  });
});

describe('format 1.1: meshes and the hood response time (mirror of fireplan)', () => {
  it('reads E1 at 1.1 with its meshes, and E2 at 1.0', () => {
    const e1 = event('E1'), e2 = event('E2');
    expect([e1.version, e2.version]).toEqual(['1.1.0', '1.0.0']);
    expect(e1.series.find((s) => s.id === 'hood')!.responseTime_s).toBe(2.3);
    const i = e1.instants.t_s.indexOf(101.5);
    const mesh = parseMesh(new Uint8Array(readFileSync(new URL(joinPath('E1', fillTemplate(e1.files.mesh!, undefined, e1.instants.stem[i])), ROOT))));
    expect(mesh.indices.length / 3).toBeGreaterThan(1000);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
    const empty = parseMesh(new Uint8Array(readFileSync(new URL(joinPath('E1', fillTemplate(e1.files.mesh!, undefined, e1.instants.stem[0])), ROOT))));
    expect(empty.positions.length).toBe(0);
  });
  it('refuses 1.1 fields where they do not belong', () => {
    const e1 = JSON.parse(read('E1/event.json'));
    e1.series[1].responseTime_s = 2;
    expect(() => parseEventManifest(JSON.stringify(e1))).toThrowError(/series\/1\/responseTime_s/);
    const e2 = JSON.parse(read('E2/event.json'));
    e2.files.mesh = 'mesh/{stem}.ply';
    expect(() => parseEventManifest(JSON.stringify(e2))).toThrowError(/unexpected property 'mesh'/);
  });
  it('refuses a mesh file of the wrong length', () => {
    const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', 'element vertex 1',
      'property float x', 'property float y', 'property float z', 'element face 0',
      'property list uchar int vertex_indices', 'end_header', ''].join(String.fromCharCode(10)));
    const bytes = new Uint8Array(header.length + 11);
    bytes.set(header);
    expect(() => parseMesh(bytes)).toThrowError(/bytes after the header/);
  });
});

describe('what the board derives from the series', () => {
  it('passes a step through a first-order response', () => {
    const t = Float64Array.from({ length: 41 }, (_, i) => i * 0.25);
    const step: Series = { t, v: t.map((x) => (x < 1 ? 0 : 100)) };
    const r = firstOrderResponse(step, 2).v;
    expect(r[4]).toBe(0);                                   // at t = 1 the input has just changed
    expect(r[12]).toBeCloseTo(100 * (1 - Math.exp(-1)), 9); // one time constant later: 63 %
    expect(r[40]).toBeCloseTo(100 * (1 - Math.exp(-4.5)), 9);
  });
  it('integrates heat released as it goes', () => {
    const ramp: Series = { t: Float64Array.from([0, 1, 2, 3]), v: Float64Array.from([0, 10, 10, NaN]) };
    expect([...cumulative(ramp).v]).toEqual([0, 5, 15, 15]);
  });
  it('turns a convective hood record into a Heskestad height through the radiative fraction', () => {
    const hood: Series = { t: Float64Array.from([0, 1]), v: Float64Array.from([70, NaN]) };
    const h = heskestadSeries(hood, 0.3, true, 0.3, flameHeightM).v;
    expect(h[0]).toBeCloseTo(flameHeightM(100, 0.3), 12);  // 70 kW convective is 100 kW total at 0.3
    expect(Number.isNaN(h[1])).toBe(true);
    expect(heskestadSeries(hood, 0.3, false, 0.3, flameHeightM).v[0]).toBeCloseTo(flameHeightM(70, 0.3), 12);
  });
});

describe('the hull check projection', () => {
  it('is projectToPixels with the camera basis computed once', async () => {
    const { parseAndValidatePlan } = await import('./validate');
    const { cameras, projectToPixels, fxOf } = await import('./plan');
    const { projectHull } = await import('./flame-analysis');
    const plan = parseAndValidatePlan(read('site.ftp.json'));
    const points = [0.05, -0.02, 0.4, -0.1, 0.12, 1.1, 0.2, 0.2, 0.9];
    for (const camera of cameras(plan)) {
      const projection = projectHull(camera, points, 0.03);
      for (let i = 0; i < 3; i++) {
        const { u, v } = projectToPixels(camera, [points[3 * i], points[3 * i + 1], points[3 * i + 2]]);
        expect(projection.uv[2 * i]).toBeCloseTo(u, 3);
        expect(projection.uv[2 * i + 1]).toBeCloseTo(v, 3);
      }
      // About one cube's width in pixels at the points' mean distance.
      expect(projection.size).toBeGreaterThan(0);
      expect(projection.size).toBeLessThan(fxOf(camera) * 0.03);
    }
  });
});
