/**
 * Pure helpers for the Test data dialog and the instrument plots: target labels,
 * calibration pre-fill, manifest upkeep and preview rows. No DOM and no I/O, so
 * the rules the dialog shows are unit-tested on their own.
 */
import { beadPositions, displayName } from '../core/plan';
import { calibrationHint } from '../core/tables';
import { seriesKey, type TargetUnit } from '../core/test-data';
import { isBurner, isGasSampling, isHeatFluxSensor, isLoadCell, isThermocouple, isVelocityProbe,
  type LengthUnit, type PlanDocument, type TestDataManifest, type TestDataMapping, type TestDataTable } from '../core/types';
import { formatLengthWithUnit } from '../core/units';
import { fmt } from './plot-svg';

/** Something a channel can be mapped to: a gauge, one bead, a probe, a gas point, a load
 *  cell, or a burner's HRR. */
export interface Target {
  key: string;
  object: string;
  bead?: number;
  label: string;
  group: 'gauge' | 'thermocouple' | 'velocityProbe' | 'gasSampling' | 'loadCell' | 'burner';
  unit: TargetUnit;
}

/** The Instrument select's option groups, in the order targetOptions lists them. */
export const TARGET_GROUPS: Record<Target['group'], string> = {
  gauge: 'Heat flux gauges', thermocouple: 'Thermocouple beads', velocityProbe: 'Velocity probes',
  gasSampling: 'Gas sampling points', loadCell: 'Load cells', burner: 'Burners (HRR)',
};

export const targetKey = (m: { object: string; bead?: number | null }): string => seriesKey(m.object, m.bead);
export function parseTargetKey(key: string): { object: string; bead?: number } {
  const [object, bead] = JSON.parse(key) as [string, number | null];
  return bead === null ? { object } : { object, bead };
}

/** Display spelling of the API units (CONVENTIONS section 12 keeps `kW/m2`). */
export const unitLabel = (unit: string | null): string => unit === 'kW/m2' ? 'kW/m²' : unit ?? 'no unit';
const QUANTITY_BY_UNIT: Record<string, string> = {
  'kW/m2': 'Heat flux', '°C': 'Temperature', kW: 'Heat release rate', 'm/s': 'Velocity', kg: 'Mass',
};
/** The plotted quantity's name. A gas sampling point keeps its column's own unit, so
 *  any other unit, or none, is a plain "Value". */
export const quantityOf = (unit: TargetUnit): string => (unit !== null ? QUANTITY_BY_UNIT[unit] : undefined) ?? 'Value';

/** A bead's label: the rake's name, its one-based number and its height above the floor. */
export function beadLabel(name: string, bead: number, beads: number, heightM: number, unit: LengthUnit): string {
  const height = formatLengthWithUnit(heightM, unit);
  return beads > 1 ? `${name} · bead ${bead + 1} at ${height}` : `${name} at ${height}`;
}

/** Every target in the plan: gauges, each bead of every thermocouple, velocity probes,
 *  gas sampling points (which keep the column's own unit), load cells, then burners. */
export function targetOptions(doc: PlanDocument, unit: LengthUnit): Target[] {
  const gauges: Target[] = [], beads: Target[] = [], others: Target[] = [], burners: Target[] = [];
  for (const o of doc.objects) {
    if (isHeatFluxSensor(o)) gauges.push({ key: targetKey({ object: o.id }), object: o.id, label: displayName(o), group: 'gauge', unit: 'kW/m2' });
    else if (isVelocityProbe(o)) others.push({ key: targetKey({ object: o.id }), object: o.id, label: `${displayName(o)} (velocity)`, group: 'velocityProbe', unit: 'm/s' });
    else if (isGasSampling(o)) others.push({ key: targetKey({ object: o.id }), object: o.id, label: `${displayName(o)} (gas)`, group: 'gasSampling', unit: null });
    else if (isLoadCell(o)) others.push({ key: targetKey({ object: o.id }), object: o.id, label: `${displayName(o)} (mass)`, group: 'loadCell', unit: 'kg' });
    else if (isBurner(o)) burners.push({ key: targetKey({ object: o.id }), object: o.id, label: `${displayName(o)} (HRR)`, group: 'burner', unit: 'kW' });
    else if (isThermocouple(o)) {
      const positions = beadPositions(o);
      positions.forEach((p, bead) => beads.push({ key: targetKey({ object: o.id, bead }), object: o.id, bead,
        label: beadLabel(displayName(o), bead, positions.length, p[2], unit), group: 'thermocouple', unit: '°C' }));
    }
  }
  return [...gauges, ...beads, ...others, ...burners];
}

const normalUnit = (unit: string | null): string => {
  const u = (unit ?? '').replace(/\s+/g, '').replace('²', '2').toLowerCase();
  return ['c', 'ºc', '°c'].includes(u) ? '°c' : u;
};
/** Whether a channel's own unit already is the target quantity's unit. */
export const sameUnit = (unit: string | null, target: TargetUnit): boolean => normalUnit(unit) === normalUnit(target);

const precise = (v: number): string => String(Number(v.toPrecision(12)));
/** Where a pre-filled gauge constant came from, in the form the channel name gives it. */
export function calibrationNote(hint: NonNullable<ReturnType<typeof calibrationHint>>): string {
  const perMv = hint.inputUnit === 'V' ? hint.scale / 1000 : hint.scale;
  return `${precise(perMv)} kW/m² per mV, from the channel name`;
}

/**
 * Scale and offset for a channel newly mapped to `target`. A gauge channel in
 * volts takes the constant its name carries; one already in kW/m² takes 1. Other
 * targets keep what the mapping had, so re-targeting does not lose a calibration.
 */
