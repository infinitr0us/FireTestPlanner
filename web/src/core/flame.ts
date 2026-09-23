/**
 * Reconstructed flame sequences: the visual-hull voxel frames a plan links to.
 *
 * The reconstruction pipeline (`fixtures/flame/reconstruct_revised.py`) writes one
 * `t_<seconds>s.npz` per timestep, holding the world coordinates of the occupied
 * voxel centres and the pipeline's `voxel_size`. This module reads those files with
 * no library -- the ZIP container, the browser's own `DecompressionStream`, and the
 * `.npy` header -- infers the lattice they sit on, describes the run as the manifest
 * a plan stores (format 1.4, `linkedFiles[].sequence`), and packs the frames into
 * the compact form the editor renders from and a shared page embeds.
 *
 * Mirror of `python/fireplan/flame.py`; the two are held to identical manifests and
 * identical packed bytes on the fixture. Pure and DOM-free, so it runs in a worker
 * and under vitest alike.
 *
 * The one trap is the lattice pitch. The pipeline builds its grid with an
 * endpoint-inclusive `linspace`, so neighbouring centres are `volume / (res - 1)`
 * apart while its `voxel_size` is `volume / res` -- half a percent less. Indexing
 * voxels by `voxel_size` is off by one a hundred voxels out, so the pitch is
 * inferred from the coordinates and `voxel_size` is carried along as what the
 * pipeline said.
 */

import { voxelSequenceProblem } from './linked-files';
import type { VoxelSequenceManifest } from './types';

export const FRAME_NAME = /^t_(\d+(?:\.\d+)?)s\.npz$/;

/** A frame whose coordinates land further than this fraction of a pitch from a
 *  lattice point is not on the sequence's grid. Real frames land within 1e-9. */
const LATTICE_TOLERANCE = 0.01;

const PACK_MAGIC = [0x46, 0x54, 0x50, 0x56]; // 'FTPV'
const PACK_VERSION = 1;
/** f64 timestamp, u32 count, i32[3] origin, u16[3] dims, u32 byte length. */
const FRAME_HEADER_BYTES = 8 + 4 + 12 + 6 + 4;
/** A frame box axis is a u16 in the packed form; a longer one has no representation. */
export const MAX_FRAME_DIM = 0xffff;

// -- .npz / .npy -----------------------------------------------------------

export interface NpyArray {
  dtype: string;
  shape: number[];
  fortranOrder: boolean;
  /** The raw little-endian payload, copied so it is aligned for typed-array views. */
  data: Uint8Array;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The entries of a ZIP archive, by name.
 *
 * Read from the central directory at the end of the file, not by walking local
 * headers from the front: a writer that streamed the archive leaves the sizes out
 * of the local headers and fills them into the directory instead. numpy's writer
 * seeks back and fills both, but the directory is right either way.
 */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const entries = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`corrupt ZIP local header for ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressed);
    if (method === 0) entries.set(name, raw);
    else if (method === 8) entries.set(name, await inflateRaw(raw));
    else throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}`);
  }
  return entries;
}

/** The `.npy` container: magic, a Python-literal header, then the raw array. */
export function parseNpy(bytes: Uint8Array): NpyArray {
  if (bytes.length < 10 || bytes[0] !== 0x93 || new TextDecoder().decode(bytes.subarray(1, 6)) !== 'NUMPY') {
    throw new Error('not a .npy array');
  }
  const major = bytes[6];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength));
  const dtype = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!dtype || !fortran || shapeText === undefined) throw new Error('unreadable .npy header');
  const shape = shapeText.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const data = bytes.slice(headerStart + headerLength);
  return { dtype, shape, fortranOrder: fortran === 'True', data };
}

export interface RawFrame {
  timestamp_s: number;
  /** Flat `x0 y0 z0 x1 y1 z1 …`, world metres. */
  voxels: Float64Array;
  voxelSize_m: number;
  /** The file the frame came from, for messages; absent for a synthesised frame. */
  name?: string;
}

/**
 * The numeric dtypes a frame may use: float or integer, 4 or 8 bytes, either byte
 * order. Python's `np.load` reads all of these, so a frame written with
 * `np.array(..., dtype='>f8')` or integer centres is one both engines read -- and
 * `fireplan` refuses what is outside this set, so neither engine accepts a frame the
 * other cannot (review 2026-09-22, FLM-5). Mirror of `_FRAME_DTYPES` in flame.py.
 */
