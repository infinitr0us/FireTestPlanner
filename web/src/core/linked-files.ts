import type { LinkedFileKind, PlanObject, ReconstructionPlot, VoxelSequenceManifest } from './types';
import { isKnownType } from './types';

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_PLOT_SAMPLES = 20_000;
/** Also the cap on a voxel sequence's frames: the manifest is one row per frame. */
export const MAX_SEQUENCE_FRAMES = 20_000;
export const LINK_TYPES = ['burner', 'camera', 'heatFluxSensor', 'thermocouple', 'reconstructedFlame'];
/** The one kind of file each linking type accepts. A flame links a folder of frames. */
export const linkKindFor = (type: string): LinkedFileKind =>
  type === 'camera' ? 'video' : type === 'reconstructedFlame' ? 'voxelSequence' : 'spreadsheet';
/** A flame has one data source; the others collect runs and recordings. */
export const maxLinksFor = (type: string): number => (type === 'reconstructedFlame' ? 1 : 100);
export const SPREADSHEET_EXTENSIONS = ['csv', 'tsv', 'xlsx', 'xls', 'ods'];
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'mpg', 'mpeg', 'mts', 'm2ts'];
export const canLinkFiles = (obj: PlanObject): boolean => LINK_TYPES.includes(obj.type);
export const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;
export const extension = (path: string): string => fileName(path).split('.').pop()?.toLowerCase() ?? '';
export const isLocalPath = (path: string): boolean =>
  path.trim().length > 0 && !/[\x00-\x1f]/.test(path)
  && !/^[a-z][a-z0-9+.-]*:/i.test(path.replace(/^[a-z]:[/\\]/i, ''));
/**
 * A path Windows reaches through the network or the device namespace: UNC
 * (`\\server\share`, `//server/share`, WebDAV's `\\host@SSL\…`) or `\\?\` / `\\.\`.
 * Merely resolving one contacts that host and offers it the user's credentials, so
 * nothing a plan names that way is touched without a click.
 */
export const isNetworkPath = (path: string): boolean => /^[\\/]{2}/.test(path.trim());

/** Small strict CSV/TSV reader: quoted delimiters, escaped quotes, CRLF and BOM. */
function rows(text: string, separator: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  const pushCell = (): void => { row.push(cell.trim()); cell = ''; closed = false; };
  const pushRow = (): void => {
    pushCell();
    if (row.some((x) => x !== '')) result.push(row);
    row = [];
    if (result.length > MAX_PLOT_SAMPLES + 1) throw new Error(`CSV exceeds ${MAX_PLOT_SAMPLES.toLocaleString()} samples.`);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += ch;
    } else if (ch === separator) pushCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else if (ch === '"' && !cell.trim() && !closed) { cell = ''; quoted = true; }
    else if (ch === '"' || (closed && ch.trim())) throw new Error('Malformed CSV quoting.');
    else cell += ch;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  if (cell || row.length || closed) pushRow();
  return result;
}

/** Refuse bad rows rather than connecting across silently dropped measurements. */
export function parseReconstructionCsv(text: string, importedAt = new Date().toISOString()): ReconstructionPlot {
  if (new TextEncoder().encode(text).byteLength > MAX_CSV_BYTES) throw new Error('CSV exceeds the 5 MiB plot limit.');
  text = text.replace(/^\uFEFF/, '');
  const headerLine = text.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const separator = headerLine.includes('\t') ? '\t' : headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
  const table = rows(text, separator);
  const headers = table.shift()?.map((x) => x.toLowerCase()) ?? [];
  const required = ['timestamp_s', 'volume_m3', 'surface_area_m2'];
  const indices = required.map((name) => {
    if (headers.filter((h) => h === name).length !== 1) throw new Error(`CSV needs exactly one "${name}" column.`);
    return headers.indexOf(name);
  });
  if (!table.length) throw new Error('CSV contains no measurements.');
  let previous = -Infinity;
  const samples = table.map((row, index): [number, number, number] => {
    if (row.length !== headers.length) throw new Error(`CSV row ${index + 2} has ${row.length} fields; expected ${headers.length}.`);
    const values = indices.map((column, i) => {
      const cell = row[column];
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cell)) {
        throw new Error(`CSV row ${index + 2}: ${required[i]} is not a number.`);
      }
      const value = Number(cell);
      if (!Number.isFinite(value) || (i > 0 && value < 0)) throw new Error(`CSV row ${index + 2}: ${required[i]} must be finite${i > 0 ? ' and non-negative' : ''}.`);
      return value;
    }) as [number, number, number];
    if (values[0] <= previous) throw new Error(`CSV row ${index + 2}: timestamps must increase strictly.`);
    previous = values[0];
    return values;
  });
  return { importedAt, samples };
}

const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Shape and order checks a manifest needs beyond the schema: strictly increasing
 * times, integer counts, a box whose minimum is its minimum, a pitch that is at
 * least the voxel size (the grid is endpoint-inclusive, so it cannot be smaller).
 */
