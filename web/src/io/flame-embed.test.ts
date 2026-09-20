/**
 * A shared page carries its flames inside the plan copy; a saved plan never does.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FlameSequence, gunzip } from '../core/flame';
import { flameSequenceLink, reconstructedFlames } from '../core/plan';
import { serializePlan } from '../core/serialize';
import type { PlanDocument } from '../core/types';
import { parseAndValidatePlan } from '../core/validate';
import { embedPlanInHtml, embeddedFlameKey, splitEmbeddedFlames } from './files';
import { base64ToBytes, bytesToBase64, decodeEmbedded, encodeEmbedded } from './flame-sources';

const PLAN = readFileSync(fileURLToPath(new URL('../../../fixtures/flame/flame-test.ftp.json', import.meta.url)), 'utf8');
const FVS = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../fixtures/flame/flame-test.fvs', import.meta.url))));
const EXPECTED = JSON.parse(readFileSync(fileURLToPath(new URL('../../../fixtures/flame/expected.json', import.meta.url)), 'utf8'));
const BOOT = '<!doctype html><html><head><title>Fire Test Plan Editor</title><script type="application/json" id="embedded-plan"></script></head><body></body></html>';

describe('embedded flames', () => {
  it('round-trips bytes through base64 in chunks', () => {
    const bytes = new Uint8Array(100_003).map((_, i) => (i * 31) & 0xff);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  it('reads the bundled Example payload the Python builder wrote', async () => {
    const sequence = FlameSequence.unpack(await gunzip(FVS));
    expect(sequence.frames).toHaveLength(80);
    expect(sequence.manifest('2026-09-19T20:00:00Z')).toEqual(flameSequenceLink(reconstructedFlames(JSON.parse(PLAN) as PlanDocument)[0])!.sequence);
    const encoded = await encodeEmbedded(sequence);
    expect(encoded.length).toBeLessThan(100_000);
    const back = await decodeEmbedded(encoded);
    expect(back.pack().length).toBe(EXPECTED.packedBytes);
  });

  it('rides inside the shared page and is lifted out before validation', async () => {
    const doc = JSON.parse(PLAN) as PlanDocument;
    const flame = reconstructedFlames(doc)[0];
    const link = flameSequenceLink(flame)!;
    const payload = await encodeEmbedded(FlameSequence.unpack(await gunzip(FVS)));
    const html = embedPlanInHtml(BOOT, serializePlan(doc), 'Shared', new Map([[embeddedFlameKey(flame.id, link.id), payload]]));
    const embedded = /<script[^>]*id="embedded-plan"[^>]*>\n([\s\S]*?)\n<\/script>/.exec(html)![1];
    expect(embedded).toContain('"embedded":');
    // The raw page copy is not a valid plan: `embedded` is not a link field.
    expect(() => parseAndValidatePlan(embedded)).toThrow(/unsupported field/);
    const split = splitEmbeddedFlames(embedded);
    expect(split.flames.get(embeddedFlameKey(flame.id, link.id))).toBe(payload);
    const viewer = parseAndValidatePlan(split.text);
    expect(flameSequenceLink(reconstructedFlames(viewer)[0])!.path).toBe('voxels');
    expect(serializePlan(viewer)).not.toContain('embedded');
    // Text without payloads passes through untouched, JSON or not.
    expect(splitEmbeddedFlames(PLAN)).toEqual({ text: PLAN, flames: new Map() });
    expect(splitEmbeddedFlames('not json')).toEqual({ text: 'not json', flames: new Map() });
  });

  it('leaves a plan of the wrong shape for the load gate to reject, rather than throwing', () => {
    // This runs before validation, at module scope on a shared page: `objects`
    // that was a map threw "object is not iterable" and the page never built.
    for (const text of [
      JSON.stringify({ format: 'fire-test-plan', objects: {} }),
      JSON.stringify({ format: 'fire-test-plan', objects: 5 }),
      JSON.stringify({ format: 'fire-test-plan', objects: [null, 7, { linkedFiles: {} }, { linkedFiles: [null, 'x'] }] }),
      'null', '7', '"text"', '[]',
    ]) {
      expect(splitEmbeddedFlames(text)).toEqual({ text, flames: new Map() });
    }
  });

  it('strips directories from the folder path like any link', () => {
    const doc = JSON.parse(PLAN) as PlanDocument;
    flameSequenceLink(reconstructedFlames(doc)[0])!.path = 'D:/tests/run3/voxels';
    const html = embedPlanInHtml(BOOT, serializePlan(doc), 'Shared');
    expect(html).toContain('"path":"voxels"');
    expect(html).not.toContain('run3');
  });
});
