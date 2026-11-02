/** Compact, bounded shared-page data, lifted out before plan validation or Save. */
import { decimateMinMax, type Series } from '../core/test-data';
import type { PlanDocument } from '../core/types';
import type { TestDataEntry } from '../state/test-data-store';

export const TEST_DATA_SHARE_CAP = 5_000_000;
type PackedSeries = Omit<Series, 't' | 'values'> & { t: number[]; values: number[] };
export interface TestDataPayload { version: 1; sources: { id: string; series: PackedSeries[] }[]; omitted: number }
export interface TestDataShareSummary {
  payload: TestDataPayload;
  bytes: number;
  included: string[];
  omitted: string[];
  unloaded: string[];
  warnings: string[];
}
const encodedSize = (payload: TestDataPayload): number =>
  new TextEncoder().encode(JSON.stringify(payload).replace(/</g, '\\u003c')).length;
export const shareWarning = (count: number): string =>
  `Test data: ${count} source(s) omitted because the shared-page data exceeds the 5 MB limit.`;

/** Whole sources in document order. A later smaller source can use remaining space. */
export function embedTestData(doc: PlanDocument, get: (sourceId: string) => TestDataEntry | undefined,
  cap = TEST_DATA_SHARE_CAP): TestDataShareSummary {
  const payload: TestDataPayload = { version: 1, sources: [], omitted: 0 };
  const included: string[] = [], omitted: string[] = [], unloaded: string[] = [];
  for (const source of doc.testData ?? []) {
    const entry = get(source.id);
    if (!entry || !['loaded', 'embedded'].includes(entry.status)) { unloaded.push(source.id); continue; }
    const series = entry.series.map(s => {
      const points = decimateMinMax(s.t, s.values, 2000);
      return { ...s, t: Array.from(points.t), values: Array.from(points.values) };
    });
    payload.sources.push({ id: source.id, series });
    // Reserve the largest possible omitted count while testing the byte ceiling.
    payload.omitted = (doc.testData ?? []).length;
    if (encodedSize(payload) > cap) { payload.sources.pop(); omitted.push(source.id); }
    else included.push(source.id);
  }
  payload.omitted = omitted.length;
  const warnings = omitted.length ? [shareWarning(omitted.length)] : [];
  return { payload, bytes: encodedSize(payload), included, omitted, unloaded, warnings };
}

/** Validate untrusted JSON before constructing typed arrays or adopting any source. */
export function decodeTestData(value: unknown): Map<string, Series[]> {
  const bad = (): never => { throw new Error('Invalid embedded test data.'); };
  if (!value || typeof value !== 'object') return bad();
  const p = value as TestDataPayload;
  if (p.version !== 1 || !Array.isArray(p.sources) || !Number.isInteger(p.omitted) || p.omitted < 0
    || encodedSize(p) > TEST_DATA_SHARE_CAP) return bad();
  const result = new Map<string, Series[]>();
  for (const source of p.sources) {
    if (!source || typeof source.id !== 'string' || result.has(source.id) || !Array.isArray(source.series)) return bad();
    const series: Series[] = [];
    const targets = new Set<string>();
    for (const s of source.series) {
      if (!s || s.sourceId !== source.id || typeof s.sourceName !== 'string' || typeof s.objectId !== 'string'
        || !['measured', 'simulated'].includes(s.role) || !['kW/m2', '°C', 'kW'].includes(s.unit)
        || !(s.bead === null || Number.isInteger(s.bead) && s.bead >= 0)
        || !Number.isInteger(s.missing) || s.missing < 0 || !Array.isArray(s.t) || !Array.isArray(s.values)
        || s.t.length > 2000 || s.t.length !== s.values.length) return bad();
      const key = JSON.stringify([s.objectId, s.bead]);
      if (targets.has(key)) return bad();
      targets.add(key);
      for (let i = 0; i < s.t.length; i++) {
        if (!Number.isFinite(s.t[i]) || !Number.isFinite(s.values[i]) || i > 0 && s.t[i] <= s.t[i - 1]) return bad();
      }
      series.push({ ...s, t: Float64Array.from(s.t), values: Float64Array.from(s.values) });
    }
    result.set(source.id, series);
  }
  return result;
}

export function splitEmbeddedTestData(text: string): { text: string; series: Map<string, Series[]>; warnings: string[] } {
  const result = { text, series: new Map<string, Series[]>(), warnings: [] as string[] };
  let doc;
  try { doc = JSON.parse(text); } catch { return result; }
  if (!doc || typeof doc !== 'object' || !('embeddedTestData' in doc)) return result;
  const payload = doc.embeddedTestData;
  delete doc.embeddedTestData;
  result.text = JSON.stringify(doc);
  try {
    result.series = decodeTestData(payload);
    if (payload.omitted) result.warnings.push(shareWarning(payload.omitted));
  } catch (err) { result.warnings.push((err as Error).message); }
  return result;
}
