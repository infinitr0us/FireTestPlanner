import * as i18n from '../ui/i18n';
/** Structured FDS output. Coordinates and labels come from SMV, never filename guesses.
 * Binary layouts follow FDS 6.9.1 dump.f90 / smvv.f90 (NIST public domain).
 * A reader owns at most one decoded frame; input files remain external. */
import { deviceKind } from './fds-devices';

export type Bounds = [number, number, number, number, number, number];
export type XYZ = [number, number, number];
export interface ResultMesh {
  id: string;
  cells: XYZ;
  bounds: Bounds;
  coordinates: [number[], number[], number[]];
  obstructions: Bounds[];
}
export interface ResultField {
  kind: 'slice' | 'boundary' | 'smoke';
  file: string;
  mesh: number;
  quantity: string;
  shortName: string;
  unit: string;
  cellCentered: boolean;
  bounds?: Bounds;
  extinction?: number;
  plane?: string;
  fireCutoff?: number;
}
export interface ResultDevice {
  id: string;
  quantity: string;
  position: XYZ;
  orientation?: XYZ;
}
export interface ResultCase {
  title: string;
  chid: string;
  version: string;
  meshes: ResultMesh[];
  fields: ResultField[];
  devices: ResultDevice[];
  csv: { kind: string; file: string }[];
  warnings: string[];
  /** Recorded event count, independent of the language of warnings. */
  geometryEvents?: number;
}
export interface ResultSource {
  files: Map<string, number>;
  read(name: string, offset: number, length: number): Promise<Uint8Array>;
  close?(): void;
}
export const MAX_READ = 64 * 1024 * 1024;
const decoder = new TextDecoder();
const numbers = (line: string): number[] => line.trim().split(/\s+/).map(Number);
function fail(message: string): never {
  throw new Error(message);
}
export function safeResultPath(name: string): string {
  // Repeated separators collapse: FDS appends '/' to RESULTS_DIR, so `out\` in an
  // input becomes `out\/x.sf` in the .smv. Mirror of `result_name` in fds_results.py.
  const path = name.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (
    !path ||
    path.startsWith('/') ||
    /[:\x00]/.test(path) ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  ) {
    throw new Error(i18n.t("Unsafe result filename: {p1}", { p1: name }));
  }
  return path;
}
export async function resultText(source: ResultSource, name: string): Promise<string> {
  const size = source.files.get(name);
  if (size === undefined) throw new Error(i18n.t("Missing file: {p1}", { p1: name }));
  if (size > MAX_READ) throw new Error(i18n.t("Text file exceeds 64 MiB: {p1}", { p1: name }));
  return decoder.decode(await source.read(name, 0, size));
}
export function parseSmv(text: string): ResultCase {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const result: ResultCase = {
    title: '',
    chid: '',
    version: '',
    meshes: [],
    fields: [],
    devices: [],
    csv: [],
    warnings: [],
  };
  let mesh: ResultMesh | undefined;
  let geometryEvents = 0;
  let fireCutoff: number | undefined;
  let offset: XYZ = [0, 0, 0];
  const warning = (s: string) => {
    if (!result.warnings.includes(s)) result.warnings.push(s);
  };
  // One output with an unusable path is skipped and named; it used to reject the
  // whole case -- every other field, the devices and the CSVs with it.
  const safePath = (name: string | undefined): string | null => {
    try {
      return safeResultPath(name ?? '');
    } catch {
      warning(i18n.t("Skipped an output whose path cannot be read safely: {p1}", { p1: (name ?? '').trim() }));
      return null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      tag = line.split(/\s+/)[0];
    if (tag === 'TITLE') result.title = lines[++i];
    else if (tag === 'CHID') result.chid = lines[++i];
    else if (tag === 'FDSVERSION') result.version = lines[++i];
    else if (tag === 'HRRPUVCUT') {
      const count = Number(lines[++i]);
      if (count !== 1) fail(i18n.t("Unsupported HRRPUVCUT table."));
      fireCutoff = Number(lines[++i]);
      if (!Number.isFinite(fireCutoff) || fireCutoff < 0) fail(i18n.t("Invalid HRRPUVCUT threshold."));
    } else if (tag === 'OFFSET') offset = numbers(lines[++i]).slice(0, 3) as XYZ;
    else if (tag === 'GRID') {
      const cells = numbers(lines[++i]).slice(0, 3) as XYZ;
      if (cells.length !== 3 || cells.some((n) => !Number.isInteger(n) || n < 1 || n > 100000))
        fail(i18n.t("Invalid mesh dimensions."));
      mesh = {
        id: line.substring(4).trim() || `Mesh ${result.meshes.length + 1}`,
        cells,
        bounds: [0, 0, 0, 0, 0, 0],
        coordinates: [[], [], []],
        obstructions: [],
      };
      result.meshes.push(mesh);
      if (offset.some((n) => n !== 0)) fail(i18n.t("Nonzero SMV mesh OFFSET is not supported yet."));
    } else if (tag === 'PDIM' && mesh) {
      mesh.bounds = numbers(lines[++i]).slice(0, 6) as Bounds;
    } else if (/^TRN[XYZ]$/.test(tag) && mesh) {
      const axis = 'XYZ'.indexOf(tag[3]);
      const transforms = Number(lines[++i]);
      if (!Number.isInteger(transforms) || transforms < 0 || transforms > 100000)
        fail(i18n.t("Invalid mesh transform."));
      i += transforms;
      for (let n = 0; n <= mesh.cells[axis]; n++) {
        const row = numbers(lines[++i] ?? '');
        if (row[0] !== n || !Number.isFinite(row[1])) fail(i18n.t("Invalid mesh coordinate table."));
        mesh.coordinates[axis].push(row[1]);
      }
    } else if (tag === 'OBST' && mesh) {
      const count = Number(lines[++i]);
      if (!Number.isInteger(count) || count < 0 || count > 100000) fail(i18n.t("Invalid obstruction count."));
      // SMV gives both original boxes and the actual grid-snapped boxes. Use the latter.
      i += count;
      for (let n = 0; n < count; n++) {
        const indices = numbers(lines[++i]).slice(0, 6);
        mesh.obstructions.push(indices.map((v, a) => mesh!.coordinates[Math.floor(a / 2)][v]) as Bounds);
      }
    } else if (tag === 'DEVICE') {
      const [id, quantity] = (lines[++i] ?? '').split('%').map((s) => s.trim());
      const row = numbers((lines[++i] ?? '').split('%')[0]);
      const position = row.slice(0, 3) as XYZ;
      const normal = row.slice(3, 6),
        length = Math.hypot(...normal);
      const kind = deviceKind({ id, quantity: quantity ?? '', position });
      const directional = kind === 'surface' || kind === 'flux';
      const orientation =
        directional &&
        normal.length === 3 &&
        normal.every(Number.isFinite) &&
        length > 0 &&
        Number.isFinite(length)
          ? (normal.map((v) => v / length) as XYZ)
          : undefined;
      if (position.length === 3 && position.every(Number.isFinite))
        result.devices.push({ id, quantity: quantity ?? '', position, orientation });
    } else if (tag === 'CSVF') {
      const kind = lines[++i],
        file = safePath(lines[++i]);
      if (file !== null && ['hrr', 'devc'].includes(kind)) result.csv.push({ kind, file });
    } else if (['SLCF', 'SLCC', 'BNDF', 'BNDC', 'SMOKF3D'].includes(tag)) {
      const header = numbers(line.split(/[#!]/)[0].substring(tag.length));
      const file = safePath(lines[++i]),
        quantity = lines[++i],
        shortName = lines[++i],
        unit = lines[++i];
      if (file === null) continue;
      const kind = tag.startsWith('SL') ? 'slice' : tag.startsWith('BN') ? 'boundary' : 'smoke';
      if (kind === 'boundary' && header[1] !== 1) {
        warning(i18n.t("Only version 1 boundary files are supported."));
        continue;
      }
      if (
        (kind === 'slice' && !file.endsWith('.sf')) ||
        (kind === 'boundary' && !file.endsWith('.bf')) ||
        (kind === 'smoke' && !file.endsWith('.s3d'))
      ) {
        warning(i18n.t("Unsupported compressed or alternate output: {p1}", { p1: file }));
        continue;
      }
      const match = line.match(/&\s*([\d\s-]+)(?:!|$)/);
      const bounds = match ? (numbers(match[1]).slice(0, 6) as Bounds) : undefined;
      result.fields.push({
        kind,
        file,
        mesh: header[0] - 1,
        quantity,
        shortName,
        unit,
        cellCentered: tag === 'SLCC' || tag === 'BNDC',
        bounds,
        extinction: header[1],
        plane: line.match(/!\s*(\d+)/)?.[1],
      });
    } else if (/^(ISOF|ISOG|TISOF|TISOG|PRT5|PL3D|GEOM|CGEOM|BNDE|BNDS|SLCFGEOM|SLCT|SMOKG3D|SMOKF3D16)$/.test(tag)) {
      warning(i18n.t("Unsupported output family: {p1}", { p1: tag }));
    } else if (/^(SHOW_OBST|HIDE_OBST|OPEN_VENT|CLOSE_VENT)$/.test(tag)) {
      geometryEvents++;
    }
  }
  if (geometryEvents) {
    result.geometryEvents = geometryEvents;
    warning(
      i18n.t("{p1} geometry events are not animated. Static SMV obstructions and masks are shown at every time; vent state and changing visibility are not reproduced. Use Smokeview for animated geometry.", { p1: geometryEvents })
    );
  }
  for (const field of result.fields) {
    if (field.kind === 'smoke' && field.quantity.trim().toUpperCase() === 'HRRPUV') {
      field.fireCutoff = fireCutoff;
      if (fireCutoff === undefined)
        warning(i18n.t("No HRRPUVCUT threshold recorded; HRRPUV preview shows all nonzero encoded values."));
    }
  }
  if (!result.meshes.length) fail(i18n.t("This file contains no structured FDS meshes."));
  for (const m of result.meshes) {
    if (m.bounds.length !== 6 || m.bounds.some((v) => !Number.isFinite(v))) fail(i18n.t("Invalid mesh bounds."));
    for (let a = 0; a < 3; a++) {
      const c = m.coordinates[a];
      if (c.length !== m.cells[a] + 1 || c.some((v, n) => n > 0 && v <= c[n - 1]))
        fail(i18n.t("Missing or non-increasing mesh coordinates."));
    }
    if (m.obstructions.some((b) => b.length !== 6 || b.some((v) => !Number.isFinite(v))))
      fail(i18n.t("Invalid obstruction coordinates."));
  }
  if (result.fields.some((f) => !result.meshes[f.mesh])) fail(i18n.t("Output references an unknown mesh."));
  return result;
}

/** Checked Fortran sequential records, including unaligned 30-byte label records. */
export class Records {
  offset = 0;
  readonly little: boolean;
  constructor(
    readonly bytes: Uint8Array,
    little?: boolean
  ) {
    if (bytes.byteLength < 4) fail(i18n.t("Truncated Fortran record."));
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
    this.little = little ?? (n === 30 || n === 32);
  }
  next(expected?: number): DataView {
    const b = this.bytes,
      d = new DataView(b.buffer, b.byteOffset, b.byteLength),
      start = this.offset;
    if (start + 8 > b.length) fail(i18n.t("Truncated Fortran record."));
    const n = d.getInt32(start, this.little);
    if (n < 0 || n > MAX_READ || (expected !== undefined && n !== expected) || start + n + 8 > b.length)
      fail(i18n.t("Invalid or truncated Fortran record length."));
    if (d.getInt32(start + 4 + n, this.little) !== n) fail(i18n.t("Fortran record markers disagree."));
    this.offset += n + 8;
    return new DataView(b.buffer, b.byteOffset + start + 4, n);
  }
  ints(count: number): number[] {
    const d = this.next(count * 4);
    return Array.from({ length: count }, (_, i) => d.getInt32(i * 4, this.little));
  }
}
export interface ResultPatch {
  bounds: Bounds;
  orientation: number;
  obstruction: number;
  count: number;
}
export interface ResultFrame {
  time: number;
  values: Float32Array | Uint8Array;
  patches: ResultPatch[];
}
function patch(bounds: Bounds, orientation = 0, obstruction = -1): ResultPatch {
  if (bounds.length !== 6 || bounds.some((n) => !Number.isInteger(n) || n < 0)) fail(i18n.t("Invalid grid indices."));
  let count = 1;
  for (let a = 0; a < 3; a++) {
    const length = bounds[a * 2 + 1] - bounds[a * 2] + 1;
    if (length < 1) fail(i18n.t("Reversed grid indices."));
    count *= length;
  }
  if (!Number.isSafeInteger(count) || count > MAX_READ / 4) fail(i18n.t("Frame exceeds the 64 MiB decoding limit."));
  return { bounds, orientation, obstruction, count };
}
export function decodeRle(bytes: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(count);
  let p = 0;
  for (let i = 0; i < bytes.length; ) {
    let value = bytes[i++],
      repeats = 1;
    if (value === 255) {
      if (i + 2 > bytes.length) fail(i18n.t("Truncated smoke RLE run."));
      value = bytes[i++];
      repeats = bytes[i++];
      if (!repeats || value === 255) fail(i18n.t("Invalid smoke RLE run."));
    }
    if (p + repeats > count) fail(i18n.t("Smoke RLE exceeds the mesh."));
    out.fill(value, p, p + repeats);
    p += repeats;
  }
  if (p !== count) fail(i18n.t("Smoke RLE does not fill the mesh."));
  return out;
}

export class ResultReader {
  patches: ResultPatch[] = [];
  count = 0;
  /** True when the file ends part-way through a frame -- a run stopped mid-write --
   *  and only its complete frames are offered. */
  incomplete = false;
  private start = 0;
  private stride = 0;
  private little = true;
  private smokeOffsets: number[] = [];
  private smokeSizes: number[] = [];
  private times = new Map<number, number>();
  private cached?: { index: number; frame: ResultFrame };
  constructor(
    readonly source: ResultSource,
    readonly field: ResultField,
    readonly mesh: ResultMesh
  ) {}
  async init(): Promise<this> {
    const size = this.source.files.get(this.field.file);
    if (size === undefined) fail(i18n.t("Missing file: {p1}", { p1: this.field.file }));
    const header = new Records(await this.source.read(this.field.file, 0, Math.min(size, 126)));
    this.little = header.little;
    if (this.field.kind === 'smoke') {
      const h = header.ints(8);
      if (h[0] !== 1 || h[1] !== 0) fail(i18n.t("Unsupported Smoke3D encoding."));
      this.patches = [patch(h.slice(2) as Bounds)];
      const szName = this.field.file + '.sz';
      if (!this.source.files.has(szName)) fail(i18n.t("Missing smoke frame index: {p1}", { p1: szName }));
      const rows = (await resultText(this.source, szName)).trim().split(/\r?\n/);
      if (Number(rows.shift()) !== 0) fail(i18n.t("Unsupported smoke frame index format."));
      let pos = 40;
      rows.forEach((line, index) => {
        const row = numbers(line);
        if (
          row.length < 3 ||
          row[1] !== this.patches[0].count ||
          !Number.isInteger(row[2]) ||
          row[2] <= 0 ||
          row[2] > MAX_READ
        )
          fail(i18n.t("Invalid smoke frame index."));
        this.checkTime(index, row[0]);
        this.smokeOffsets.push(pos);
        this.smokeSizes.push(row[2]);
        pos += 36 + row[2];
      });
      // The index can run ahead of the data when a run stopped mid-write: keep the
      // frames the file holds in full. Data past the index is a changed run.
      let complete = rows.length;
      while (complete > 0 && this.smokeOffsets[complete - 1] + 36 + this.smokeSizes[complete - 1] > size) complete -= 1;
      if (complete < rows.length) {
        this.incomplete = true;
        this.smokeOffsets.length = complete;
        this.smokeSizes.length = complete;
        for (let t = complete; t < rows.length; t += 1) this.times.delete(t);
      } else if (pos !== size) fail(i18n.t("Smoke file and .sz index disagree; incomplete or changed run."));
      this.count = complete;
    } else {
      for (const expected of [this.field.quantity, this.field.shortName, this.field.unit]) {
        const r = header.next(30);
        const label = decoder.decode(new Uint8Array(r.buffer, r.byteOffset, r.byteLength)).trim();
        if (label !== expected.slice(0, 30).trim())
          fail(i18n.t("SMV and binary labels disagree in {p1}.", { p1: this.field.file }));
      }
      if (this.field.kind === 'slice') {
        const bytes = await this.source.read(this.field.file, 114, 32);
        this.patches = [patch(new Records(bytes, this.little).ints(6) as Bounds)];
        this.start = 146;
        if (this.patches[0].bounds.filter((v, i, b) => i % 2 === 0 && v === b[i + 1]).length !== 1)
          fail(i18n.t("Only two-dimensional slice files are supported."));
      } else {
        const n = header.ints(1)[0];
        if (n < 1 || n > 100000) fail(i18n.t("Invalid boundary patch count."));
        const records = new Records(await this.source.read(this.field.file, 126, n * 44), this.little);
        for (let i = 0; i < n; i++) {
          const h = records.ints(9);
          if (Math.abs(h[6]) < 1 || Math.abs(h[6]) > 3 || h[8] !== this.field.mesh + 1)
            fail(i18n.t("Invalid boundary face header."));
          const p = patch(h.slice(0, 6) as Bounds, h[6], h[7]);
          const a = Math.abs(h[6]) - 1;
          if (p.bounds[2 * a] !== p.bounds[2 * a + 1]) fail(i18n.t("Boundary face is not planar."));
          this.patches.push(p);
        }
        this.start = 126 + n * 44;
      }
      this.stride = 12 + this.patches.reduce((n, p) => n + p.count * 4 + 8, 0);
      if (this.stride > MAX_READ) fail(i18n.t("Frame exceeds the 64 MiB decoding limit."));
      // A partial last record is a run stopped mid-write, not a corrupt file: the
      // frames before it are whole, and hiding all of them hid the run.
      this.count = Math.floor((size - this.start) / this.stride);
      this.incomplete = (size - this.start) % this.stride !== 0;
    }
    for (const p of this.patches)
      for (let a = 0; a < 3; a++) {
        if (p.bounds[2 * a + 1] > this.mesh.cells[a]) fail(i18n.t("Output indices exceed the associated mesh."));
      }
    if (this.count < 1) fail(i18n.t("No recorded frames: {p1}", { p1: this.field.file }));
    await this.time(0);
    await this.time(this.count - 1);
    return this;
  }
  private checkTime(index: number, time: number): number {
    if (!Number.isFinite(time)) fail(i18n.t("Nonfinite output time."));
    const before = this.times.get(index - 1),
      after = this.times.get(index + 1);
    if ((before !== undefined && time <= before) || (after !== undefined && time >= after))
      fail(i18n.t("Restarted or non-increasing output times are not supported."));
    this.times.set(index, time);
    return time;
  }
  async time(index: number): Promise<number> {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) fail(i18n.t("Frame index out of range."));
    const known = this.times.get(index);
    if (known !== undefined) return known;
    const r = new Records(
      await this.source.read(this.field.file, this.start + index * this.stride, 12),
      this.little
    );
    return this.checkTime(index, r.next(4).getFloat32(0, this.little));
  }
  /** Nearest recorded frame; no extrapolation past a dataset's temporal coverage. */
  async nearest(time: number, hint = 0): Promise<number | null> {
    if (!Number.isFinite(time)) fail(i18n.t("Invalid requested time."));
    if (time < (await this.time(0)) - 1e-4 || time > (await this.time(this.count - 1)) + 1e-4) return null;
    if (hint >= 0 && hint < this.count && Math.abs((await this.time(hint)) - time) < 1e-4) return hint;
    let lo = 0,
      hi = this.count - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await this.time(mid)) < time) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && time - (await this.time(lo - 1)) <= (await this.time(lo)) - time ? lo - 1 : lo;
  }
  async frame(index: number): Promise<ResultFrame> {
    await this.time(index);
    if (this.cached?.index === index) return this.cached.frame;
    const smoke = this.field.kind === 'smoke';
    const r = new Records(
      await this.source.read(
        this.field.file,
        smoke ? this.smokeOffsets[index] : this.start + index * this.stride,
        smoke ? this.smokeSizes[index] + 36 : this.stride
      ),
      this.little
    );
    const time = r.next(4).getFloat32(0, this.little);
    // The .sz index writes seven significant digits, so from 10,000 s its rounding
    // alone exceeds a fixed millisecond; the tolerance scales with the time.
    const indexed = await this.time(index);
    if (Math.abs(time - indexed) > Math.max(1e-3, 1e-6 * Math.abs(indexed))) fail(i18n.t("Frame time disagrees with the index."));
    this.checkTime(index, time);
    let values: Float32Array | Uint8Array;
    if (smoke) {
      const [count, size] = r.ints(2);
      if (count !== this.patches[0].count || size !== this.smokeSizes[index])
        fail(i18n.t("Smoke frame size disagrees with its index."));
      const data = r.next(size);
      values = decodeRle(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), count);
    } else {
      values = new Float32Array(this.patches.reduce((n, p) => n + p.count, 0));
      let offset = 0;
      for (const p of this.patches) {
        const data = r.next(p.count * 4);
        for (let i = 0; i < p.count; i++) values[offset++] = data.getFloat32(i * 4, this.little);
      }
    }
    const frame = { time, values, patches: this.patches };
    this.cached = { index, frame };
    return frame;
  }
  clearFrame(): void {
    this.cached = undefined;
  }
}

