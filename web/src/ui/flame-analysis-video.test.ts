import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer, encodeVideo, latestMoment, videoFrames, type VideoOptions } from './flame-analysis-video';
import { deferred, fakeDocument, fakeEncoder, settle } from './flame-analysis-test-support';
import { qualityKey } from './flame-analysis-plots';
afterEach(() => vi.unstubAllGlobals());
const options: VideoOptions = { layout: 'board', width: 1280, from: 0, to: 0, speed: 1 };
const composer = (draw = async () => {}): any => ({ canvas: { width: 1280, height: 720 }, draw });

describe('video timing and encoder contract (B11, B13, B17, B20)', () => {
  it.each([1, 0.5, 0.25])('holds source instants at every 30 Hz output sample and includes the endpoint at x%s', (speed) => {
    for (const [times, from, to] of [[[0, 0.11, 0.2], 0, 0.11], [[0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], 0.3, 0.9]] as [number[], number, number][]) {
      const frames = videoFrames(times, { from, to, speed });
      expect(frames).toHaveLength(Math.round((to - from) / speed * 30) + 1);
      frames.forEach((index, k) => {
        const sourceTime = k === frames.length - 1 ? to : from + k / 30 * speed;
        expect(index).toBe(times.filter((t) => t <= sourceTime + 1e-6).length - 1);
      });
      expect(times[frames.at(-1)!]).toBe(to);
    }
  });
  it.each(['draw', 'flush'])('rejects cancellation during the last %s (reviewer R7)', async (stage) => {
    const stop = deferred<void>(), controller = new AbortController();
    const encoders = fakeEncoder({ flush: stage === 'flush' ? () => stop.promise : undefined });
    const pending = encodeVideo(composer(stage === 'draw' ? () => stop.promise : undefined), [0], options, () => {}, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await settle(); controller.abort(); stop.resolve(); await rejected;
    expect(encoders[0].state).toBe('closed');
    if (stage === 'draw') expect(encoders[0].timestamps).toEqual([]);
  });
  it('fails on reordered encoder output without sorting it (reviewer R8)', async () => {
    fakeEncoder({ order: [0, 2, 1] });
    await expect(encodeVideo(composer(), [0, 1], { ...options, to: 2 / 30 }, () => {})).rejects.toThrow('encoder reordered frames');
  });
  it('accepts presentation order and preserves k/30 timestamps', async () => {
    const encoders = fakeEncoder();
    const result = await encodeVideo(composer(), [0, 1], { ...options, to: 2 / 30 }, () => {});
    expect(result.byteLength).toBeGreaterThan(100);
    expect(encoders[0].timestamps).toEqual([0, 33333, 66667]);
  });
  it('names the greatest prior key moment regardless of file order, within the event and 1.5 s window', () => {
    const moments = [{ t: 1, label: 'later' }, { t: 0.5, label: 'earlier' }, { t: 5, label: 'future' }];
    expect(latestMoment(moments, 1.2, [0, 4])?.label).toBe('later');
    expect(latestMoment(moments, 2.5, [0, 4])).toBeUndefined();
    expect(latestMoment([{ t: -1, label: 'outside' }], 0, [0, 4])).toBeUndefined();
  });
});

describe('composition evidence (B10, B19)', () => {
  function drawing(): any {
    fakeDocument();
    const ctx: any = new Proxy({ fillText: vi.fn(), drawImage: vi.fn(), measureText: (s: string) => ({ width: s.length * 7 }) }, {
      get: (target: any, p) => p in target ? target[p] : () => {}, set: (target: any, p, v) => { target[p] = v; return true; },
    });
    return Object.assign(Object.create(Composer.prototype), { ctx, scale: 1, k: { dim: 'dim', panel: 'panel', text: 'text' },
      layout: 'board', source: { title: 'test', eventLabel: 'event', onset: 0, timeBase: 'clock', times: [0],
        cameras: [{ id: 'C', label: 'Camera C', image: { size_px: [200, 100], display_px: [100, 50] } }],
        pictureMode: 'whole', picture: async () => { throw new Error('missing'); }, hull: null, outsideFrame: {}, outlines: null, scene: null,
        plots: { specs: [], bands: [], moments: [], window: [0, 1] } },
    });
  }
  it('draws visible missing-picture text and keeps the camera caption (reviewer R9)', async () => {
    const c = drawing(); await c.draw(0);
    const text = c.ctx.fillText.mock.calls.map((a: any[]) => a[0]);
    expect(text).toContain('Picture missing'); expect(text).toContain('Camera C');
  });
  it.each([false, true])('keeps all owned bitmaps alive through the entire draw and closes on failure=%s', async (failure) => {
    const c = drawing(), wait = deferred<void>(), bitmap = { close: vi.fn() };
    c.source.picture = async () => bitmap;
    c.source.scene = { prepareFrame: () => wait.promise };
    c.scene = () => { expect(bitmap.close).not.toHaveBeenCalled(); if (failure) throw new Error('render'); };
    const pending = c.draw(0);
    const outcome = failure ? expect(pending).rejects.toThrow('render') : expect(pending).resolves.toBeUndefined();
    await settle(); expect(bitmap.close).not.toHaveBeenCalled(); wait.resolve(); await outcome;
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
  it.each([1280, 1920])('reserves text-key and camera-coverage space at %s', async (width) => {
    const c = drawing(); c.scale = width / 1920;
    c.source.hull = () => null;
    c.source.plots.bands = [{ kind: 'noHull', from: 0, to: 1 }, { kind: 'outsideFrame', from: 0, to: 1 }];
    c.source.plots.specs = [{ lines: [] }];
    c.plot = vi.fn();
    await c.draw(0);
    const text = c.ctx.fillText.mock.calls.map((a: any[]) => a[0]);
    expect(text).toContain(qualityKey('noHull').text); expect(text).toContain(qualityKey('outsideFrame').text);
    expect(text).toContain('3-D flame coverage unavailable');
    const plotBottom = c.plot.mock.calls[0][0].y + c.plot.mock.calls[0][0].h;
    const keyY = c.ctx.fillText.mock.calls.find((a: any[]) => a[0] === qualityKey('noHull').text)[2];
    expect(keyY).toBeGreaterThan(plotBottom);
  });
});