const DTYPE_READERS: Record<string, (view: DataView, i: number) => number> = {
  '<f8': (v, i) => v.getFloat64(i * 8, true), '>f8': (v, i) => v.getFloat64(i * 8, false),
  '<f4': (v, i) => v.getFloat32(i * 4, true), '>f4': (v, i) => v.getFloat32(i * 4, false),
  '<i8': (v, i) => Number(v.getBigInt64(i * 8, true)), '>i8': (v, i) => Number(v.getBigInt64(i * 8, false)),
  '<i4': (v, i) => v.getInt32(i * 4, true), '>i4': (v, i) => v.getInt32(i * 4, false),
};

const readFloats = (array: NpyArray, what: string): Float64Array => {
  const view = new DataView(array.data.buffer, array.data.byteOffset, array.data.byteLength);
  const n = array.shape.reduce((a, b) => a * b, 1);
  const read = DTYPE_READERS[array.dtype];
  if (!read) throw new Error(`${what} has dtype ${array.dtype}; expected a 4- or 8-byte float or integer`);
  const width = Number(array.dtype.slice(2));
  if (array.data.byteLength < n * width) throw new Error(`${what} is shorter than its shape says`);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = read(view, i);
  return out;
};

/** The timestamp a frame file name carries, or null for any other file. */
export function frameTimestamp(name: string): number | null {
  const m = FRAME_NAME.exec(name.split(/[\\/]/).pop() ?? '');
  return m ? Number(m[1]) : null;
}

/** One `t_<seconds>s.npz` file, as the pipeline wrote it. */
export async function parseFrameFile(name: string, bytes: Uint8Array): Promise<RawFrame> {
  const timestamp = frameTimestamp(name);
  if (timestamp === null) throw new Error(`${name}: not named t_<seconds>s.npz`);
  let entries: Map<string, Uint8Array>;
  try {
    entries = await readZip(bytes);
  } catch (err) {
    // A truncated or foreign file said "not a ZIP archive" with no name attached,
    // in a folder of eighty of them.
    throw new Error(`${name}: ${(err as Error).message}`);
  }
  const voxelsEntry = entries.get('voxels.npy');
  const sizeEntry = entries.get('voxel_size.npy');
  if (!voxelsEntry || !sizeEntry) throw new Error(`${name}: not a reconstruction frame (needs voxels and voxel_size)`);
  const voxelsArray = parseNpy(voxelsEntry);
  if (voxelsArray.shape.length !== 2 || voxelsArray.shape[1] !== 3) {
    throw new Error(`${name}: voxels must be an (M, 3) array, got shape (${voxelsArray.shape.join(', ')})`);
  }
  let voxels = readFloats(voxelsArray, `${name}: voxels`);
  if (voxelsArray.fortranOrder) {
    // Column-major: all the x, then all the y, then all the z. `np.array([x, y, z]).T`
    // saves exactly this, and it is the same array.
    const m = voxelsArray.shape[0];
    const rows = new Float64Array(voxels.length);
    for (let i = 0; i < m; i += 1) for (let a = 0; a < 3; a += 1) rows[i * 3 + a] = voxels[a * m + i];
    voxels = rows;
  }
  for (let i = 0; i < voxels.length; i += 1) {
    if (!Number.isFinite(voxels[i])) throw new Error(`${name}: voxel coordinates must be finite`);
  }
  const size = readFloats(parseNpy(sizeEntry), `${name}: voxel_size`);
  if (size.length !== 1 || !(size[0] > 0) || !Number.isFinite(size[0])) {
    throw new Error(`${name}: voxel_size must be a positive number`);
  }
  return { timestamp_s: timestamp, voxels, voxelSize_m: size[0], name };
}

// -- lattice ----------------------------------------------------------------

/**
 * The lattice pitch: the smallest gap between distinct x coordinates.
 *
 * Taken from the frame with the most voxels, which is certain to hold two
 * neighbours; a 16-voxel frame might not. Gaps under a nanometre are float noise
 * between values that are the same lattice line, not a pitch.
 */
