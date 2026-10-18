/**
 * The flame codec, held to the Python engine on the fixture.
 *
 * `fixtures/flame/expected.json` is written by `python/fireplan/flame.py`: the
 * manifest, the packed bytes' digest, and the surface cells' digest. Two readers
 * that agree about the file format but not about where a voxel sits would draw
 * two different flames from one folder.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FlameSequence,
  frameTimestamp,
  inferPitch,
  inferResolution,
  packFrame,
  parseFrameFile,
  parseNpy,
  readZip,
  surfaceCells,
  gzip,
  gunzip,
  type RawFrame,
} from './flame';
import { voxelSequenceProblem } from './linked-files';

const FOLDER = fileURLToPath(new URL('../../../fixtures/flame/voxels/', import.meta.url));
const EXPECTED = JSON.parse(readFileSync(fileURLToPath(new URL('../../../fixtures/flame/expected.json', import.meta.url)), 'utf8'));

let cached: Promise<FlameSequence> | null = null;
const fixture = (): Promise<FlameSequence> => {
  cached ??= (async () => {
    const names = readdirSync(FOLDER).filter((n) => frameTimestamp(n) !== null);
    const raw = await Promise.all(names.map((n) => parseFrameFile(n, new Uint8Array(readFileSync(FOLDER + n)))));
    return FlameSequence.fromFrames(raw);
  })();
  return cached;
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A synthetic frame on a linspace-style lattice: pitch = size * res / (res - 1). */
function synthetic(timestamp: number, cells: [number, number, number][], pitch = 0.1, origin = [-1, -1, 0]): RawFrame {
  const voxels = new Float64Array(cells.length * 3);
  cells.forEach(([i, j, k], n) => { voxels[n * 3] = origin[0] + i * pitch; voxels[n * 3 + 1] = origin[1] + j * pitch; voxels[n * 3 + 2] = origin[2] + k * pitch; });
  return { timestamp_s: timestamp, voxels, voxelSize_m: pitch * 20 / 21 };
}

describe('frame files', () => {
  it('reads the timestamp from the file name only', () => {
    expect(frameTimestamp('t_0000055.0s.npz')).toBe(55);
    expect(frameTimestamp('voxels/t_0000005.0s.npz')).toBe(5);
    expect(frameTimestamp('t_12.25s.npz')).toBe(12.25);
    expect(frameTimestamp('t_0000055.0s.ply')).toBeNull();
    expect(frameTimestamp('volumes.csv')).toBeNull();
    expect(frameTimestamp('t_-5.0s.npz')).toBeNull();
  });

  it('parses the synthetic npz through the central directory', async () => {
    const entries = await readZip(new Uint8Array(readFileSync(FOLDER + 't_0000055.0s.npz')));
    expect([...entries.keys()].sort()).toEqual(['voxel_size.npy', 'voxels.npy']);
    const voxels = parseNpy(entries.get('voxels.npy')!);
    expect(voxels).toMatchObject({ dtype: '<f8', shape: [25639, 3], fortranOrder: false });
    const frame = await parseFrameFile('t_0000055.0s.npz', new Uint8Array(readFileSync(FOLDER + 't_0000055.0s.npz')));
    expect(frame.timestamp_s).toBe(55);
    expect(frame.voxels.length).toBe(25639 * 3);
    expect(frame.voxelSize_m).toBe(0.015625);
  });

  it('accepts an empty frame', async () => {
    const frame = await parseFrameFile('t_0000000.0s.npz', new Uint8Array(readFileSync(FOLDER + 't_0000000.0s.npz')));
    expect(frame.voxels.length).toBe(0);
  });

  it('refuses what is not a frame, by name', async () => {
    const bytes = new Uint8Array(readFileSync(FOLDER + 't_0000055.0s.npz'));
    await expect(parseFrameFile('t_0000055.0s.ply', bytes)).rejects.toThrow('not named t_<seconds>s.npz');
    await expect(parseFrameFile('t_0000001.0s.npz', new Uint8Array([1, 2, 3]))).rejects.toThrow('not a ZIP archive');
    expect(() => parseNpy(new Uint8Array(20))).toThrow('not a .npy array');
  });
});

