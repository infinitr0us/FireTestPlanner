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