export function inferPitch(voxels: Float64Array): number {
  const xs = new Float64Array(voxels.length / 3);
  for (let i = 0; i < xs.length; i += 1) xs[i] = voxels[i * 3];
  xs.sort();
  let pitch = Infinity;
  for (let i = 1; i < xs.length; i += 1) {
    const gap = xs[i] - xs[i - 1];
    if (gap > 1e-9 && gap < pitch) pitch = gap;
  }
  if (!Number.isFinite(pitch)) throw new Error('cannot infer the lattice pitch: no two voxels share a row');
  return pitch;
}

/** Voxels per axis of the pipeline's full grid, from the linspace identity
 *  `pitch = volume / (res - 1)`, `voxel_size = volume / res`. Null when the two are
 *  equal, which is a grid built some other way. */
/** How close an inferred pitch has to be to the voxel size to BE the voxel size:
 *  a grid built with `arange` has pitch = voxel_size, and the smallest float gap
 *  lands a few ulps below it (float32 coordinates, further). A linspace grid's pitch
 *  is a whole 1/(res-1) above, half a percent at 192. Mirror of flame.py. */
export const PITCH_SNAP = 1e-4;

/** The pitch, snapped to the voxel size when the two are the same grid spacing. */
export const snapPitch = (pitch: number, voxelSize: number): number =>
  Math.abs(pitch - voxelSize) <= PITCH_SNAP * voxelSize ? voxelSize : pitch;

export function inferResolution(pitch: number, voxelSize: number): number | null {
  const gap = pitch - voxelSize;
  if (gap <= 1e-9 * pitch) return null;
  return Math.round(pitch / gap);
}

// -- frames -------------------------------------------------------------------

/**
 * One packed frame: a bounding box on the lattice and a bit per cell.
 *
 * `bits` is numpy `packbits` order (most significant bit first) over cells
 * flattened as `((i * ny) + j) * nz + k`, with `i, j, k` relative to `origin`.
 */
export interface PackedFrame {
  timestamp_s: number;
  count: number;
  origin: [number, number, number];
  dims: [number, number, number];
  bits: Uint8Array;
}

export function packFrame(timestamp_s: number, voxels: Float64Array, originM: ArrayLike<number>, pitch: number): PackedFrame {
  const n = voxels.length / 3;
  if (n === 0) return { timestamp_s, count: 0, origin: [0, 0, 0], dims: [0, 0, 0], bits: new Uint8Array(0) };
  const idx = new Int32Array(n * 3);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i += 1) {
    const scaled = (voxels[i] - originM[i % 3]) / pitch;
    const k = Math.round(scaled);
    if (Math.abs(scaled - k) > LATTICE_TOLERANCE) throw new Error('voxels are not on the sequence lattice');
    if (k < 0) throw new Error('voxels lie before the lattice origin');
    idx[i] = k;
    const axis = i % 3;
    if (k < lo[axis]) lo[axis] = k;
    if (k > hi[axis]) hi[axis] = k;
  }
  const dims: [number, number, number] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  // Refused here, where every frame is built, not only when packing for a page:
  // the renderer addresses cells in 16 bits, and a longer axis drew its far cubes
  // at wrapped positions metres from where they are. Same sentence as `pack`.
  if (dims.some((d) => d > MAX_FRAME_DIM)) {
    throw new Error(`frame at ${timestamp_s} s spans ${Math.max(dims[0], dims[1], dims[2])} cells on one axis; the packed form holds at most ${MAX_FRAME_DIM}`);
  }
  const cells = dims[0] * dims[1] * dims[2];
  const bits = new Uint8Array(Math.ceil(cells / 8));
  let count = 0;
  for (let i = 0; i < n; i += 1) {
    const flat = ((idx[i * 3] - lo[0]) * dims[1] + (idx[i * 3 + 1] - lo[1])) * dims[2] + (idx[i * 3 + 2] - lo[2]);
    const byte = flat >> 3, mask = 0x80 >> (flat & 7);
    if (!(bits[byte] & mask)) { bits[byte] |= mask; count += 1; }
  }
  if (count !== n) throw new Error(`frame at ${timestamp_s} s holds ${n - count} duplicate voxel(s)`);
  return { timestamp_s, count, origin: [lo[0], lo[1], lo[2]], dims, bits };
}

