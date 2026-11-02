/** Byte readers and source drafts. No document edits or automatic calibration. */
import { beadOffsetsOf } from '../core/plan';
import { exportedDeviceIds } from '../core/fds-export';
import { calibrationHint, channelUnits, detectShape, extractSeries, readDelimited, type Grid } from '../core/tables';
import { listSheets, readSheet, workbookChannelUnits, workbookTimeShiftHint } from '../core/xlsx';
import { isThermocouple, type PlanDocument, type TestDataMapping, type TestDataTable } from '../core/types';

export const TEST_DATA_FILE_CAP = 64 * 1024 * 1024;
export const yieldToPage = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
export interface TestDataBytes { bytes: Uint8Array; modified: string | null }
export type TestDataReader = (path: string) => Promise<TestDataBytes>;
export interface ParsedTable { grid: Grid; units: Map<string, string>; unitsGrid?: Grid }

function workbook(name: string, bytes: Uint8Array): boolean {
  if (bytes.length > TEST_DATA_FILE_CAP) throw new Error('Test data exceeds the 64 MiB limit.');
  if (/\.(xlsx|xlsm)$/i.test(name)) return true;
  if (/\.(csv|tsv|txt)$/i.test(name)) return false;
  throw new Error('Unsupported test data file. Save as .xlsx, .xlsm, .csv, .tsv or .txt.');
}

export async function parseTestData(name: string, bytes: Uint8Array, table: TestDataTable): Promise<ParsedTable> {
  await yieldToPage();
  if (!workbook(name, bytes)) return { grid: readDelimited(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), units: new Map() };
  if (!table.sheet) throw new Error('Choose a workbook sheet.');
  const grid = await readSheet(bytes, table.sheet);
  await yieldToPage();
  if (table.unitsSheet === null) return { grid, units: await workbookChannelUnits(bytes) };
  if (typeof table.unitsSheet === 'string') {
    const unitsGrid = table.unitsSheet === table.sheet ? grid : await readSheet(bytes, table.unitsSheet);
    return { grid, unitsGrid, units: channelUnits(unitsGrid) };
  }
  return { grid, units: new Map() };
}

export interface ChannelSummary {
  name: string;
  unit: string | null;
  samples: number;
  span: [number, number] | null;
  calibration: ReturnType<typeof calibrationHint>;
}
export interface DraftSheet extends ParsedTable {
  name: string | null;
  table: TestDataTable;
  channelCount: number;
  preview: Grid;
  channels: ChannelSummary[];
  warnings: string[];
  suggestedMappings: TestDataMapping[];
}
export interface Draft {
  name: string;
  size: number;
  sheets: DraftSheet[];
  defaultSheet: string | null;
  /** Null when no sheet contains a time series, including metadata-only files. */
  defaultSheetIndex: number | null;
  preview: Grid;
  channels: ChannelSummary[];
  shiftHint: Awaited<ReturnType<typeof workbookTimeShiftHint>>;
  suggestedMappings: TestDataMapping[];
}

/** Exact FDS names only. A bare thermocouple name selects bead 0, as in the model fixture. */
export function suggestMappings(names: string[], doc?: PlanDocument): TestDataMapping[] {
  const candidates = new Map<string, TestDataMapping[]>();
  const add = (name: string, mapping: TestDataMapping): void => {
    const list = candidates.get(name) ?? [];
    if (list.some(m => m.object === mapping.object && m.bead === mapping.bead)) return;
    candidates.set(name, [...list, mapping]);
  };
  // The IDs Export to FDS writes, so a run's output maps back by the same names,
  // including an imported rake's original device IDs (BACK_TC_1 ... BACK_TC_6).
  if (doc) {
    for (const [object, ids] of exportedDeviceIds(doc)) {
      const target = doc.objects.find(o => o.id === object);
      ids.forEach((channel, bead) => add(channel, isThermocouple(target!)
        ? { channel, object, bead } : { channel, object }));
    }
  }
  for (const o of doc?.objects ?? []) {
    const name = o.name || o.id;
    if (isThermocouple(o)) {
      const beads = beadOffsetsOf(o);
      add(name, { channel: name, object: o.id, bead: 0 });
      if (beads.length === 1) continue;
      beads.forEach((_, bead) => {
        const channel = beads.length > 1 ? `${name}_${bead + 1}` : name;
        add(channel, { channel, object: o.id, bead });
      });
    } else if (o.type === 'heatFluxSensor' || o.type === 'burner') add(name, { channel: name, object: o.id });
  }
  return names.flatMap(name => candidates.get(name)?.length === 1 ? candidates.get(name)! : []);
}

/** Progress and cancellation for a long draft. Every sheet is read, so a large
 * workbook takes seconds; the page yields between steps. */
export interface DraftOptions {
  /** Called before each step: `step` of `steps`, naming the sheet about to be read. */
  onProgress?: (progress: { step: number; steps: number; sheet: string | null }) => void;
  /** Aborting rejects with an `AbortError` at the next step. */
  signal?: AbortSignal;
}

export async function draftFromFile(name: string, bytes: Uint8Array, doc?: PlanDocument, options: DraftOptions = {}): Promise<Draft> {
  const { onProgress, signal } = options;
  const checkpoint = async (): Promise<void> => {
    await yieldToPage();
    if (signal?.aborted) throw new DOMException('Reading the file was cancelled.', 'AbortError');
  };
  await checkpoint();
  const isWorkbook = workbook(name, bytes);
  const names: (string | null)[] = isWorkbook ? await listSheets(bytes) : [null];
  // Metadata units and the shift hint each scan the workbook once more.
  const steps = names.length + (isWorkbook ? 2 : 0);
  if (isWorkbook) {
    onProgress?.({ step: 1, steps, sheet: null });
    await checkpoint();
  }
  const units = isWorkbook ? await workbookChannelUnits(bytes) : new Map<string, string>();
  const sheets: DraftSheet[] = [];
  for (const [index, sheet] of names.entries()) {
    onProgress?.({ step: index + (isWorkbook ? 2 : 1), steps, sheet });
    await checkpoint();
    const grid = sheet === null ? readDelimited(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) : await readSheet(bytes, sheet);
    const table: TestDataTable = { sheet, ...detectShape(grid), ...(isWorkbook ? { unitsSheet: null } : {}) };
    const extraction = extractSeries(grid, table, units);
    const channels = extraction.channels.map(c => ({ name: c.name, unit: c.unit, samples: c.t.length,
      span: c.t.length ? [c.t[0], c.t.at(-1)!] as [number, number] : null,
      calibration: calibrationHint(c.name, c.unit) }));
    sheets.push({ name: sheet, table, grid, units, channelCount: channels.length, preview: grid.slice(0, 12),
      channels, warnings: extraction.warnings,
      suggestedMappings: table.shape === 'fds' ? suggestMappings(channels.map(c => c.name), doc) : [] });
  }
  let index = sheets.findIndex(s => s.channelCount > 0 && ['paired-time', 'fds'].includes(s.table.shape));
  if (index < 0) index = sheets.findIndex(s => s.channelCount > 0);
  const selected = sheets[index];
  if (isWorkbook) {
    onProgress?.({ step: steps, steps, sheet: null });
    await checkpoint();
  }
  const shiftHint = isWorkbook ? await workbookTimeShiftHint(bytes) : null;
  return { name, size: bytes.length, sheets, defaultSheet: selected?.name ?? null, defaultSheetIndex: index < 0 ? null : index,
    preview: selected?.preview ?? [], channels: selected?.channels ?? [],
    shiftHint, suggestedMappings: selected?.suggestedMappings ?? [] };
}
