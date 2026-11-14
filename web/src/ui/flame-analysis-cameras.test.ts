import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraTiles, packTiles, placement } from './flame-analysis-cameras';
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
  it('keeps the pictures on screen when what is read ahead outgrows the cache', async () => {
    const { w, made } = many(8);
    w.show(0);
    // Two rounds of reading ahead before anything is drawn: 8 + 40 + 40 pictures for a cache of 48.
    w.prefetch([1, 2, 3, 4, 5]); w.prefetch([6, 7, 8, 9, 10]);
    await settle();
    const shown = made.filter((b) => b.path.endsWith('/s0'));
    expect(shown).toHaveLength(8);
    expect(shown.every((b) => b.close.mock.calls.length === 0)).toBe(true);
    expect(([...w.tiles.values()] as any[]).map((t) => t.drawn)).toEqual(new Array(8).fill(0));
    expect(w.cache.size).toBeLessThanOrEqual(48);
    // The pictures read first, and no longer wanted, made room.
    expect(made.filter((b) => b.path.endsWith('/s1')).every((b) => b.close.mock.calls.length === 1)).toBe(true);
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
  const ELLIPSIS = '3-D flame covers … of the outline', UNAVAILABLE = '3-D flame coverage unavailable';
  it('is not measured while the clock moves on, only once a picture has rested 120 ms', async () => {
    vi.useFakeTimers();
    try {
      const { w, tile } = tiles(), hull = vi.fn(() => null);
      w.bitmap = () => Promise.resolve({ width: 80, height: 40 });
      w.setHullCheck(hull);
      const share = vi.spyOn(w, 'coverageAt');
      w.show(0); await settle();
      expect(tile.agreement.textContent).toBe(ELLIPSIS); // the caption holds its place
      await vi.advanceTimersByTimeAsync(100);
      w.show(1); await settle(); // the clock moved on within the delay: the wait starts again
      await vi.advanceTimersByTimeAsync(119);
      expect(share).not.toHaveBeenCalled();
      expect(tile.agreement.textContent).toBe(ELLIPSIS);
      await vi.advanceTimersByTimeAsync(1);
      expect(share).toHaveBeenCalledExactlyOnceWith('C', 1);
      expect(tile.agreement.textContent).toBe(UNAVAILABLE);
      // Known now: shown at once when the instant comes round again.
      share.mockClear();
      w.show(0); await settle(); w.show(1); await settle();
      expect(tile.agreement.textContent).toBe(UNAVAILABLE);
      expect(share).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('settles the caption of a held picture when the next picture never arrives', async () => {
    vi.useFakeTimers();
    try {
      const { w, tile } = tiles();
      w.bitmap = (path: string) => path.endsWith('/a') ? Promise.resolve({ width: 80, height: 40 }) : Promise.reject(new Error('Missing file'));
      w.setHullCheck(() => null);
      w.show(0); await settle();
      await vi.advanceTimersByTimeAsync(50);
      w.show(1); await settle(); // the next picture fails within the delay
      await vi.advanceTimersByTimeAsync(500);
      expect(tile.drawn).toBe(0);
      expect(tile.caption.textContent).toContain('Missing file'); // which picture is held, and why
      expect(tile.agreement.textContent).toBe(UNAVAILABLE); // not an ellipsis for good
    } finally { vi.useRealTimers(); }
  });
  it('measures nothing after the tiles are gone', async () => {
    vi.useFakeTimers();
    try {
      const { w } = tiles();
      w.bitmap = () => Promise.resolve({ width: 80, height: 40 });
      w.setHullCheck(() => null);
      const share = vi.spyOn(w, 'coverageAt');
      w.show(0); await settle();
      w.dispose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(share).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

describe('pictures in rows of one height (the board without its plots)', () => {
  // The first delivery's close-ups: three at 3:4 and a wider one third.
  const four = [0.75, 0.75, 0.907, 0.75];
  it('puts four portrait pictures two and two where the height allows, with the column only as wide as the rows', () => {
    const fit = packTiles(four, 1000, 774, 20, 6);
    expect(fit.perRow).toBe(2);
    expect(fit.height).toBe(364); // (774 - 6) / 2 - 20, the height binds
    expect(fit.width).toBe(Math.ceil((0.907 + 0.75) * 364 + 6)); // the second row is the wider
  });
  it('keeps one row on a low screen, where two rows would make the pictures smaller', () => {
    const fit = packTiles(four, 650, 394, 20, 6);
    expect(fit.perRow).toBe(4);
    expect(fit.height).toBe(Math.floor((650 - 18) / 3.157));
  });
  it('balances the rows, leaves the last one shorter, and handles one picture', () => {
    expect(packTiles([1, 1, 1], 300, 1000, 0, 0).perRow).toBe(1);
    expect(packTiles([0.75, 0.75, 0.75], 500, 700, 20, 6).perRow).toBe(2);
    const one = packTiles([1.5], 600, 300, 20, 6);
    expect([one.perRow, one.height, one.width]).toEqual([1, 280, 420]);
    expect(packTiles([], 600, 300, 20, 6).height).toBe(0);
  });
});