export function voxelSequenceProblem(sequence: VoxelSequenceManifest): string | null {
  if (!sequence || typeof sequence !== 'object' || typeof sequence.importedAt !== 'string' || !sequence.importedAt) return 'A voxel sequence needs an import date.';
  if (Object.keys(sequence).some((key) => !['importedAt', 'grid', 'bounds_m', 'frames'].includes(key))) return 'Voxel sequences contain an unsupported field.';
  const grid = sequence.grid;
  if (!grid || typeof grid !== 'object' || Object.keys(grid).some((key) => !['voxelSize_m', 'pitch_m', 'resolution'].includes(key))) return 'A voxel sequence needs a grid with voxelSize_m, pitch_m and resolution.';
  const positive = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x) && x > 0;
  // Within the snap tolerance of the readers (`PITCH_SNAP` in core/flame.ts): a grid
  // whose pitch IS its voxel size, inferred a few ulps short, used to be refused.
  if (!positive(grid.voxelSize_m) || !positive(grid.pitch_m) || grid.pitch_m < grid.voxelSize_m * (1 - 1e-4)) return 'A voxel sequence needs a positive voxel size and a pitch no smaller than it.';
  if (grid.resolution !== null && (!Number.isInteger(grid.resolution) || grid.resolution < 2)) return 'A voxel sequence needs an integer grid resolution of at least 2, or null.';
  const bounds = sequence.bounds_m;
  if (!Array.isArray(bounds) || bounds.length !== 2 || !isVec3(bounds[0]) || !isVec3(bounds[1]) || bounds[0].some((lo, i) => lo > bounds[1][i])) return 'A voxel sequence needs finite bounds with the minimum corner first.';
  const frames = sequence.frames;
  if (!Array.isArray(frames) || !frames.length || frames.length > MAX_SEQUENCE_FRAMES) return 'A voxel sequence needs 1–20,000 frames.';
  let previous = -Infinity;
  for (const frame of frames) {
    if (!Array.isArray(frame) || frame.length !== 2 || typeof frame[0] !== 'number' || !Number.isFinite(frame[0]) || frame[0] <= previous || !Number.isInteger(frame[1]) || frame[1] < 0) return 'Voxel sequence frames need strictly increasing finite times and non-negative integer voxel counts.';
    previous = frame[0];
  }
  return null;
}

/** Validation shared by load and tests; schema checks the same shape in Python. */
export function linkedFilesProblem(obj: PlanObject): string | null {
  if (!isKnownType(obj.type)) return null;
  if (obj.linkedFiles === undefined) return null;
  if (!canLinkFiles(obj)) return 'This object type does not support linked files.';
  const maxLinks = maxLinksFor(obj.type);
  if (!Array.isArray(obj.linkedFiles) || obj.linkedFiles.length > maxLinks) {
    return maxLinks === 1 ? 'A reconstructed flame links one voxel sequence.' : 'linkedFiles must be an array of at most 100 files.';
  }
  const ids = new Set<string>();
  for (const link of obj.linkedFiles) {
    if (!link || typeof link !== 'object' || typeof link.id !== 'string' || !link.id || ids.has(link.id)) return 'Linked file IDs must be non-empty and unique within their object.';
    ids.add(link.id);
    if (Object.keys(link).some((key) => !['id', 'kind', 'path', 'label', 'timeOffset_s', 'plot', 'sequence'].includes(key))) return 'Linked files contain an unsupported field.';
    if (typeof link.path !== 'string' || !isLocalPath(link.path)) return 'Linked files need a local file path, not a URL.';
    if (link.kind !== linkKindFor(obj.type)) return 'Cameras link videos; burners and sensors link spreadsheets; a reconstructed flame links a voxel sequence.';
    if (link.label !== undefined && typeof link.label !== 'string') return 'Linked file labels must be text.';
    if (link.timeOffset_s !== undefined && (typeof link.timeOffset_s !== 'number' || !Number.isFinite(link.timeOffset_s))) return 'A linked file time offset must be a finite number of seconds.';
    if (link.sequence !== undefined) {
      if (obj.type !== 'reconstructedFlame') return 'Only a reconstructed flame link can hold a voxel sequence.';
      const problem = voxelSequenceProblem(link.sequence);
      if (problem) return problem;
    }
    if (link.plot !== undefined) {
      if (obj.type !== 'burner' || !link.plot || typeof link.plot.importedAt !== 'string' || !link.plot.importedAt) return 'Only burner spreadsheets can hold reconstruction plots, with an import date.';
      if (Object.keys(link.plot).some((key) => !['importedAt', 'samples'].includes(key))) return 'Reconstruction plots contain an unsupported field.';
      const samples = link.plot.samples;
      if (!Array.isArray(samples) || !samples.length || samples.length > MAX_PLOT_SAMPLES) return 'A plot needs 1–20,000 samples.';
      let previous = -Infinity;
      for (const sample of samples) {
        if (!Array.isArray(sample) || sample.length !== 3 || !sample.every((x, i) => typeof x === 'number' && Number.isFinite(x) && (i === 0 || x >= 0)) || sample[0] <= previous) return 'Plot samples need strictly increasing finite times and finite, non-negative volume and area.';
        previous = sample[0];
      }
    }
  }
  return null;
}