const isSet = (frame: PackedFrame, flat: number): boolean => (frame.bits[flat >> 3] & (0x80 >> (flat & 7))) !== 0;

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, b) => {
  let n = 0;
  for (let v = b; v; v >>= 1) n += v & 1;
  return n;
});

/**
 * Why a packed frame is not one `packFrame` could have produced, or null.
 *
 * The renderer sizes its instance buffer from `count` and fills it with the cells
 * actually set, and the surface walk trusts `dims` to address `bits`: a frame that
 * claims one and holds the other overruns a buffer instead of drawing. `extent` is
 * the sequence lattice's last index per axis, which every box has to fit inside.
 * Mirror of `frame_problem` in flame.py.
 */
export function frameProblem(frame: PackedFrame, extent: ArrayLike<number>): string | null {
  const { count, origin, dims, bits } = frame;
  if (!Number.isFinite(frame.timestamp_s)) return 'has a non-finite timestamp';
  if (count === 0) {
    return dims.some((d) => d !== 0) || origin.some((o) => o !== 0) || bits.length !== 0 ? 'is empty but carries a box' : null;
  }
  if (dims.some((d) => d <= 0)) return `declares ${count} voxels in a box with no cells`;
  const cells = dims[0] * dims[1] * dims[2];
  if (bits.length !== Math.ceil(cells / 8)) return `holds ${bits.length} bytes for a box of ${cells} cells`;
  const padding = bits.length * 8 - cells;
  if (padding && (bits[bits.length - 1] & ((1 << padding) - 1))) return 'has bits set past its last cell';
  let set = 0;
  for (let i = 0; i < bits.length; i += 1) set += POPCOUNT[bits[i]];
  if (set !== count) return `declares ${count} voxels but holds ${set}`;
  for (let a = 0; a < 3; a += 1) {
    if (origin[a] < 0 || origin[a] + dims[a] - 1 > extent[a]) return 'has a box outside the sequence bounds';
  }
  return null;
}

/**
 * Box-local `(i, j, k)` of every cell with an empty 6-neighbour, in flat order --
 * the cubes the editor draws. The box boundary counts as empty. `Uint8Array` when
 * every box axis fits, `Uint16Array` otherwise; either is the instance attribute
 * as-is.
 */
export function surfaceCells(frame: PackedFrame): Uint8Array | Uint16Array {
  const [nx, ny, nz] = frame.dims;
  const out: number[] = [];
  for (let i = 0; i < nx; i += 1) for (let j = 0; j < ny; j += 1) for (let k = 0; k < nz; k += 1) {
    const flat = (i * ny + j) * nz + k;
    if (!isSet(frame, flat)) continue;
    const enclosed = i > 0 && i < nx - 1 && j > 0 && j < ny - 1 && k > 0 && k < nz - 1
      && isSet(frame, flat - ny * nz) && isSet(frame, flat + ny * nz)
      && isSet(frame, flat - nz) && isSet(frame, flat + nz)
      && isSet(frame, flat - 1) && isSet(frame, flat + 1);
    if (!enclosed) out.push(i, j, k);
  }
  return Math.max(nx, ny, nz) <= 256 ? Uint8Array.from(out) : Uint16Array.from(out);
}

// -- the sequence ---------------------------------------------------------------

export interface FlameGrid {
  voxelSize_m: number;
  pitch_m: number;
  resolution: number | null;
}

export class FlameSequence {
  constructor(
    readonly grid: FlameGrid,
    /** Min and max voxel centre over the sequence; the min is also the lattice origin. */
    readonly bounds: [[number, number, number], [number, number, number]],
    readonly frames: PackedFrame[],
  ) {}

