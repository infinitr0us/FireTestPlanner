import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseFrameData } from './flame';
import {
  centredMean, fillTemplate, FlameAnalysisError, instantAt, integrate, joinPath, keyNumbers, localText,
  parseAnalysisManifest, parseEventManifest, parseOutlines, parseSeriesCsv, type Series,
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
    ['another version', (d: any) => { d.version = '1.1.0'; }, 'version'],
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
