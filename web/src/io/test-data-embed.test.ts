import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decimateMinMax, type Series } from '../core/test-data';
import { parseAndValidatePlan } from '../core/validate';
import { Store } from '../state/store';
import { TestDataStore } from '../state/test-data-store';
import { decodeTestData, embedTestData, splitEmbeddedTestData } from './test-data-embed';
import { embedPlanInHtml } from './files';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/test-data/${name}`, import.meta.url)));
const doc = () => parseAndValidatePlan(new TextDecoder().decode(fixture('test-data.ftp.json')));
const boot = '<html><head><title>Test</title><script type="application/json" id="embedded-plan"></script></head></html>';

describe('shared test data', () => {
  it('round-trips through HTML and the session, with exactly the decimated samples and no saved payload', async () => {
    const store = new Store(doc());
    const data = new TestDataStore(store, path => Promise.resolve({ bytes: fixture(path), modified: null }));
    await Promise.all(store.document.testData!.map(s => data.load(s.id)));
    // Extend one stream to exercise actual decimation, including an interior extreme.
    const series = data.get('fds')!.series[0];
    series.t = Float64Array.from({ length: 5001 }, (_, i) => i / 13);
    series.values = Float64Array.from(series.t, (_, i) => i === 2500 ? 10000 : Math.sin(i));
    const original = store.serialize();
    const summary = embedTestData(store.document, id => data.get(id));
    expect(summary.included).toEqual(['logger', 'fds']);
    expect(summary.omitted).toEqual([]);
    const html = embedPlanInHtml(boot, original, 'Test', new Map(), summary.payload);
    const text = /id="embedded-plan">([\s\S]*?)<\/script>/.exec(html)![1];
    const decoded = splitEmbeddedTestData(text);
    expect(decoded.warnings).toEqual([]);
    const sharedStore = new Store(parseAndValidatePlan(decoded.text));
    const shared = new TestDataStore(sharedStore);
    for (const [id, series] of decoded.series) shared.attachEmbedded(id, series);
    expect(shared.get('fds')?.status).toBe('embedded');
    const points = decimateMinMax(series.t, series.values);
    expect(shared.seriesFor('hf-east')[1].t).toEqual(points.t);
    expect(shared.seriesFor('hf-east')[1].values).toEqual(points.values);
    expect(shared.seriesFor('hf-east')[1].values).toContain(10000);
    expect(shared.seriesFor('hf-east')[1].t.length).toBeLessThanOrEqual(2000);
    expect(sharedStore.serialize()).not.toContain('embeddedTestData');
    expect(store.serialize()).toBe(original);
    sharedStore.edit('Unmap', d => { d.testData![1].channels = []; });
    expect(shared.seriesFor('hf-east')).toHaveLength(1);
    sharedStore.undo();
    expect(shared.seriesFor('hf-east')[1].values).toEqual(points.values);
    sharedStore.edit('Invalid calibration', d => { d.testData![1].channels[0].scale = 0; });
    expect(shared.get('fds')?.status).toBe('error');
    expect(shared.get('fds')?.error).toContain('Invalid test data calibration');
    sharedStore.undo();
    expect(shared.get('fds')?.status).toBe('embedded');
    data.dispose(); shared.dispose();
  });

  it('applies a byte cap in source order and carries a page warning and summary', () => {
    const plan = doc();
    const series: Series = { sourceId: 'logger', sourceName: 'Name </script>', role: 'measured', objectId: 'hf-east',
      bead: null, unit: 'kW/m2', t: Float64Array.of(0, 1), values: Float64Array.of(2, 3), missing: 0 };
    const get = (id: string) => ({ status: 'loaded' as const, mismatches: [], series: [{ ...series, sourceId: id }] });
    const first = embedTestData({ ...plan, testData: [plan.testData![0]] }, get);
    const capped = embedTestData(plan, get, first.bytes + 2);
    expect(capped.included).toEqual(['logger']); expect(capped.omitted).toEqual(['fds']);
    expect(capped.bytes).toBeLessThanOrEqual(first.bytes + 2);
    const html = embedPlanInHtml(boot, JSON.stringify(plan), 'Test', new Map(), capped.payload);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(splitEmbeddedTestData(/id="embedded-plan">([\s\S]*?)<\/script>/.exec(html)![1]).warnings).toEqual(capped.warnings);
    expect(embedTestData(plan, () => undefined).unloaded).toEqual(['logger', 'fds']);
  });

  it('rejects malformed payloads without losing the plan', () => {
    expect(() => decodeTestData({ version: 1, sources: [{ id: 'fds', series: [null] }], omitted: 0 })).toThrow('Invalid');
    const split = splitEmbeddedTestData(JSON.stringify({ ...doc(), embeddedTestData: { version: 9 } }));
    expect(split.series.size).toBe(0); expect(split.warnings).toHaveLength(1);
    expect(() => parseAndValidatePlan(split.text)).not.toThrow();
    expect(splitEmbeddedTestData('{broken').text).toBe('{broken');
  });
});
