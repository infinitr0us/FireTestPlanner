import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraTiles, placement } from './flame-analysis-cameras';
import { deferred, fakeDocument, settle } from './flame-analysis-test-support';
import type { EventManifest } from '../core/flame-analysis';

afterEach(() => vi.unstubAllGlobals());
function tiles() {
  fakeDocument();
  const event = {
    onset_s: 0, cameras: ['C'], instants: { t_s: [0, 1], stem: ['a', 'b'] },
    files: { display: 'whole/{cam}/{stem}', closeup: 'crop/{cam}/{stem}' },
    images: { C: { size_px: [200, 100], display_px: [100, 50], closeup: { rect_px: [20, 10, 40, 20], display_px: [80, 40] } } },
    quality: { outsideFrame: { C: [1] } },
  } as unknown as EventManifest;
  const source: any = { blob: vi.fn(async () => new Blob()) };
  const w: any = new CameraTiles(source, event, '', [{ id: 'C', label: 'Camera C' }], new Map(), () => {});
  return { w, tile: w.tiles.get('C'), event, source };
}
describe('camera draw ownership (B8, B9, reviewer R3/R4)', () => {
  it.each([true, false])('accepts only the current mode/path in either completion order: crop first %s', async (cropFirst) => {
    const { w, tile, event } = tiles(), crop = deferred(), whole = deferred();
    const cropped = { width: 80, height: 40 }, full = { width: 100, height: 50 };
    w.bitmap = (path: string) => path.startsWith('crop') ? crop.promise : whole.promise;
    const draw = vi.spyOn(w, 'draw');
    w.show(0); w.setMode('whole');
    if (cropFirst) { crop.resolve(cropped); await settle(); whole.resolve(full); }
    else { whole.resolve(full); await settle(); crop.resolve(cropped); }
    await settle();
    expect(draw).toHaveBeenCalledExactlyOnceWith('C', 0, full, placement(event.images.C, 'whole'));
    expect(tile.drawnPath).toBe('whole/C/a');
    expect(tile.canvas.width).toBe(100);
  });
  it('keeps actual drawn time and edge flag while loading, then updates them atomically', async () => {
    const { w, tile } = tiles(), next = deferred();
    w.bitmap = (path: string) => path.endsWith('/a') ? Promise.resolve({ width: 80, height: 40 }) : next.promise;
    w.show(0); await settle();
    w.show(1);
    expect(tile.drawn).toBe(0);
    expect(tile.canvas.getAttribute('aria-label')).toBe('Camera C at 0.0 s from the onset');
    expect(tile.flag.textContent).toBe('');
    expect(tile.caption.textContent).toContain('0.0 s'); expect(tile.caption.textContent).toContain('loading');
    next.resolve({ width: 80, height: 40 }); await settle();
    expect(tile.canvas.getAttribute('aria-label')).toBe('Camera C at 1.0 s from the onset');
    expect(tile.flag.textContent).toBe("flame at the picture's edge");
    expect(tile.caption.textContent).toBe('Camera C'); // the readout gives a current picture's time
  });
  it('does not show an obsolete read failure over the currently drawn picture', async () => {
    const { w, tile } = tiles(), old = deferred();
    w.bitmap = (path: string) => path.endsWith('/a') ? old.promise : Promise.resolve({ width: 80, height: 40 });
    w.show(0); w.show(1); await settle(); old.reject(new Error('old path')); await settle();
    expect(tile.caption.textContent).not.toContain('old path');
    expect(tile.drawn).toBe(1);
  });
  it('export bitmaps belong to their caller and survive tile disposal (B10)', async () => {
    const { w } = tiles(), bitmap = { close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const exported = await w.picture('C', 0, 'whole');
    w.dispose(); w.dispose();
    expect(exported).toBe(bitmap); expect(bitmap.close).not.toHaveBeenCalled();
    exported.close(); expect(bitmap.close).toHaveBeenCalledOnce();
  });
});

describe('the picture cache with many cameras', () => {
  function many(count: number) {
    fakeDocument();
    const cameras = Array.from({ length: count }, (_, i) => ({ id: `C${i}`, label: `Camera ${i}` }));
    const event = {
      onset_s: 0, cameras: cameras.map((c) => c.id),
      instants: { t_s: Array.from({ length: 12 }, (_, i) => i / 10), stem: Array.from({ length: 12 }, (_, i) => `s${i}`) },
      files: { display: 'whole/{cam}/{stem}' },
      images: Object.fromEntries(cameras.map((c) => [c.id, { size_px: [200, 100], display_px: [100, 50] }])),
    } as unknown as EventManifest;
    const made: { path: string; close: ReturnType<typeof vi.fn> }[] = [];
    const source: any = { blob: async (path: string) => ({ path }) };
    vi.stubGlobal('createImageBitmap', async (blob: { path: string }) => {
      const bitmap = { width: 100, height: 50, path: blob.path, close: vi.fn() };
      made.push(bitmap);
      return bitmap;
    });
    const w: any = new CameraTiles(source, event, '', cameras, new Map(), () => {});
    return { w, made, cameras };
  }
  // The board shows an instant and reads the next eight ahead in the same turn.
  it.each([4, 6, 8])('%s cameras: every tile draws the instant on screen while the clock reads ahead', async (count) => {
    const { w, made } = many(count);
    for (const index of [0, 1, 2, 3]) {
      w.show(index);
      w.prefetch(Array.from({ length: 8 }, (_, k) => index + k + 1));
      await settle();
      const tiles = [...w.tiles.values()] as any[];
      expect(tiles.map((t) => t.drawn)).toEqual(new Array(count).fill(index));
      expect(tiles.every((t) => !t.caption.textContent.includes('·'))).toBe(true); // no loading or error marker left
      const shown = made.filter((b) => b.path.endsWith(`/s${index}`));
      expect(shown).toHaveLength(count);
      expect(shown.every((b) => b.close.mock.calls.length === 0)).toBe(true);
    }
    expect(w.cache.size).toBeLessThanOrEqual(48);
  });
  it('reads less far ahead with more cameras, so the cache holds what is on screen and what comes next', async () => {
    const { w, made } = many(8);
    w.show(0); w.prefetch([1, 2, 3, 4, 5, 6, 7, 8]); await settle();
    expect(new Set(made.map((b) => b.path.split('/').pop())).size).toBe(6); // the instant shown and five ahead
  });
});

describe('the hull check share', () => {
  it('is worked out once per camera and instant, and again for another projection', () => {
    const { w } = tiles(), first = vi.fn(() => ({ uv: new Float32Array(0), size: 0 })), second = vi.fn(() => null);
    w.setHullCheck(first);
    first.mockClear(); // setting it redraws nothing yet: no instant is shown
    expect(w.coverageAt('C', 0)).toBeNull(); // no outline at this instant
    w.coverageAt('C', 0); w.coverageAt('C', 1); w.coverageAt('C', 1);
    expect(first).toHaveBeenCalledTimes(2);
    w.setHullCheck(second);
    w.coverageAt('C', 0);
    expect(second).toHaveBeenCalledOnce();
    w.setHullCheck(null);
    expect(w.coverageAt('C', 0)).toBeNull();
  });
});