describe('the lattice', () => {
  it('infers the pitch from the coordinates, not from voxel_size', () => {
    const frame = synthetic(0, [[0, 0, 0], [1, 0, 0], [5, 2, 3]]);
    expect(inferPitch(frame.voxels)).toBeCloseTo(0.1, 12);
    // The res-1 trap: pitch/voxel_size = res/(res-1) recovers the grid resolution.
    expect(inferResolution(0.015706806282722363, 0.015625)).toBe(192);
    expect(inferResolution(0.1, 0.1 * 20 / 21)).toBe(21);
    expect(inferResolution(0.01, 0.01)).toBeNull();
  });

  it('needs two voxels on one row to infer a pitch', () => {
    const lonely = synthetic(0, [[0, 0, 0]]);
    expect(() => inferPitch(lonely.voxels)).toThrow('no two voxels');
  });

  it('refuses a frame off the lattice, and a duplicated voxel', () => {
    const off = new Float64Array([0, 0, 0, 0.13, 0, 0]);
    expect(() => packFrame(0, off, [0, 0, 0], 0.1)).toThrow('not on the sequence lattice');
    const dup = new Float64Array([0.1, 0, 0, 0.1, 0, 0]);
    expect(() => packFrame(0, dup, [0, 0, 0], 0.1)).toThrow('duplicate voxel');
    const before = new Float64Array([-0.1, 0, 0]);
    expect(() => packFrame(0, before, [0, 0, 0], 0.1)).toThrow('before the lattice origin');
  });
});

describe('packing', () => {
  it('bit-packs a bounding box in numpy order', () => {
    const frame = packFrame(1, synthetic(1, [[2, 3, 4], [2, 3, 5], [3, 3, 4]]).voxels, [-1, -1, 0], 0.1);
    expect(frame).toMatchObject({ count: 3, origin: [2, 3, 4], dims: [2, 1, 2] });
    // cells flat: (0,0,0)=1 (0,0,1)=1 (1,0,0)=1 (1,0,1)=0 -> bits 1110 0000
    expect([...frame.bits]).toEqual([0b11100000]);
  });

  it('lists surface cells with the box boundary counting as empty', () => {
    // A 3x3x3 solid block: only the centre is enclosed.
    const cells: [number, number, number][] = [];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) for (let k = 0; k < 3; k += 1) cells.push([i, j, k]);
    const frame = packFrame(0, synthetic(0, cells).voxels, [-1, -1, 0], 0.1);
    const surface = surfaceCells(frame);
    expect(surface).toBeInstanceOf(Uint8Array);
    expect(surface.length / 3).toBe(26);
    expect([...surface.slice(0, 3)]).toEqual([0, 0, 0]);
    expect(surfaceCells(packFrame(0, new Float64Array(0), [0, 0, 0], 0.1)).length).toBe(0);
  });

  it('widens to 16 bits when a box axis exceeds 256 cells', () => {
    const frame = packFrame(0, synthetic(0, [[0, 0, 0], [300, 0, 0]]).voxels, [-1, -1, 0], 0.1);
    expect(surfaceCells(frame)).toBeInstanceOf(Uint16Array);
  });
});

describe('the sequence', () => {
  it('orders frames by time and refuses a duplicated timestamp', () => {
    const seq = FlameSequence.fromFrames([synthetic(10, [[0, 0, 0], [1, 0, 0]]), synthetic(5, [[0, 0, 0]])]);
    expect(seq.timestamps).toEqual([5, 10]);
    expect(() => FlameSequence.fromFrames([synthetic(5, [[0, 0, 0], [1, 0, 0]]), synthetic(5, [[0, 0, 0]])])).toThrow('two frames carry the timestamp 5 s');
    expect(() => FlameSequence.fromFrames([synthetic(5, [])])).toThrow('every frame is empty');
    expect(() => FlameSequence.fromFrames([])).toThrow('no t_<seconds>s.npz frames');
  });

  it('holds a frame until the next timestamp', () => {
    const seq = FlameSequence.fromFrames([synthetic(0, [[0, 0, 0], [1, 0, 0]]), synthetic(5, [[0, 0, 0]]), synthetic(10, [])]);
    expect(seq.frameIndexAt(-1)).toBe(-1);
    expect(seq.frameAt(-1)).toBeNull();
    expect(seq.frameIndexAt(0)).toBe(0);
    expect(seq.frameIndexAt(4.99)).toBe(0);
    expect(seq.frameIndexAt(5)).toBe(1);
    expect(seq.frameIndexAt(7)).toBe(1);
    expect(seq.frameIndexAt(10)).toBe(2);
    expect(seq.frameIndexAt(1e9)).toBe(2);
    expect(seq.frameAt(1e9)!.count).toBe(0);
  });

  it('names a frame that is not on the sequence lattice', () => {
    const good = synthetic(0, [[0, 0, 0], [1, 0, 0]]);
    const bad: RawFrame = { timestamp_s: 5, voxels: new Float64Array([-0.97, -1, 0]), voxelSize_m: good.voxelSize_m };
    expect(() => FlameSequence.fromFrames([good, bad])).toThrow('t_0000005.0s.npz: voxels are not on the sequence lattice');
  });

  it('places a frame box in world space', () => {
    const seq = FlameSequence.fromFrames([synthetic(0, [[2, 3, 4], [3, 3, 4]])]);
    expect(seq.frameOrigin(seq.frames[0]).map((v) => Number(v.toFixed(9)))).toEqual([-0.8, -0.7, 0.4]);
  });
});

