/**
 * Format 1.4: the reconstructedFlame object, its voxelSequence link and its checks.
 *
 * The Python suite (`python/tests/test_flame.py`) runs the same fixture and the
 * same `check-cases.json`, so the two writers and the two check implementations
 * are held to each other rather than merely to themselves.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { linkedFilesProblem, linkKindFor, maxLinksFor, voxelSequenceProblem } from './linked-files';
import {
  boundsPoints, checkPlan, flameBoundsCorners, flameBurner, flameChecks, flameManifest, newPlan,
  plotFollowsFlame, plotSequenceMismatch, reconstructedFlames,
} from './plan';
import { serializePlan } from './serialize';
import {
  requiredFormatVersion, type BurnerObject, type PlanDocument, type ReconstructedFlameObject,
  type VoxelSequenceManifest,
} from './types';
import { parseAndValidatePlan, validateStructure } from './validate';
import { Store } from '../state/store';

const FIXTURE = new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url);
const TEXT = readFileSync(FIXTURE, 'utf8');
const load = (): PlanDocument => JSON.parse(TEXT) as PlanDocument;
const flameOf = (doc: PlanDocument): ReconstructedFlameObject => reconstructedFlames(doc)[0];
const burnerOf = (doc: PlanDocument): BurnerObject => doc.objects.find((o) => o.id === 'burner-main') as BurnerObject;

interface CheckCase {
  name: string;
  flame?: Partial<ReconstructedFlameObject>;
  plotSamples?: [number, number, number][];
  plotShiftSeconds?: number;
  plotVolumeDelta?: { row: number; voxels: number };
  expect: string[];
}
const CASES = JSON.parse(readFileSync(new URL('../../../fixtures/flame/check-cases.json', import.meta.url), 'utf8')) as CheckCase[];

function applyCase(doc: PlanDocument, c: CheckCase): PlanDocument {
  const flame = flameOf(doc), burner = burnerOf(doc);
  Object.assign(flame, c.flame ?? {});
  const plot = burner.linkedFiles![0].plot!;
  if (c.plotSamples) plot.samples = c.plotSamples;
  if (c.plotShiftSeconds !== undefined) plot.samples = plot.samples.map(([t, v, a]) => [t + c.plotShiftSeconds!, v, a]);
  if (c.plotVolumeDelta) plot.samples[c.plotVolumeDelta.row][1] += c.plotVolumeDelta.voxels * flameManifest(flame)!.grid.voxelSize_m ** 3;
  return doc;
}

describe('the flame fixture', () => {
  it('agrees byte-for-byte with the Python-written fixture and loads', () => {
    expect(serializePlan(load())).toBe(TEXT);
    const doc = parseAndValidatePlan(TEXT);
    expect(doc.version).toBe('1.4.0');
    expect(requiredFormatVersion(doc)).toBe('1.4.0');
    const flame = flameOf(doc);
    expect(flame).toMatchObject({ id: 'flame-main', burnerId: 'burner-main', representation: 'voxels', display: { locked: true } });
    const manifest = flameManifest(flame)!;
    expect(manifest.grid).toEqual({ voxelSize_m: 0.015625, pitch_m: 0.015706806282722363, resolution: 192 });
    expect(manifest.frames).toHaveLength(80);
    expect(manifest.frames[11]).toEqual([55, 25639]);
    expect(flameBurner(doc, flame)!.id).toBe('burner-main');
    // The HRR is the synthetic design fire specification.
    expect(burnerOf(doc).fire!.hrr_kw).toBe(80);
    expect(checkPlan(doc).filter((i) => i.code.startsWith('flame-'))).toEqual([]);
  });

  it('frames the hull for Fit and the drawing from the manifest alone', () => {
    const doc = load();
    const corners = flameBoundsCorners(flameOf(doc));
    expect(corners).toHaveLength(8);
    const points = boundsPoints(doc);
    for (const corner of corners) expect(points).toContainEqual(corner);
    delete flameOf(doc).linkedFiles;
    expect(flameBoundsCorners(flameOf(doc))).toEqual([]);
  });

  it('is the top version tier, above any link', () => {
    const doc = newPlan();
    expect(requiredFormatVersion(doc)).toBe('1.0.0');
    doc.objects.push({ id: 'f', type: 'reconstructedFlame' });
    expect(requiredFormatVersion(doc)).toBe('1.4.0');
    expect(parseAndValidatePlan(serializePlan(doc)).version).toBe('1.4.0');
    // Older declared versions are corrected; newer ones are left alone.
    doc.version = '2.0.0';
    expect(parseAndValidatePlan(serializePlan(doc)).version).toBe('2.0.0');
  });

  it('survives undo, duplication and a store round-trip with its manifest intact', () => {
    const store = new Store(load());
    store.select([flameOf(store.document).id]);
    store.duplicateSelected();
    expect(reconstructedFlames(store.document)).toHaveLength(2);
    expect(flameManifest(reconstructedFlames(store.document)[1])).toEqual(flameManifest(flameOf(store.document)));
    store.undo();
    expect(reconstructedFlames(store.document)).toHaveLength(1);
    store.loadFromText(store.serialize(), 'saved.ftp.json');
    expect(flameManifest(flameOf(store.document))!.frames).toHaveLength(80);
  });
});

describe('the writer', () => {
  it('orders the new keys and drops the reserved offset at zero', () => {
    const doc = load();
    const link = flameOf(doc).linkedFiles![0];
    link.timeOffset_s = 0;
    expect(serializePlan(doc)).not.toContain('timeOffset_s');
    link.timeOffset_s = 1.5;
    const text = serializePlan(doc);
    expect(text).toContain('"timeOffset_s": 1.5');
    expect(text.indexOf('"label"')).toBeLessThan(text.indexOf('"timeOffset_s"'));
    expect(text.indexOf('"timeOffset_s"')).toBeLessThan(text.indexOf('"sequence"'));
    expect(() => parseAndValidatePlan(text)).not.toThrow();
  });

  it('keeps the advisory appearance keys after locked', () => {
    const doc = load();
    flameOf(doc).display = { colorMode: 'solid', opacity: 0.4, locked: true };
    const text = serializePlan(doc);
    expect(text.indexOf('"locked": true')).toBeLessThan(text.indexOf('"opacity": 0.4'));
    expect(text.indexOf('"opacity": 0.4')).toBeLessThan(text.indexOf('"colorMode": "solid"'));
    expect(parseAndValidatePlan(text).objects.find((o) => o.id === 'flame-main')!.display).toEqual({ locked: true, opacity: 0.4, colorMode: 'solid' });
  });

  it('keeps the manifest at full precision, like a plot', () => {
    const doc = parseAndValidatePlan(serializePlan(load()));
    expect(flameManifest(flameOf(doc))!.bounds_m[0][2]).toBe(0.009947643979057563);
  });
});

describe('validation', () => {
  it('knows which kind each object links and how many', () => {
    expect(linkKindFor('camera')).toBe('video');
    expect(linkKindFor('burner')).toBe('spreadsheet');
    expect(linkKindFor('reconstructedFlame')).toBe('voxelSequence');
    expect(maxLinksFor('reconstructedFlame')).toBe(1);
    expect(maxLinksFor('camera')).toBe(100);
  });

  it('refuses the wrong kind, a second link, a plot, or a sequence elsewhere', () => {
    const doc = load();
    const flame = flameOf(doc), burner = burnerOf(doc);
    const link = flame.linkedFiles![0];
    link.kind = 'spreadsheet';
    expect(linkedFilesProblem(flame)).toMatch(/reconstructed flame links a voxel sequence/);
    link.kind = 'voxelSequence';
    flame.linkedFiles!.push({ ...link, id: 'second' });
    expect(linkedFilesProblem(flame)).toMatch(/one voxel sequence/);
    flame.linkedFiles!.pop();
    link.plot = { importedAt: 'x', samples: [[0, 0, 0]] };
    expect(() => parseAndValidatePlan(serializePlan(doc))).toThrow();
    delete link.plot;
    burner.linkedFiles![0].sequence = link.sequence;
    expect(linkedFilesProblem(burner)).toMatch(/Only a reconstructed flame/);
    delete burner.linkedFiles![0].sequence;
    link.timeOffset_s = Number.NaN;
    expect(linkedFilesProblem(flame)).toMatch(/finite number of seconds/);
  });

  it.each<[string, (s: VoxelSequenceManifest) => void, RegExp]>([
    ['pitch under voxel size', (s) => { s.grid.pitch_m = 0.01; }, /pitch no smaller/],
    ['zero voxel size', (s) => { s.grid.voxelSize_m = 0; }, /positive voxel size/],
    ['fractional resolution', (s) => { s.grid.resolution = 1.5; }, /integer grid resolution/],
    ['bounds reversed', (s) => { s.bounds_m = [[1, 0, 0], [0, 1, 1]]; }, /minimum corner first/],
    ['no frames', (s) => { s.frames = []; }, /1–20,000 frames/],
    ['time not increasing', (s) => { s.frames = [[5, 1], [5, 2]]; }, /strictly increasing/],
    ['negative count', (s) => { s.frames = [[5, -1]]; }, /non-negative integer/],
    ['fractional count', (s) => { s.frames = [[5, 1.5]]; }, /non-negative integer/],
    ['extra key', (s) => { (s as unknown as Record<string, unknown>).extra = 1; }, /unsupported field/],
  ])('refuses a manifest with %s', (_name, edit, message) => {
    const doc = load();
    const manifest = flameManifest(flameOf(doc))!;
    expect(voxelSequenceProblem(manifest)).toBeNull();
    edit(manifest);
    expect(voxelSequenceProblem(manifest)).toMatch(message);
    expect(validateStructure(doc).map((i) => i.code)).toContain('bad-linked-files');
  });

  it('accepts a null resolution and refuses what the object itself gets wrong', () => {
    const doc = load();
    flameManifest(flameOf(doc))!.grid.resolution = null;
    expect(validateStructure(doc)).toEqual([]);
    const flame = flameOf(doc) as unknown as Record<string, unknown>;
    flame.representation = 'mesh';
    expect(validateStructure(doc).map((i) => i.code)).toContain('bad-representation');
    flame.representation = 'voxels';
    flame.burnerId = 7;
    expect(validateStructure(doc).map((i) => i.code)).toContain('bad-burner-id');
    flame.burnerId = null;
    flame.display = { opacity: 2 };
    expect(validateStructure(doc).map((i) => i.code)).toContain('bad-opacity');
    flame.display = { colorMode: 'rainbow' };
    expect(validateStructure(doc).map((i) => i.code)).toContain('bad-color-mode');
    flame.display = { colorMode: 'solid', opacity: 0 };
    expect(validateStructure(doc)).toEqual([]);
  });
});

describe('checks', () => {
  it.each(CASES)('matches the shared Python check case: $name', (c) => {
    const doc = applyCase(load(), c);
    const issues = checkPlan(doc).filter((i) => i.code.startsWith('flame-'));
    expect(issues.map((i) => i.code).sort()).toEqual([...c.expect].sort());
    for (const issue of issues) expect(issue.objectId).toBe('flame-main');
  });

  it('says why a CSV is not this run\'s', () => {
    const manifest = flameManifest(flameOf(load()))!;
    expect(plotSequenceMismatch([[0, 0, 0]], manifest)).toBe('has 1 samples against 80 frames');
    const samples = manifest.frames.map(([t, n]): [number, number, number] => [t, n * manifest.grid.voxelSize_m ** 3, 0]);
    expect(plotSequenceMismatch(samples, manifest)).toBeNull();
    samples[3][0] = 16;
    expect(plotSequenceMismatch(samples, manifest)).toBe('is sampled at 16 s where the sequence has a frame at 15 s');
    samples[3][0] = 15;
    samples[11][1] = 0.1;
    expect(plotSequenceMismatch(samples, manifest)).toBe('records 0.1 m³ at 55 s where the frame holds 25639 voxels');
  });

  it('runs with no burner in the plan at all', () => {
    const doc = load();
    doc.objects = doc.objects.filter((o) => o.type !== 'burner');
    expect(flameChecks(doc).map((i) => i.code)).toEqual(['flame-burner-unknown']);
    flameOf(doc).burnerId = null;
    expect(flameChecks(doc)).toEqual([]);
    flameOf(doc).transform!.position_m = [0, 0, -1];
    expect(flameChecks(doc).map((i) => i.code)).toEqual(['flame-below-floor']);
  });

  it('lets only the reconstruction\'s own CSV follow the playback clock', () => {
    // Any loaded flame used to drive every burner plot: a CSV sampled at 1000 s on
    // another burner had its slider dragged back to 0 by a clock clamped at 395.
    const doc = load();
    const burner = burnerOf(doc), link = burner.linkedFiles![0];
    expect(plotFollowsFlame(doc, burner, link)).toBe(true);
    const other: BurnerObject = {
      ...JSON.parse(JSON.stringify(burner)), id: 'burner-2', transform: { position_m: [5, 0, 0] },
      linkedFiles: [{ id: 'v2', kind: 'spreadsheet', path: 'other.csv', plot: { importedAt: 'x', samples: [[1000, 0.1, 1], [1005, 0.1, 1]] } }],
    };
    doc.objects.push(other);
    expect(plotFollowsFlame(doc, other, other.linkedFiles![0])).toBe(false);
    // The flame's burner with a CSV from another run keeps its own slider too.
    const shifted = { ...link, plot: { ...link.plot!, samples: link.plot!.samples.map(([t, v, a]): [number, number, number] => [t + 1, v, a]) } };
    expect(plotFollowsFlame(doc, burner, shifted)).toBe(false);
    // Nothing to follow while this burner's own flame is not loaded: the clock
    // would be running on some other flame's time.
    expect(plotFollowsFlame(doc, burner, link, () => false)).toBe(false);
    expect(plotFollowsFlame(doc, burner, link, (f) => f.id === 'flame-main')).toBe(true);
    // Nothing to follow without a manifest, and a link without a plot never follows.
    expect(plotFollowsFlame(doc, burner, { ...link, plot: undefined })).toBe(false);
    delete flameOf(doc).linkedFiles;
    expect(plotFollowsFlame(doc, burner, link)).toBe(false);
  });
});