  /** Build from the pipeline's files. Frames may arrive in any order. */
  static fromFrames(raw: RawFrame[]): FlameSequence {
    if (!raw.length) throw new Error('no t_<seconds>s.npz frames');
    const sorted = [...raw].sort((a, b) => a.timestamp_s - b.timestamp_s);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].timestamp_s === sorted[i - 1].timestamp_s) throw new Error(`two frames carry the timestamp ${sorted[i].timestamp_s} s`);
    }
    const sizes = new Set(sorted.map((f) => f.voxelSize_m));
    if (sizes.size !== 1) throw new Error(`frames disagree about voxel_size: ${[...sizes].sort().join(', ')}`);
    const voxelSize = sorted[0].voxelSize_m;
    const populated = sorted.filter((f) => f.voxels.length);
    if (!populated.length) throw new Error('every frame is empty; nothing to reconstruct a grid from');
    const fullest = populated.reduce((a, b) => (b.voxels.length > a.voxels.length ? b : a));
    const pitch = snapPitch(inferPitch(fullest.voxels), voxelSize);
    const lo: [number, number, number] = [Infinity, Infinity, Infinity];
    const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const f of populated) {
      for (let i = 0; i < f.voxels.length; i += 1) {
        const axis = i % 3;
        if (f.voxels[i] < lo[axis]) lo[axis] = f.voxels[i];
        if (f.voxels[i] > hi[axis]) hi[axis] = f.voxels[i];
      }
    }
    const frames = sorted.map((f) => {
      try { return packFrame(f.timestamp_s, f.voxels, lo, pitch); }
      catch (err) {
        // The file's own name: a name rebuilt from the timestamp rounded 5.25 one way
        // here and the other way in Python, naming a file that does not exist.
        throw new Error(`${f.name ?? `t_${f.timestamp_s.toFixed(1).padStart(9, '0')}s.npz`}: ${(err as Error).message}`);
      }
    });
    return new FlameSequence({ voxelSize_m: voxelSize, pitch_m: pitch, resolution: inferResolution(pitch, voxelSize) }, [lo, hi], frames);
  }

  get timestamps(): number[] { return this.frames.map((f) => f.timestamp_s); }

  /** Index of the frame showing at `time_s`: the last one at or before it. A frame
   *  holds until the next; before the first there is nothing (-1). */
  frameIndexAt(time_s: number): number {
    let lo = 0, hi = this.frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.frames[mid].timestamp_s <= time_s) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
  }

  frameAt(time_s: number): PackedFrame | null {
    const i = this.frameIndexAt(time_s);
    return i >= 0 ? this.frames[i] : null;
  }

  /** World coordinates of a frame's box corner: the centre of its first cell. */
  frameOrigin(frame: PackedFrame): [number, number, number] {
    return [0, 1, 2].map((a) => this.bounds[0][a] + frame.origin[a] * this.grid.pitch_m) as [number, number, number];
  }

  /** The `sequence` block a plan stores. Recorded data: full precision. */
  manifest(importedAt = new Date().toISOString()): VoxelSequenceManifest {
    return {
      importedAt,
      grid: { ...this.grid },
      bounds_m: [[...this.bounds[0]], [...this.bounds[1]]],
      frames: this.frames.map((f) => [f.timestamp_s, f.count]),
    };
  }

  // -- packed form ---------------------------------------------------------------

  /**
   * The compact, lossless form a shared page embeds.
   *
   * Little-endian binary rather than JSON, so both engines produce the same bytes
   * without agreeing on how to spell a float:
   *
   *     'FTPV' u8 version u32 frames
   *     f64 voxelSize f64 pitch i32 resolution (-1 = unknown) f64[6] bounds
   *     per frame: f64 timestamp u32 count i32[3] origin u16[3] dims u32 nbytes bytes
   */
  pack(): Uint8Array {
    // Refused rather than truncated: `setUint16` would silently wrap a longer
    // axis, and Python's struct writer refuses it, so the two would disagree.
    for (const f of this.frames) {
      if (f.dims.some((d) => d > MAX_FRAME_DIM)) {
        throw new Error(`frame at ${f.timestamp_s} s spans ${Math.max(...f.dims)} cells on one axis; the packed form holds at most ${MAX_FRAME_DIM}`);
      }
    }
    const total = 4 + 5 + 20 + 48 + this.frames.reduce((n, f) => n + FRAME_HEADER_BYTES + f.bits.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    out.set(PACK_MAGIC, 0);
    view.setUint8(4, PACK_VERSION);
    view.setUint32(5, this.frames.length, true);
    view.setFloat64(9, this.grid.voxelSize_m, true);
    view.setFloat64(17, this.grid.pitch_m, true);
    view.setInt32(25, this.grid.resolution ?? -1, true);
    for (let a = 0; a < 3; a += 1) {
      view.setFloat64(29 + a * 8, this.bounds[0][a], true);
      view.setFloat64(53 + a * 8, this.bounds[1][a], true);
    }
    let offset = 77;
    for (const f of this.frames) {
      view.setFloat64(offset, f.timestamp_s, true);
      view.setUint32(offset + 8, f.count, true);
      for (let a = 0; a < 3; a += 1) view.setInt32(offset + 12 + a * 4, f.origin[a], true);
      for (let a = 0; a < 3; a += 1) view.setUint16(offset + 24 + a * 2, f.dims[a], true);
      view.setUint32(offset + 30, f.bits.length, true);
      offset += FRAME_HEADER_BYTES;
      out.set(f.bits, offset);
      offset += f.bits.length;
    }
    return out;
  }

  /**
   * Read the packed form back, refusing anything `pack` could not have written.
   *
   * The container is checked as it is walked; then the manifest rules -- grid,
   * bounds, 1–20,000 frames in strictly increasing time -- and each frame's own
   * consistency, so a payload that lies about its cells is refused here rather
   * than overrunning the instance buffer in the renderer.
   */
  static unpack(data: Uint8Array): FlameSequence {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 77 || PACK_MAGIC.some((b, i) => data[i] !== b)) throw new Error('not a packed flame sequence');
    if (view.getUint8(4) !== PACK_VERSION) throw new Error(`packed flame sequence version ${view.getUint8(4)} is not supported`);
    const count = view.getUint32(5, true);
    const resolution = view.getInt32(25, true);
    const grid: FlameGrid = { voxelSize_m: view.getFloat64(9, true), pitch_m: view.getFloat64(17, true), resolution: resolution < 0 ? null : resolution };
    const corner = (at: number): [number, number, number] => [view.getFloat64(at, true), view.getFloat64(at + 8, true), view.getFloat64(at + 16, true)];
    const bounds: [[number, number, number], [number, number, number]] = [corner(29), corner(53)];
    const frames: PackedFrame[] = [];
    let offset = 77;
    for (let n = 0; n < count; n += 1) {
      if (offset + FRAME_HEADER_BYTES > data.length) throw new Error('packed flame sequence is truncated');
      const nbytes = view.getUint32(offset + 30, true);
      const frame: PackedFrame = {
        timestamp_s: view.getFloat64(offset, true),
        count: view.getUint32(offset + 8, true),
        origin: [view.getInt32(offset + 12, true), view.getInt32(offset + 16, true), view.getInt32(offset + 20, true)],
        dims: [view.getUint16(offset + 24, true), view.getUint16(offset + 26, true), view.getUint16(offset + 28, true)],
        bits: data.slice(offset + FRAME_HEADER_BYTES, offset + FRAME_HEADER_BYTES + nbytes),
      };
      if (frame.bits.length !== nbytes) throw new Error('packed flame sequence is truncated');
      frames.push(frame);
      offset += FRAME_HEADER_BYTES + nbytes;
    }
    if (offset !== data.length) throw new Error(`packed flame sequence has ${data.length - offset} trailing byte(s)`);
    const sequence = new FlameSequence(grid, bounds, frames);
    const problem = voxelSequenceProblem(sequence.manifest('packed'));
    if (problem) throw new Error(`packed flame sequence is inconsistent: ${problem}`);
    // The bounds are voxel centres, so they sit a whole number of pitches apart;
    // rounding a maximum that does not would admit a box whose last cell decodes
    // past it. Real bounds land within 1e-9 of a lattice point, like the frames.
    const extent = [0, 1, 2].map((a) => {
      const cells = (bounds[1][a] - bounds[0][a]) / grid.pitch_m;
      if (Math.abs(cells - Math.round(cells)) > LATTICE_TOLERANCE) throw new Error('packed flame sequence is inconsistent: its bounds are not on its lattice');
      return Math.round(cells);
    });
    for (const frame of frames) {
      const bad = frameProblem(frame, extent);
      if (bad) throw new Error(`packed flame sequence is inconsistent: the frame at ${frame.timestamp_s} s ${bad}`);
    }
    return sequence;
  }
}

/** gzip for transport and embedding; the packed bytes themselves stay canonical. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