describe('the fixture, against Python', () => {
  it('produces the manifest the Python reader wrote', async () => {
    const seq = await fixture();
    expect(seq.manifest('2026-09-19T00:00:00Z')).toEqual(EXPECTED.manifest);
  });

  it('packs to the same bytes', async () => {
    const seq = await fixture();
    const packed = seq.pack();
    expect(packed.length).toBe(EXPECTED.packedBytes);
    expect(sha256(packed)).toBe(EXPECTED.packedSha256);
  });

  it('extracts the same surface cells', async () => {
    const seq = await fixture();
    const hash = createHash('sha256');
    const counts = seq.frames.map((f) => {
      const cells = surfaceCells(f);
      const wide = new Uint16Array(cells.length);
      wide.set(cells);
      hash.update(new Uint8Array(wide.buffer));
      return cells.length / 3;
    });
    expect(counts).toEqual(EXPECTED.surfaceCellCounts);
    expect(hash.digest('hex')).toBe(EXPECTED.surfaceCellsSha256);
  });

  it('round-trips through the packed form and gzip', async () => {
    const seq = await fixture();
    const packed = seq.pack();
    const back = FlameSequence.unpack(packed);
    expect(back.manifest('x')).toEqual(seq.manifest('x'));
    expect(sha256(back.pack())).toBe(EXPECTED.packedSha256);
    const zipped = await gzip(packed);
    expect(zipped.length).toBeLessThan(80_000);
    expect(sha256(await gunzip(zipped))).toBe(EXPECTED.packedSha256);
    expect(() => FlameSequence.unpack(packed.slice(0, 1000))).toThrow('truncated');
    expect(() => FlameSequence.unpack(new Uint8Array([...packed, 0]))).toThrow('trailing');
    expect(() => FlameSequence.unpack(new Uint8Array(100))).toThrow('not a packed flame sequence');
  });
});

describe('the packed form, refusing what pack could not have written', () => {
  // Two occupied cells in a 2x1x1 box; the fields below are what a payload can
  // lie about. Mirror of `test_unpack_refuses_inconsistent_frames` in Python.
  const two = (): FlameSequence => FlameSequence.fromFrames([synthetic(0, [[0, 0, 0], [1, 0, 0]])]);
  const withFrame = (edit: (f: ReturnType<typeof packFrame>) => void): Uint8Array => {
    const seq = two();
    edit(seq.frames[0]);
    return seq.pack();
  };

  it('refuses a frame whose count disagrees with its bits, instead of overrunning the renderer', () => {
    // The renderer sizes its instance buffer from `count` and fills it with the
    // cells actually set; this used to unpack cleanly and throw a RangeError there.
    expect(() => FlameSequence.unpack(withFrame((f) => { f.count = 1; }))).toThrow('declares 1 voxels but holds 2');
    expect(() => FlameSequence.unpack(withFrame((f) => { f.count = 3; }))).toThrow('declares 3 voxels but holds 2');
  });

  it('refuses a box whose bits do not fit it, bits past the last cell, and a box off the lattice', () => {
    expect(() => FlameSequence.unpack(withFrame((f) => { f.dims = [1, 1, 9]; }))).toThrow('holds 1 bytes for a box of 9 cells');
    expect(() => FlameSequence.unpack(withFrame((f) => { f.bits = Uint8Array.from([0b11000001]); }))).toThrow('bits set past its last cell');
    expect(() => FlameSequence.unpack(withFrame((f) => { f.origin = [1, 0, 0]; }))).toThrow('outside the sequence bounds');
    expect(() => FlameSequence.unpack(withFrame((f) => { f.origin = [-1, 0, 0]; }))).toThrow('outside the sequence bounds');
    expect(() => FlameSequence.unpack(withFrame((f) => { f.dims = [0, 0, 0]; f.bits = new Uint8Array(0); }))).toThrow('a box with no cells');
  });

  it('refuses an empty frame that carries a box, and a sequence out of time order', () => {
    const seq = FlameSequence.fromFrames([synthetic(0, [[0, 0, 0], [1, 0, 0]]), synthetic(5, [])]);
    seq.frames[1].dims = [1, 1, 1];
    expect(() => FlameSequence.unpack(seq.pack())).toThrow('is empty but carries a box');
    const backwards = FlameSequence.fromFrames([synthetic(0, [[0, 0, 0], [1, 0, 0]]), synthetic(5, [[0, 0, 1]])]);
    backwards.frames.reverse();
    expect(() => FlameSequence.unpack(backwards.pack())).toThrow('strictly increasing');
    // What pack wrote still reads back.
    expect(FlameSequence.unpack(two().pack()).manifest('x')).toEqual(two().manifest('x'));
  });

  it('refuses bounds that are not on the lattice, so no cell can decode past them', () => {
    // The two centres are at x = -1 and x = -0.9, pitch 0.1. With the maximum x
    // rewritten to -0.94 (the f64 at byte 53) the extent used to round 0.6 up to
    // 1, which admitted the second cell at -0.9: outside the bounds it declared.
    // Mirror of `test_unpack_refuses_bounds_off_the_lattice` in Python.
    const packed = two().pack();
    new DataView(packed.buffer).setFloat64(53, -0.94, true);
    expect(() => FlameSequence.unpack(packed)).toThrow('its bounds are not on its lattice');
    // Float noise the size real frames carry is not a misalignment.
    const noisy = two().pack();
    new DataView(noisy.buffer).setFloat64(53, -0.9 + 1e-9, true);
    expect(FlameSequence.unpack(noisy).bounds[1][0]).toBeCloseTo(-0.9, 8);
  });

  it('refuses a box axis the u16 field cannot hold, at load rather than wrapping it', () => {
    // 65,536 cells on one axis packed to 0 and unpacked to a frame with no surface;
    // the renderer addresses cells in 16 bits too, so the frame is refused as it is
    // read, not only when a page packs it (review 2026-09-22, FLM-7).
    expect(() => FlameSequence.fromFrames([synthetic(0, [[0, 0, 0], [1, 0, 0], [0, 0, 65535]])]))
      .toThrow('spans 65536 cells on one axis; the packed form holds at most 65535');
    const limit = FlameSequence.fromFrames([synthetic(0, [[0, 0, 0], [1, 0, 0], [0, 0, 65534]])]);
    expect(FlameSequence.unpack(limit.pack()).frames[0].dims).toEqual([2, 1, 65535]);
  });
});