export interface ResultSeries {
  name: string;
  unit: string;
  times: number[];
  values: number[];
}
export function parseResultCsv(text: string, warn: (message: string) => void = () => {}): ResultSeries[] {
  const rows = text
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const cells: string[] = [];
      let cell = '',
        quoted = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') {
          if (quoted && line[i + 1] === '"') {
            cell += '"';
            i++;
          } else quoted = !quoted;
        } else if (line[i] === ',' && !quoted) {
          cells.push(cell.trim());
          cell = '';
        } else cell += line[i];
      }
      if (quoted) fail(i18n.t("Unclosed CSV quote."));
      cells.push(cell.trim());
      return cells;
    });
  const units = rows.shift(),
    names = rows.shift();
  if (!units || !names || units.length !== names.length || !/^time$/i.test(names[0]) || units[0] !== 's')
    fail(i18n.t("Expected an FDS CSV with units, column names and Time in seconds."));
  const series = names
    .slice(1)
    .map((name, i) => ({ name, unit: units[i + 1], times: [] as number[], values: [] as number[] }));
  let previous = -Infinity;
  const last = rows[rows.length - 1];
  if (last && rows.length > 0 && (last.length !== names.length || !last[0] || !Number.isFinite(Number(last[0])))) {
    // A run stopped mid-write leaves a half row; every earlier row is whole.
    rows.pop();
    warn(i18n.t("The last row is incomplete (the run stopped mid-write); it was left out."));
  }
  for (const row of rows) {
    if (row.length !== names.length) fail(i18n.t("CSV row width disagrees with its header."));
    const time = Number(row[0]);
    if (!row[0] || !Number.isFinite(time) || time <= previous)
      fail(i18n.t("CSV times must be finite and strictly increasing."));
    previous = time;
    series.forEach((s, i) => {
      s.times.push(time);
      s.values.push(row[i + 1] ? Number(row[i + 1]) : NaN);
    });
  }
  return series;
}
