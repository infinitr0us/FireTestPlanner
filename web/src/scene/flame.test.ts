/**
 * The flame layer and the clock, without a GPU: geometry, attributes and frame
 * selection are plain data until a renderer touches them.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { FlameSequence, frameTimestamp, parseFrameFile } from '../core/flame';
import { flameSequenceLink, reconstructedFlames } from '../core/plan';
import type { PlanDocument, ReconstructedFlameObject } from '../core/types';
import { FlameStore, flameKey, manifestDrift } from '../state/flame-store';
import { Playhead } from '../state/playhead';
import { FlameLayer, FlameMesh } from './flame';

const FOLDER = fileURLToPath(new URL('../../../fixtures/flame/voxels/', import.meta.url));
const PLAN = fileURLToPath(new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url));

let sequence: FlameSequence;
const load = (): PlanDocument => JSON.parse(readFileSync(PLAN, 'utf8')) as PlanDocument;
const flameOf = (doc: PlanDocument): ReconstructedFlameObject => reconstructedFlames(doc)[0];

beforeAll(async () => {
  const names = readdirSync(FOLDER).filter((n) => frameTimestamp(n) !== null);
  sequence = FlameSequence.fromFrames(await Promise.all(
    names.map((n) => parseFrameFile(n, new Uint8Array(readFileSync(FOLDER + n)))),
  ));
});

describe('FlameMesh', () => {
  it('draws the surface cells of the frame it is set to', () => {
    const mesh = new FlameMesh();
    expect(mesh.cubeCount).toBe(0);
    mesh.setSequence(sequence);
    expect(mesh.setFrame(0)).toBe(true);
    expect(mesh.cubeCount).toBe(0); // t = 0 is empty
    expect(mesh.setFrame(0)).toBe(false); // already there
    expect(mesh.setFrame(11)).toBe(true); // t = 55 s
    expect(mesh.cubeCount).toBe(6132);
    expect(mesh.setFrame(-1)).toBe(true);
    expect(mesh.cubeCount).toBe(0);
    mesh.setSequence(null);
    expect(mesh.setFrame(11)).toBe(true);
    expect(mesh.cubeCount).toBe(0);
    mesh.dispose();
  });
});

describe('FlameLayer', () => {
  it('binds a loaded sequence to its object and follows the clock', () => {
    const doc = load();
    const store = new FlameStore();
    const layer = new FlameLayer(store);
    layer.sync(doc);
    expect(layer.cubeCount).toBe(0);
    store.attach(flameSequenceLink(flameOf(doc))!, sequence);
    layer.sync(doc);
    expect(layer.setTime(20, doc)).toBe(true);
    expect(layer.cubeCount).toBeGreaterThan(0);
    expect(layer.setTime(22, doc)).toBe(false); // same frame held
    expect(layer.setTime(-1, doc)).toBe(true);
    expect(layer.cubeCount).toBe(0);
    // Hidden flames draw nothing and count nothing.
    flameOf(doc).display = { visible: false };
    layer.sync(doc);
    layer.setTime(55, doc);
    expect(layer.cubeCount).toBe(0);
    // Removing the object removes its mesh.
    doc.objects = doc.objects.filter((o) => o.type !== 'reconstructedFlame');
    layer.sync(doc);
    expect(layer.root.children).toHaveLength(0);
    layer.dispose();
  });
});

describe('FlameStore', () => {
  it('keys by path and manifest, and notices a folder that changed', () => {
    const doc = load();
    const link = flameSequenceLink(flameOf(doc))!;
    const store = new FlameStore();
    const entry = store.attach(link, sequence);
    expect(entry.status).toBe('ready');
    expect(entry.changed).toBeUndefined();
    expect(store.sequenceOf(link)).toBe(sequence);
    const other = { ...link, path: 'elsewhere/voxels' };
    expect(flameKey(other)).not.toBe(flameKey(link));
    expect(store.sequenceOf(other)).toBeUndefined();
    const drifted = { ...link, sequence: { ...link.sequence!, frames: link.sequence!.frames.slice(0, 79) } };
    expect(manifestDrift(sequence, drifted.sequence)).toMatch(/holds 80 frames; the plan expected 79/);
    expect(store.attach(drifted, sequence).changed).toMatch(/80 frames/);
    store.clear();
    expect(store.sequenceOf(link)).toBeUndefined();
  });
});

describe('Playhead', () => {
  it('holds, steps, loops and clamps to its marks', () => {
    const clock = new Playhead();
    const events: string[] = [];
    clock.subscribe((e) => events.push(e));
    expect(clock.hasRange).toBe(false);
    clock.play();
    expect(clock.playing).toBe(false);
    clock.setMarks([10, 0, 5, 5]);
    expect([...clock.marks]).toEqual([0, 5, 10]);
    expect(clock.markIndexAt(-1)).toBe(-1);
    expect(clock.markIndexAt(7)).toBe(1);
    clock.seek(100);
    expect(clock.time_s).toBe(10);
    clock.step(1);
    expect(clock.time_s).toBe(10);
    clock.step(-1);
    expect(clock.time_s).toBe(5);
    clock.seek(7);
    clock.step(-1);
    expect(clock.time_s).toBe(0);
    clock.setSpeed(10);
    clock.play();
    expect(clock.playing).toBe(true);
    clock.advance(0.3); // 3 s of test time
    expect(clock.time_s).toBeCloseTo(3);
    clock.advance(1); // past the end: loops
    expect(clock.time_s).toBeCloseTo(3);
    clock.setLoop(false);
    clock.seek(9);
    clock.advance(1);
    expect(clock.time_s).toBe(10);
    expect(clock.playing).toBe(false);
    clock.play(); // from the end: starts over
    expect(clock.time_s).toBe(0);
    clock.advance(0); // no time passed
    expect(clock.time_s).toBe(0);
    clock.setMarks([]);
    expect(clock.playing).toBe(false);
    expect(events).toContain('range');
    expect(events).toContain('state');
    expect(events).toContain('time');
  });
});