export function prefill(channel: { name: string; unit: string | null }, target: Target,
  previous?: Pick<TestDataMapping, 'scale' | 'offset'>): Pick<TestDataMapping, 'scale' | 'offset'> {
  const kept: Pick<TestDataMapping, 'scale' | 'offset'> = {};
  if (previous?.scale !== undefined) kept.scale = previous.scale;
  if (previous?.offset !== undefined) kept.offset = previous.offset;
  if (target.group !== 'gauge') return kept;
  const hint = calibrationHint(channel.name, channel.unit);
  if (hint) return { scale: hint.scale, ...(kept.offset !== undefined ? { offset: kept.offset } : {}) };
  if (sameUnit(channel.unit, 'kW/m2')) return { scale: 1, ...(kept.offset !== undefined ? { offset: kept.offset } : {}) };
  return kept;
}

/**
 * What a mapped row says about its calibration: where its scale came from, or that
 * the channel's unit is not the target's and nothing converts it.
 */
export function mappingNote(channel: { name: string; unit: string | null }, target: Target | undefined,
  mapping: Pick<TestDataMapping, 'scale' | 'offset'>): { text: string; tone: 'info' | 'warn' } | null {
  if (!target) return null;
  const scale = mapping.scale ?? 1;
  if (target.group === 'gauge') {
    const hint = calibrationHint(channel.name, channel.unit);
    if (hint && scale === hint.scale) return { text: calibrationNote(hint), tone: 'info' };
    if (sameUnit(channel.unit, 'kW/m2') && scale === 1) return { text: 'Already in kW/m², so the scale is 1', tone: 'info' };
  }
  // A gas point has no fixed unit: it plots in the column's own, so nothing to warn about.
  if (target.unit !== null && channel.unit !== null && !sameUnit(channel.unit, target.unit) && scale === 1 && (mapping.offset ?? 0) === 0) {
    return { text: `Recorded in ${unitLabel(channel.unit)}; enter the scale that gives ${unitLabel(target.unit)}`, tone: 'warn' };
  }
  return null;
}

export interface ChannelInfo { name: string; unit: string | null; samples: number; t0: number | null; t1: number | null }

/**
 * The manifest after a mapping edit: one entry per distinct mapped name, in
 * first-mapping order. Recorded entries are kept as they are (the manifest
 * describes the original read); a newly mapped channel is described from `channels`.
 */
export function updateManifestChannels(manifest: TestDataManifest, mappings: readonly TestDataMapping[],
  channels: readonly ChannelInfo[]): TestDataManifest {
  const names = [...new Set(mappings.map(m => m.channel))];
  return { ...manifest, channels: names.map(name => {
    const recorded = manifest.channels.find(c => c.name === name);
    if (recorded) return recorded;
    const read = channels.find(c => c.name === name);
    if (!read) throw new Error(`Channel "${name}" is not in this file.`);
    return { name, unit: read.unit, samples: read.samples, t0: read.t0, t1: read.t1 };
  }) };
}

/**
 * Sheet rows a preview shows, 1-based; null marks skipped rows. The first `max`
 * rows, or, when the layout points further down, the top rows and a window around
 * each marked row, so the names, units and first data rows are always on screen.
 */
export function previewRows(rowCount: number, table: Pick<TestDataTable, 'headerRow' | 'unitsRow' | 'dataRow'>, max = 12): (number | null)[] {
  const marked = [table.headerRow, table.unitsRow, table.dataRow, table.dataRow + 2].filter((r): r is number => r !== null);
  const limit = Math.min(rowCount, max);
  if (marked.every(r => r <= limit) || rowCount <= max) return Array.from({ length: limit }, (_, i) => i + 1);
  const rows = new Set<number>();
  for (let r = 1; r <= Math.min(3, rowCount); r++) rows.add(r);
  for (const r of [table.headerRow, table.unitsRow]) if (r !== null) for (const d of [-1, 0, 1]) rows.add(r + d);
  for (let d = 0; d < 4; d++) rows.add(table.dataRow + d);
  const sorted = [...rows].filter(r => r >= 1 && r <= rowCount).sort((a, b) => a - b);
  const result: (number | null)[] = [];
  sorted.forEach((r, i) => { if (i && r > sorted[i - 1] + 1) result.push(null); result.push(r); });
  return result;
}

/** The one-click ignition offset a workbook offers, with the sheets that agree on it. */
export const shiftHintLabel = (hint: { seconds: number; sheets: string[] }): string =>
  `Use ${fmt(hint.seconds)} s from the sheet${hint.sheets.length === 1 ? '' : 's'} ${hint.sheets.join(', ')}`;

export function nextSourceId(doc: PlanDocument): string {
  const taken = new Set((doc.testData ?? []).map(s => s.id));
  let n = 1;
  while (taken.has(`td-${n}`)) n++;
  return `td-${n}`;
}

/** FDS output is a simulation; every other shape defaults to a measurement. */
export const defaultRole = (table: Pick<TestDataTable, 'shape'>): 'measured' | 'simulated' =>
  table.shape === 'fds' ? 'simulated' : 'measured';

/** Short status words for a source's session state, and the action it waits for. */
export function statusText(status: string, error?: string): { text: string; tone: 'good' | 'warn' | 'bad' | 'dim' } {
  switch (status) {
    case 'loaded': return { text: 'Loaded', tone: 'good' };
    case 'embedded': return { text: 'From the shared page (decimated)', tone: 'good' };
    case 'needs-file': return { text: 'Needs the file in this browser tab', tone: 'warn' };
    case 'needs-load': return { text: 'On a network share: waits for Load data', tone: 'warn' };
    case 'loading': return { text: 'Reading…', tone: 'dim' };
    case 'error': return { text: error ?? 'Could not be read', tone: 'bad' };
    default: return { text: 'Not read yet', tone: 'dim' };
  }
}
