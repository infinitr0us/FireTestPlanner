import type { PlanObject, ReconstructionPlot } from './types';
import { isKnownType } from './types';

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_PLOT_SAMPLES = 20_000;
export const LINK_TYPES = ['burner', 'camera', 'heatFluxSensor', 'thermocouple'];
export const SPREADSHEET_EXTENSIONS = ['csv', 'tsv', 'xlsx', 'xls', 'ods'];
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'wmv', 'webm', 'mpg', 'mpeg', 'mts', 'm2ts'];
export const canLinkFiles = (obj: PlanObject): boolean => LINK_TYPES.includes(obj.type);
export const fileName = (path: string): string => path.split(/[\\/]/).pop() || path;
export const extension = (path: string): string => fileName(path).split('.').pop()?.toLowerCase() ?? '';
export const isLocalPath = (path: string): boolean =>
  path.trim().length > 0 && !/[\x00-\x1f]/.test(path)
  && !/^[a-z][a-z0-9+.-]*:/i.test(path.replace(/^[a-z]:[/\\]/i, ''));

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
      if (!Number.isFinite(value) || value < 0) throw new Error(`CSV row ${index + 2}: ${required[i]} must be finite and non-negative.`);
      return value;
    }) as [number, number, number];
    if (values[0] <= previous) throw new Error(`CSV row ${index + 2}: timestamps must increase strictly.`);
    previous = values[0];
    return values;
  });
  return { importedAt, samples };
}

/** Validation shared by load and tests; schema checks the same shape in Python. */
export function linkedFilesProblem(obj: PlanObject): string | null {
  if (!isKnownType(obj.type)) return null;
  if (obj.linkedFiles === undefined) return null;
  if (!canLinkFiles(obj)) return 'This object type does not support linked files.';
  if (!Array.isArray(obj.linkedFiles) || obj.linkedFiles.length > 100) return 'linkedFiles must be an array of at most 100 files.';
  const ids = new Set<string>();
  for (const link of obj.linkedFiles) {
    if (!link || typeof link !== 'object' || typeof link.id !== 'string' || !link.id || ids.has(link.id)) return 'Linked file IDs must be non-empty and unique within their object.';
    ids.add(link.id);
    if (typeof link.path !== 'string' || !isLocalPath(link.path)) return 'Linked files need a local file path, not a URL.';
    if (link.kind !== (obj.type === 'camera' ? 'video' : 'spreadsheet')) return 'Cameras link videos; burners and sensors link spreadsheets.';
    if (link.label !== undefined && typeof link.label !== 'string') return 'Linked file labels must be text.';
    if (link.plot !== undefined) {
      if (obj.type !== 'burner' || !link.plot || typeof link.plot.importedAt !== 'string' || !link.plot.importedAt) return 'Only burner spreadsheets can hold reconstruction plots, with an import date.';
      const samples = link.plot.samples;
      if (!Array.isArray(samples) || !samples.length || samples.length > MAX_PLOT_SAMPLES) return 'A plot needs 1–20,000 samples.';
      let previous = -Infinity;
      for (const sample of samples) {
        if (!Array.isArray(sample) || sample.length !== 3 || !sample.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) || sample[0] <= previous) return 'Plot samples need increasing non-negative times and finite, non-negative volume and area.';
        previous = sample[0];
      }
    }
  }
  return null;
}
