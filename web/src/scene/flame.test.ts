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
import { FlameStore, flameKey, manifestDrift, type FlameSource } from '../state/flame-store';
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

  it('notices a folder whose voxels moved, even with every timestamp and count intact', () => {
    // A re-run that translated the hull kept the manifest's frames and grid, so
    // the placement checks -- which read the plan's bounds -- described a hull
    // that was no longer where the folder put it, and nothing said so.
    const manifest = flameSequenceLink(flameOf(load()))!.sequence!;
    const [lo, hi] = manifest.bounds_m;
    const moved = { ...manifest, bounds_m: [[lo[0] + 10, lo[1], lo[2] - 2], [hi[0] + 10, hi[1], hi[2] - 2]] as typeof manifest.bounds_m };
    expect(manifestDrift(sequence, moved)).toMatch(/different region/);
    const regridded = { ...manifest, grid: { ...manifest.grid, resolution: 96 } };
    expect(manifestDrift(sequence, regridded)).toMatch(/voxel grid/);
    expect(manifestDrift(sequence, manifest)).toBeNull();
  });

  it('lets a cancelled read finish without touching the read that replaced it', async () => {
    // Close a plan and reopen it before its frames are in: the first read is
    // cancelled, the second starts under the same key. The first read's clean-up
    // used to delete the second's cancel and pending promise, so a later clear
    // could not stop the second and it repopulated a cache it had been told to drop.
    const link = flameSequenceLink(flameOf(load()))!;
    const names = readdirSync(FOLDER).filter((n) => frameTimestamp(n) !== null);
    const gate = (): { promise: Promise<void>; release: () => void } => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      return { promise, release };
    };
    const source = (opened: Promise<void>): FlameSource => ({
      kind: 'shell', path: 'voxels',
      list: async () => { await opened; return names; },
      read: async (name) => new Uint8Array(readFileSync(FOLDER + name)),
    });
    const store = new FlameStore();
    const first = gate(), second = gate();
    const a = store.load(link, source(first.promise));
    store.clear();
    const b = store.load(link, source(second.promise));
    expect(store.get(link)?.status).toBe('loading');
    first.release();
    await expect(a).rejects.toThrow('cancelled');
    // The second read is still the one a joiner shares the fate of, and still
    // the one clear stops: the joiner used to resolve to nothing at all.
    const joined = store.load(link, source(Promise.resolve()));
    store.clear();
    second.release();
    await expect(b).rejects.toThrow('cancelled');
    await expect(joined).rejects.toThrow('cancelled');
    expect(store.sequenceOf(link)).toBeUndefined();
    // Left alone, a read lands, and a joiner gets the same sequence.
    const c = store.load(link, source(Promise.resolve()));
    const d = store.load(link, source(Promise.resolve()));
    expect((await c).frames).toHaveLength(80);
    expect(await d).toBe(await c);
    expect(store.get(link)?.status).toBe('ready');
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
    clock.advance(1); // past the end: the last frame holds for the previous interval (5 s)
    expect(clock.time_s).toBe(10);
    expect(clock.markIndexAt(clock.time_s)).toBe(2);
    clock.advance(0.3); // 16 s on a 15 s period: wrapped to 1 s
    expect(clock.time_s).toBeCloseTo(1);
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

  it('shows the last frame when looping at an ordinary tick rate', () => {
    // The last mark is an instant; wrapping the moment time passed it meant a
    // 60 Hz loop over [0, 5, 10] only ever showed frames 1 and 2.
    const clock = new Playhead();
    clock.setMarks([0, 5, 10]);
    clock.play();
    const seen = new Set<number>();
    let peak = -Infinity;
    for (let i = 0; i < 10_000; i += 1) {
      clock.advance(1 / 60);
      seen.add(clock.markIndexAt(clock.time_s));
      peak = Math.max(peak, clock.time_s);
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
    expect(peak).toBe(10); // held at the mark, never reported past it
    expect(clock.holdAfterEnd).toBe(5);
    // A single frame has nothing to loop over and stays put.
    clock.setMarks([7]);
    clock.play();
    clock.advance(1);
    expect(clock.time_s).toBe(7);
    // New marks while the old last frame is held: the clock is at that frame, not past it.
    clock.setMarks([0, 5, 10]);
    clock.seek(10);
    clock.advance(0.2); // 12 s internally, held at 10
    clock.setMarks([0, 5, 10, 12]);
    expect(clock.time_s).toBe(10);
  });
});