// -- review 2026-09-22: mirrored in python/tests/test_flame.py -----------------

describe('review 2026-09-22 frame readers', () => {
  const formatCases = JSON.parse(readFileSync(new URL('../../../fixtures/flame/format-cases.json', import.meta.url), 'utf8')) as
    Array<{ file: string; voxels?: number[][]; voxelSize?: number; error?: string }>;

  for (const c of formatCases) {
    it(`reads ${c.file} as fireplan does (FLM-5)`, async () => {
      const bytes = new Uint8Array(readFileSync(new URL(`../../../fixtures/flame/format-cases/${c.file}`, import.meta.url)));
      const read = parseFrameFile('t_0000000.0s.npz', bytes);
      if (c.error) {
        await expect(read).rejects.toThrow(c.error);
        return;
      }
      const frame = await read;
      expect(Array.from(frame.voxels)).toEqual(c.voxels!.flat());
      expect(frame.voxelSize_m).toBe(c.voxelSize);
    });
  }

  it('does not snap a pitch that would take the data off its lattice (FLM-1)', () => {
    // Codex review of 5f8333d: 0.01 m spacing labelled 0.0099995 m is within the
    // snap, and snapping it left the voxel at 3 m 0.015 cells off. Mirrored in
    // python/tests/test_flame.py.
    const coords = [[0, 0, 0], [0.01, 0, 0], [3, 0, 0]].flat();
    const seq = FlameSequence.fromFrames([{ timestamp_s: 0, voxels: new Float64Array(coords), voxelSize_m: 0.0099995 }]);
    expect(seq.grid.pitch_m).toBe(0.01);
    expect(seq.grid.resolution).toBe(20000);
    expect(seq.frames[0].dims).toEqual([301, 1, 1]);
  });

  it('takes a grid whose pitch is its voxel size, as arange builds it (FLM-1)', () => {
    const coords = [0, 1, 2, 3].flatMap((i) => [i * 0.01, 0, 0]);
    const seq = FlameSequence.fromFrames([{ timestamp_s: 0, voxels: new Float64Array(coords), voxelSize_m: 0.01 }]);
    expect(seq.grid.pitch_m).toBe(0.01);
    expect(seq.grid.resolution).toBeNull();
    expect(voxelSequenceProblem(seq.manifest('2026-09-22T00:00:00Z'))).toBeNull();
  });

  it('names the file a truncated frame came from (FLM-8)', async () => {
    await expect(parseFrameFile('t_0000005.0s.npz', new Uint8Array([1, 2, 3])))
      .rejects.toThrow(/^t_0000005\.0s\.npz: not a ZIP archive/);
  });
});
