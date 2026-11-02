/** Pure measured-table interpretation. Mirror of python/fireplan/tables.py.
 * Recorded numbers are never converted, interpolated, rounded or calibrated here.
 */
import { delimitedRows } from './delimited';

export type Cell = number | string | null;
export interface CellError { row: number; column: number; code: string }
export type Grid = Cell[][] & { readonly errors?: CellError[] };
export interface Layout {
  shape: 'paired-time' | 'processed' | 'fds' | 'plain';
  headerRow: number;
  unitsRow: number | null;
  dataRow: number;
  timeColumn: number | null;
}
export interface Channel { name: string; unit: string | null; rawUnit: string | null; column: number; t: number[]; values: number[]; missing: number }
export interface Extraction { channels: Channel[]; warnings: string[] }
export interface TimeShiftHint { seconds: number; row: number; column: number }

export const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: Cell | undefined): string => typeof v === 'string' ? v.trim() : '';
export function numericCell(value: string): number | null {
  value = value.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Non-enumerable metadata keeps array/JSON consumers seeing just Cell[][]. */
export function makeGrid(rows: Cell[][], errors: CellError[] = []): Grid {
  let width = 0;
  for (const row of rows) width = Math.max(width, row.length);
  for (const row of rows) while (row.length < width) row.push(null);
  Object.defineProperty(rows, 'errors', { value: errors });
  return rows;
}

export function readDelimited(source: string): Grid {
  return makeGrid(delimitedRows(source).map(row => row.map(value => value === '' ? null : numericCell(value) ?? value)));
}

export function columnName(column: number): string {
  let name = '';
  for (column++; column > 0; column = Math.floor((column - 1) / 26)) name = String.fromCharCode(65 + (column - 1) % 26) + name;
  return name;
}

function pairs(row: Cell[]): [number, number][] {
  const result: [number, number][] = [];
  for (let c = 0; c + 1 < row.length; c++) {
    const match = /^(.*)_Time\*?$/i.exec(text(row[c]));
    if (match && match[1] && match[1].toLowerCase() === text(row[c + 1]).toLowerCase()) { result.push([c, c + 1]); c++; }
  }
  return result;
}

const unitToken = /^(?:s|sec|secs|second|seconds|min|mins|minutes|C|°C|ºC|K|kW|W|kW\/m[2²]|W\/m[2²]|MJ|V|Volt|Volts|mV|A|mA|%|%Vol|m\/s|m|Pa|kPa|kg\/s)$/i;
const bracketed = /^\[[^\[\]]+\]$/;
const unitLike = (value: Cell | undefined): boolean => bracketed.test(text(value)) || unitToken.test(text(value));
function unit(value: Cell | undefined): string | null {
  const s = text(value);
  const token = bracketed.test(s) ? s.slice(1, -1).trim() : s;
  return ({ volt: 'V', volts: 'V', c: '°C', 'ºc': '°C', sec: 's' } as Record<string, string>)[token.toLowerCase()] ?? (token || null);
}
function isUnits(row: Cell[]): boolean {
  const cells = row.filter(v => v !== null && v !== '');
  return cells.length > 0 && cells.filter(unitLike).length > cells.length / 2;
}
const note = (value: string): boolean => /^\([\s\S]*\)$/.test(value) || /^Calculated$/i.test(value);
function fillers(row: Cell[]): Set<string> {
  const counts = new Map<string, number>();
  for (const value of row.map(text)) if (value && !unitLike(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count >= 3).map(([value]) => value));
}
interface ColumnHeader { name: string; unit: string | null; rawUnit: string | null }
/** Shared by detection and extraction so time selection sees the same headers. */
function columnHeaders(grid: Grid, layout: Layout): ColumnHeader[] {
  let width = 0;
  for (const row of grid) width = Math.max(width, row.length);
  const headers: ColumnHeader[] = Array.from({ length: width }, () => ({ name: '', unit: null, rawUnit: null }));
  if (layout.shape !== 'processed') {
    return headers.map((_, c) => {
      const raw = layout.unitsRow === null ? null : grid[layout.unitsRow - 1]?.[c];
      return { name: text(grid[layout.headerRow - 1]?.[c]), unit: unit(raw), rawUnit: text(raw) ? raw as string : null };
    });
  }
  for (const row of grid.slice(0, layout.dataRow - 1)) {
    const filler = fillers(row);
    row.forEach((raw, c) => {
      const value = text(raw), header = headers[c];
      if (!value || filler.has(value) || note(value)) return;
      if (unitLike(value)) {
        if (header.rawUnit === null) { header.rawUnit = raw as string; header.unit = unit(value); }
      } else if (!header.name) header.name = value;
    });
  }
  return headers;
}

/** Find every Channel/Unit table, irrespective of its position or column order.
 * Later nonempty entries win; map values retain the source unit text.
 */
export function channelUnits(grid: Grid): Map<string, string> {
  const result = new Map<string, string>();
  for (let r = 0; r < grid.length; r++) {
    const header = grid[r].map(v => text(v).toLowerCase());
    const nameColumn = header.indexOf('channel'), unitColumn = header.indexOf('unit');
    if (nameColumn < 0 || unitColumn < 0) continue;
    while (++r < grid.length && grid[r].some(v => isNumber(v) || text(v))) {
      const name = text(grid[r][nameColumn]), raw = grid[r][unitColumn];
      if (name && text(raw)) result.set(name, raw as string);
    }
  }
  return result;
}

function seconds(header: Cell | undefined, units: Cell | undefined): boolean {
  const s = `${text(header)} ${unit(units) ?? ''}`;
  return /(?:^|[^a-z])(?:s|sec|secs|second|seconds)(?:$|[^a-z])/i.test(s);
}
function timeColumn(grid: Grid, layout: Layout): number {
  const headers = columnHeaders(grid, layout);
  const candidates = headers.flatMap((h, c) => {
    if (!/time/i.test(h.name) && !seconds(h.name, h.unit)) return [];
    let first: number | null = null;
    for (let r = layout.dataRow - 1; r < grid.length; r++) {
      const value = grid[r][c];
      if (!isNumber(value)) continue;
      if (first !== null) return value > first ? [c] : [];
      first = value;
    }
    return first === null ? [] : [c];
  });
  return candidates.find(c => seconds(headers[c].name, headers[c].unit)) ?? candidates[0] ?? 0;
}

export function detectShape(grid: Grid): Layout {
  const numeric = grid.findIndex(row => isNumber(row[0]) && isNumber(row[1]));
  const headerEnd = numeric < 0 ? grid.length : numeric;
  for (let r = 0; r < headerEnd; r++) {
    const row = grid[r], paired = pairs(row);
    if (paired.length && paired.length * 2 > row.filter(v => text(v)).length / 2) {
      const unitsRow = isUnits(grid[r + 1] ?? []) ? r + 2 : null;
      return { shape: 'paired-time', headerRow: r + 1, unitsRow, dataRow: (unitsRow ?? r + 1) + 1, timeColumn: null };
    }
  }
  if (text(grid[0]?.[0]).toLowerCase() === 's' && text(grid[1]?.[0]).toLowerCase() === 'time') {
    return { shape: 'fds', headerRow: 2, unitsRow: 1, dataRow: 3, timeColumn: 0 };
  }
  let headerRow = 1, unitsRow: number | null = null, dataRow = 2;
  let shape: Layout['shape'] = 'plain';
  if (numeric > 1) {
    shape = 'processed'; dataRow = numeric + 1;
    let best = -1;
    for (let r = 0; r < numeric; r++) {
      if (isUnits(grid[r])) continue;
      const filler = fillers(grid[r]);
      const score = new Set(grid[r].map(text).filter(s => s && !filler.has(s) && !unitLike(s) && !note(s))).size;
      if (score > best) { best = score; headerRow = r + 1; }
    }
    // Prefer the units row nearest the names, after it on a distance tie.
    const rows = Array.from({ length: numeric }, (_, r) => r + 1).filter(r => r !== headerRow && isUnits(grid[r - 1]));
    rows.sort((a, b) => Math.abs(a - headerRow) - Math.abs(b - headerRow) || b - a);
    unitsRow = rows[0] ?? null;
    if (numeric === 2 && headerRow === 1 && unitsRow === 2) shape = 'plain';
  } else if ((grid[1] ?? []).some(v => text(v)) && (grid[1] ?? []).every(v => v === null || typeof v === 'string')) {
    unitsRow = 2; dataRow = 3;
  }
  const layout: Layout = { shape, headerRow, unitsRow, dataRow, timeColumn: 0 };
  layout.timeColumn = timeColumn(grid, layout);
  return layout;
}

export function timeShiftHint(grid: Grid): TimeShiftHint | null {
  const hasData = grid.some(row => isNumber(row[0]) && isNumber(row[1]));
  const end = hasData ? detectShape(grid).dataRow - 1 : grid.length;
  const candidates: TimeShiftHint[] = [];
  for (let r = 0; r < end; r++) grid[r].forEach((value, c) => {
    if (!/sh(i)?ft|ignition\s+at|offset/i.test(text(value))) return;
    const vertical = [[r - 1, c], [r + 1, c]].filter(([rr, cc]) => rr >= 0 && rr < end && isNumber(grid[rr]?.[cc]));
    for (const [rr, cc] of vertical.length ? vertical : [[r, c - 1], [r, c + 1]]) {
      if (rr < 0 || rr >= end || cc < 0) continue;
      const number = grid[rr]?.[cc];
      if (isNumber(number)) candidates.push({ seconds: number, row: rr + 1, column: cc });
    }
  });
  if (new Set(candidates.map(c => c.seconds)).size !== 1) return null;
  return candidates.sort((a, b) => a.row - b.row || a.column - b.column)[0];
}

export function extractSeries(grid: Grid, layout: Layout, units: ReadonlyMap<string, string> = new Map()): Extraction {
  const { headerRow, unitsRow, dataRow } = layout;
  if (![headerRow, dataRow].every(v => Number.isInteger(v) && v >= 1) || (unitsRow !== null && (!Number.isInteger(unitsRow) || unitsRow < 1)) || (layout.shape !== 'paired-time' && (layout.timeColumn === null || !Number.isInteger(layout.timeColumn) || layout.timeColumn < 0))) throw new Error('Invalid table layout.');
  const warnings = [...(grid.errors ?? [])].sort((a, b) => a.row - b.row || a.column - b.column).map(e => `Cell ${columnName(e.column)}${e.row}: ${e.code} treated as missing.`);
  const header = grid[headerRow - 1] ?? [];
  const headers = columnHeaders(grid, layout);
  const selected: [number, number][] = layout.shape === 'paired-time' ? pairs(header) : headers.map((_, c): [number, number] => [layout.timeColumn!, c]).filter(([, c]) => c !== layout.timeColumn && (headers[c].name || grid.slice(dataRow - 1).some(row => row[c] !== undefined && row[c] !== null)));
  const ends = new Map<number, number>();
  for (const [time] of selected) {
    if (ends.has(time)) continue;
    let previous = -Infinity, end = grid.length;
    for (let r = dataRow - 1; r < grid.length; r++) {
      const t = grid[r][time];
      if (!isNumber(t)) continue;
      if (t <= previous) { end = r; warnings.push(`Time column ${columnName(time)} stops increasing at sheet row ${r + 1}; series ended.`); break; }
      previous = t;
    }
    ends.set(time, end);
  }
  const baseNames = selected.map(([, c]) => headers[c].name || `Column ${columnName(c)}`);
  const channelHeaders = selected.map(([, c], i) => {
    const h = headers[c], raw = h.rawUnit ?? units.get(baseNames[i]) ?? null;
    return { unit: unit(raw), rawUnit: text(raw) ? raw : null };
  });
  const unitGroups = new Map<string, Set<string | null>>();
  baseNames.forEach((base, i) => { if (!unitGroups.has(base)) unitGroups.set(base, new Set()); unitGroups.get(base)!.add(channelHeaders[i].unit); });
  const stems = baseNames.map((base, i) => unitGroups.get(base)!.size > 1 ? `${base} [${channelHeaders[i].unit ?? 'unknown'}]` : base);
  const reserved = new Set([...baseNames, ...stems]), original = new Set(baseNames), used = new Set<string>(), channels: Channel[] = [];
  selected.forEach(([time, c], index) => {
    const base = baseNames[index], stem = stems[index];
    let name = stem, suffix = 2;
    if (used.has(name) || (stem !== base && original.has(stem))) {
      do { name = `${stem}#${suffix++}`; } while (used.has(name) || reserved.has(name));
    }
    if (name !== base) warnings.push(`Duplicate channel name "${base}" renamed to "${name}".`);
    used.add(name);
    const channel: Channel = { name, ...channelHeaders[index], column: c, t: [], values: [], missing: 0 };
    for (let r = dataRow - 1; r < ends.get(time)!; r++) {
      const t = grid[r][time], value = grid[r][c];
      if (!isNumber(t) || !isNumber(value)) { channel.missing++; continue; }
      channel.t.push(t); channel.values.push(value);
    }
    if (channel.t.length) channels.push(channel);
    else warnings.push(`Channel "${name}" has no numeric samples and was dropped.`);
  });
  return { channels, warnings: channels.length ? warnings : ['No time series on this sheet.'] };
}

/** Hint only: unknown input units assume V; known non-voltage units refuse. */
export function calibrationHint(name: string, input: string | null): { scale: number; unit: string; inputUnit: 'V' | 'mV' } | null {
  const source = unit(input)?.toLowerCase() ?? 'v';
  if (source !== 'v' && source !== 'mv') return null;
  const match = /(?:^|[^a-z0-9.+-])([+-]?(?:\d+\.?\d*|\.\d+))\s*kW\s*\/\s*m[2²]\s*per\s*mV(?=$|[^a-z0-9])/i.exec(name);
  if (!match) return null;
  const scale = Number(match[1]) * (source === 'mv' ? 1 : 1000);
  return Number.isFinite(scale) && scale > 0 ? { scale, unit: 'kW/m2', inputUnit: source === 'mv' ? 'mV' : 'V' } : null;
}
