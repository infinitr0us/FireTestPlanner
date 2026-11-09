/**
 * Video and PNG export of the flame analysis board (docs/flame-analysis-board-design.md
 * section 7): a fixed 16:9 composition drawn for a slide, not a capture of the window,
 * encoded frame by frame with the browser engine's own H.264 encoder (WebCodecs) and
 * written as MP4 by `core/mp4.ts`. No ffmpeg, nothing to install.
 *
 * The composition uses the board's own data and the root palette: the pictures as the
 * board shows them (close-up or whole, outline on or off), the 3-D view from the
 * board's camera, and the board's plots redrawn on canvas with the same scales,
 * dashes, bands and key moments. Instants are held, never interpolated.
 */

import { instantAt, type EventImage, type HullProjection } from '../core/flame-analysis';
import { muxMp4, type Mp4Sample } from '../core/mp4';
import type { AnalysisScene } from '../scene/flame-analysis';
import { coverage, coverageCaption, drawOutline, hullSquares, placement, type PictureMode } from './flame-analysis-cameras';
import { colourOf, dashOf, qualityKey, type Band, type Moment, type PlotLine, type PlotSpec } from './flame-analysis-plots';
import * as i18n from './i18n';
import { fmt, niceTicks, runs, valueAt, valueExtent } from './plot-svg';

export type VideoLayout = 'board' | 'cameras' | 'plots';
export interface VideoOptions {
  layout: VideoLayout;
  /** 1920 (1920 x 1080) or 1280 (1280 x 720). */
  width: 1920 | 1280;
  /** Seconds on the test's time base; the video runs from `from` to `to`. */
  from: number;
  to: number;
  /** 1 is real time; 0.5 and 0.25 slow it down. */
  speed: number;
}
export const VIDEO_FPS = 30;

export interface CompositionSource {
  title: string;
  eventLabel: string;
  onset: number;
  timeBase: string;
  times: number[];
  cameras: { id: string; label: string; image: EventImage }[];
  pictureMode: PictureMode;
  /** Outlines per camera, or null when the board hides them. */
  outlines: Map<string, Float32Array[][]> | null;
  /** Coverage uses outlines even when the visible outline overlay is off. */
  coverageOutlines?: Map<string, Float32Array[][]>;
  outsideFrame: Record<string, number[]>;
  /** Transfers bitmap ownership to the composer, which closes it after the draw. */
  picture(camera: string, index: number): Promise<ImageBitmap>;
  /** The hull check (the 3-D flame through each camera), or null when the board hides it. */
  hull: ((camera: string, index: number) => HullProjection | null) | null;
  scene: AnalysisScene | null;
  plots: { specs: PlotSpec[]; bands: Band[]; moments: Moment[]; window: [number, number] };
}

interface Rect { x: number; y: number; w: number; h: number }
const W = 1920, H = 1080, M = 32, TOP = 104;

function layoutRects(layout: VideoLayout): { cameras?: Rect; scene?: Rect; plots?: Rect } {
  const left: Rect = { x: M, y: TOP, w: 1080, h: H - TOP - M };
  const right: Rect = { x: M + 1080 + 32, y: TOP, w: W - 2 * M - 1080 - 32, h: H - TOP - M };
  if (layout === 'cameras') {
    return { cameras: { x: M, y: TOP, w: W - 2 * M, h: 520 }, scene: { x: M, y: TOP + 540, w: W - 2 * M, h: H - TOP - 540 - M } };
  }
  if (layout === 'plots') return { scene: left, plots: right };
  return { cameras: { ...left, h: 420 }, scene: { ...left, y: TOP + 440, h: left.h - 440 }, plots: right };
}

function tokens() {
  const style = getComputedStyle(document.documentElement);
  const t = (name: string) => style.getPropertyValue(name).trim();
  return {
    bg: t('--bg'), panel: t('--bg-panel'), border: t('--border'), text: t('--text'), dim: t('--text-dim'),
    faint: t('--text-faint'), grid: t('--plot-grid'), cursor: t('--plot-cursor'), warn: t('--warn'),
    label: t('--bg-label'), primary: t('--plot-primary'), secondary: t('--plot-secondary'), font: t('--font'),
    planned: t('--plot-planned'), hull: t('--hull-check'),
  };
}
type Tokens = ReturnType<typeof tokens>;
/** `var(--plot-primary)` and friends, resolved for a canvas. */
const resolve = (colour: string, k: Tokens): string =>
  ({ 'var(--plot-secondary)': k.secondary, 'var(--plot-primary)': k.primary, 'var(--plot-planned)': k.planned } as Record<string, string>)[colour] ?? colour;
const dash = (pattern: string): number[] => (pattern ? pattern.split(/\s+/).map(Number) : []);

/** Draws the composition for an instant onto its own canvas. */
export class Composer {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private k = tokens();
  readonly scale: number;

  constructor(private source: CompositionSource, readonly layout: VideoLayout, width: 1920 | 1280) {
    this.scale = width / W;
    this.canvas.width = width;
    this.canvas.height = Math.round(H * this.scale);
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
  }

  private font(size: number, weight = 400): string { return `${weight} ${size}px ${this.k.font}`; }

  async draw(index: number): Promise<void> {
    const { ctx, k, source } = this;
    const rects = layoutRects(this.layout);
    const pictures = rects.cameras
      ? await Promise.all(source.cameras.map((c) => source.picture(c.id, index).catch(() => null)))
      : [];
    try {
      if (rects.scene && source.scene) await source.scene.prepareFrame(index);
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      ctx.fillStyle = k.panel;
      ctx.fillRect(0, 0, W, H);
      this.header(index);
      if (rects.cameras) this.cameras(rects.cameras, index, pictures);
      if (rects.scene) this.scene(rects.scene, index);
      if (rects.plots) this.plots(rects.plots, source.times[index]);
    } finally {
      for (const picture of pictures) picture?.close();
    }
  }

  private header(index: number): void {
    const { ctx, k, source } = this;
    const t = source.times[index], relative = t - source.onset;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = k.text;
    ctx.font = this.font(30, 600);
    ctx.fillText(source.title, M, 48, 1200);
    ctx.fillStyle = k.dim;
    ctx.font = this.font(20);
    const moment = latestMoment(source.plots.moments, t, source.plots.window);
    ctx.fillText(source.eventLabel + (moment ? `  ·  ${moment.label}` : ''), M, 80, 1200);
    ctx.textAlign = 'right';
    ctx.fillStyle = k.text;
    ctx.font = this.font(36, 600);
    ctx.fillText(i18n.t("{p1} s", { p1: `${relative > 0 ? '+' : ''}${i18n.formatNumber(relative, 1)}` }), W - M, 50);
    ctx.fillStyle = k.dim;
    ctx.font = this.font(18);
    ctx.fillText(i18n.t("from the onset · {p1} {p2} s", { p1: source.timeBase, p2: i18n.formatNumber(t, 2) }), W - M, 80);
  }

  private panel(r: Rect, title: string): Rect {
    const { ctx, k } = this;
    ctx.fillStyle = k.bg;
    ctx.strokeStyle = k.border;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = k.text;
    ctx.font = this.font(18, 600);
    ctx.textAlign = 'left';
    ctx.fillText(title, r.x + 14, r.y + 28);
    return { x: r.x + 12, y: r.y + 40, w: r.w - 24, h: r.h - 52 };
  }

  private cameras(r: Rect, index: number, pictures: (ImageBitmap | null)[]): void {
    const { ctx, k, source } = this;
    const inner = this.panel(r, i18n.t("Cameras"));
    const caption = source.hull ? 68 : 46, gap = 12;
    const aspects = source.cameras.map((c) => { const p = placement(c.image, source.pictureMode); return p.width / p.height; });
    let height = inner.h - caption;
    const total = aspects.reduce((a, b) => a + b, 0);
    if (total * height + gap * (aspects.length - 1) > inner.w) height = (inner.w - gap * (aspects.length - 1)) / total;
    let x = inner.x + (inner.w - (total * height + gap * (aspects.length - 1))) / 2;
    source.cameras.forEach((camera, n) => {
      const w = aspects[n] * height;
      const bitmap = pictures[n];
      ctx.fillStyle = k.panel;
      ctx.fillRect(x, inner.y, w, height);
      if (bitmap) {
        ctx.drawImage(bitmap, x, inner.y, w, height);
        const projection = source.hull?.(camera.id, index);
        if (projection?.uv.length) this.hull(projection, placement(camera.image, source.pictureMode), x, inner.y, w, height);
        const rings = source.outlines?.get(camera.id)?.[index];
        if (rings?.length) {
          const place = placement(camera.image, source.pictureMode);
          ctx.save();
          ctx.translate(x, inner.y);
          drawOutline(ctx, rings, place, w / place.width, 2.5);
          ctx.restore();
        }
      } else {
        ctx.fillStyle = k.text;
        ctx.font = this.font(18, 600);
        ctx.textAlign = 'center';
        ctx.fillText(i18n.t("Picture missing"), x + w / 2, inner.y + height / 2, w - 12);
      }
      ctx.fillStyle = k.dim;
      ctx.font = this.font(16);
      ctx.textAlign = 'left';
      ctx.fillText(camera.label, x, inner.y + height + 19, w);
      if (source.outsideFrame[camera.id]?.includes(index)) {
        ctx.fillStyle = k.warn;
        ctx.fillText(i18n.t("flame at the picture's edge"), x, inner.y + height + 39, w);
      }
      if (source.hull) {
        const projection = source.hull(camera.id, index);
        const rings = (source.coverageOutlines ?? source.outlines)?.get(camera.id)?.[index] ?? [];
        ctx.fillStyle = k.dim;
        ctx.fillText(coverageCaption(projection ? coverage(rings, projection) : null), x, inner.y + height + 59, w);
      }
      x += w + gap;
    });
  }

  /** The hull check over one picture: drawn opaque on a scratch canvas at the
   *  output's pixel size, then laid over at 50 % as on the board. */
  private hull(projection: HullProjection, place: ReturnType<typeof placement>, x: number, y: number, w: number, h: number): void {
    const pw = Math.max(1, Math.round(w * this.scale)), ph = Math.max(1, Math.round(h * this.scale));
    this.scratch ??= document.createElement('canvas');
    this.scratch.width = pw;
    this.scratch.height = ph;
    const g = this.scratch.getContext('2d')!;
    g.fillStyle = this.k.hull;
    hullSquares(g, projection, place, pw / place.width);
    this.ctx.save();
    this.ctx.globalAlpha = 0.5;
    this.ctx.drawImage(this.scratch, x, y, w, h);
    this.ctx.restore();
  }
  private scratch?: HTMLCanvasElement;

  private scene(r: Rect, index: number): void {
    const { ctx, k, source } = this;
    const inner = this.panel(r, i18n.t("3-D flame in the site"));
    const scene = source.scene;
    if (!scene) return;
    scene.setFrame(index);
    const pw = Math.round(inner.w * this.scale), ph = Math.round(inner.h * this.scale);
    const rendered = scene.renderTo(pw, ph);
    ctx.drawImage(rendered, inner.x, inner.y, inner.w, inner.h);
    ctx.font = this.font(14);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const label of scene.labelsAt(pw, ph)) {
      const x = inner.x + label.x / this.scale, y = inner.y + label.y / this.scale - 16;
      const w = ctx.measureText(label.text).width + 14;
      ctx.fillStyle = k.label;
      ctx.strokeStyle = k.border;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - 11, w, 22, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = k.text;
      ctx.fillText(label.text, x - w / 2 + 7, y + 1);
    }
    ctx.textBaseline = 'alphabetic';
  }

  private plots(r: Rect, time: number): void {
    const { specs, bands, moments, window } = this.source.plots;
    const inner = this.panel(r, i18n.t("Plots"));
    if (!specs.length) return;
    const keys = (['noHull', 'outsideFrame'] as const).filter((kind) => bands.some((b) => b.kind === kind));
    const reserved = keys.length * 24 + (keys.length ? 8 : 0);
    const each = (inner.h - reserved) / specs.length;
    specs.forEach((spec, n) => this.plot({ x: inner.x, y: inner.y + n * each, w: inner.w, h: each - 8 }, spec, bands, moments,
      window, time, n === 0, n === specs.length - 1));
    const { ctx } = this;
    keys.forEach((kind, n) => {
      const key = qualityKey(kind), y = inner.y + inner.h - reserved + 12 + n * 24;
      const colour = getComputedStyle(document.documentElement).getPropertyValue(key.token).trim();
      ctx.fillStyle = colour;
      ctx.globalAlpha = kind === 'noHull' ? 0.4 : 0.45;
      ctx.fillRect(inner.x, y - 10, 16, 14);
      ctx.globalAlpha = 1;
      ctx.font = this.font(14); ctx.textAlign = 'left'; ctx.fillStyle = this.k.dim;
      ctx.fillText(key.text, inner.x + 24, y + 2, inner.w - 24);
    });
  }

  private plot(r: Rect, spec: PlotSpec, bands: Band[], moments: Moment[], window: [number, number], time: number,
    first: boolean, last: boolean): void {
    const { ctx, k, source } = this;
    const scale = spec.scale ?? 1;
    const [t0, t1] = window;
    // Title and the legend, which reads the values at the playback time.
    ctx.textAlign = 'left';
    ctx.fillStyle = k.text;
    ctx.font = this.font(16, 600);
    ctx.fillText(`${spec.title} (${spec.unit})`, r.x, r.y + 16);
    let lx = r.x, ly = r.y + 38;
    ctx.font = this.font(14);
    for (const line of spec.lines) {
      const value = valueAt(line.t, line.v, time);
      const text = `${line.label}  ${value === null || !Number.isFinite(value) ? '–' : fmt(value * scale)}`;
      const width = 30 + ctx.measureText(text).width + 18;
      if (lx + width > r.x + r.w && lx > r.x) { lx = r.x; ly += 20; }
      this.lineStyle(line);
      ctx.beginPath(); ctx.moveTo(lx, ly - 5); ctx.lineTo(lx + 24, ly - 5); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = k.dim;
      ctx.fillText(text, lx + 30, ly);
      lx += width;
    }
    const X0 = r.x + 58, X1 = r.x + r.w - 8, Y0 = ly + 12, Y1 = r.y + r.h - (last ? 36 : 8);
    if (Y1 - Y0 < 30) return;
    const x = (t: number) => X0 + ((t - t0) / Math.max(t1 - t0, 1e-9)) * (X1 - X0);
    let hi = -Infinity, lo = 0;
    for (const line of spec.lines) for (let i = 0; i < line.t.length; i++) {
      if (line.t[i] < t0 || line.t[i] > t1 || !Number.isFinite(line.v[i])) continue;
      hi = Math.max(hi, line.v[i] * scale); lo = Math.min(lo, line.v[i] * scale);
    }
    const extent = valueExtent(lo, Number.isFinite(hi) ? hi : 1, Math.max(2, Math.round((Y1 - Y0) / 34)));
    const y = (v: number) => Y1 - ((v - extent.lo) / Math.max(extent.hi - extent.lo, 1e-12)) * (Y1 - Y0);
    for (const band of bands) {
      const a = Math.max(x(band.from), X0), b = Math.min(x(band.to), X1);
      if (b <= a) continue;
      ctx.fillStyle = band.kind === 'noHull' ? k.warn : k.dim;
      ctx.globalAlpha = band.kind === 'noHull' ? 0.16 : 0.2;
      ctx.fillRect(a, Y0, Math.max(b - a, 2), Y1 - Y0);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = k.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = k.dim;
    ctx.font = this.font(13);
    ctx.textAlign = 'right';
    for (const tick of extent.ticks) {
      ctx.beginPath(); ctx.moveTo(X0, y(tick)); ctx.lineTo(X1, y(tick)); ctx.stroke();
      ctx.fillText(fmt(tick), X0 - 6, y(tick) + 4);
    }
    ctx.textAlign = 'center';
    for (const tick of niceTicks(t0 - source.onset, t1 - source.onset, Math.max(3, Math.round((X1 - X0) / 90)))) {
      const px = x(tick + source.onset);
      ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(px, Y0); ctx.lineTo(px, Y1); ctx.stroke();
      ctx.globalAlpha = 1;
      if (last) ctx.fillText((tick > 0 ? '+' : '') + fmt(tick), px, Y1 + 17);
    }
    if (last) { ctx.textAlign = 'right'; ctx.fillText(i18n.t("Time from the onset (s)"), X1, Y1 + 34); }
    const marks = moments.some((m) => Math.abs(m.t - source.onset) < 1e-6) ? moments : [{ t: source.onset, label: i18n.t("Onset") }, ...moments];
    ctx.strokeStyle = k.faint;
    ctx.setLineDash([2, 4]);
    let labelEnd = -Infinity, row = 0;
    for (const m of [...marks].sort((a, b) => a.t - b.t)) {
      if (m.t < t0 || m.t > t1) continue;
      const px = x(m.t);
      ctx.beginPath(); ctx.moveTo(px, Y0); ctx.lineTo(px, Y1); ctx.stroke();
      if (first) {
        ctx.fillStyle = k.dim;
        ctx.font = this.font(12);
        // Right of its line, or left of it where it would run past the plot's edge.
        const width = ctx.measureText(m.label).width, before = px + 4 + width > X1;
        const start = before ? px - 4 - width : px + 4;
        row = start < labelEnd ? row + 1 : 0;
        ctx.textAlign = before ? 'right' : 'left';
        ctx.fillText(m.label, before ? px - 4 : px + 4, Y0 + 12 + row * 14);
        labelEnd = start + width + 4;
      }
    }
    ctx.setLineDash([]);
    ctx.save();
    ctx.beginPath(); ctx.rect(X0 - 2, Y0 - 2, X1 - X0 + 4, Y1 - Y0 + 4); ctx.clip();
    for (const line of spec.lines) {
      this.lineStyle(line);
      ctx.beginPath();
      for (const [a, b] of runs(line.t)) {
        let pen = false;
        for (let i = a; i < b; i++) {
          if (line.t[i] < t0 - 1 || line.t[i] > t1 + 1 || !Number.isFinite(line.v[i])) { pen = false; continue; }
          if (pen) ctx.lineTo(x(line.t[i]), y(line.v[i] * scale)); else ctx.moveTo(x(line.t[i]), y(line.v[i] * scale));
          pen = true;
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.strokeStyle = k.cursor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x(time), Y0); ctx.lineTo(x(time), Y1); ctx.stroke();
    ctx.setLineDash([]);
  }

  private lineStyle(line: PlotLine): void {
    const { ctx, k } = this;
    ctx.strokeStyle = resolve(colourOf(line), k);
    ctx.lineWidth = line.thin ? 1 : line.role === 'measured' || line.role === 'reconstructed' ? 2.5 : 2;
    ctx.globalAlpha = line.thin ? 0.5 : 1;
    ctx.setLineDash(dash(dashOf(line)).map((d) => d * 1.4));
    ctx.lineJoin = 'round';
  }
}

/** An H.264 codec string the engine encodes at this size, best profile first. */
async function pickCodec(width: number, height: number, bitrate: number): Promise<string> {
  if (typeof VideoEncoder === 'undefined') throw new Error(i18n.t("This browser engine cannot encode video (no WebCodecs)."));
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.420028']) {
    const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: VIDEO_FPS, avc: { format: 'avc' } });
    if (supported) return codec;
  }
  throw new Error(i18n.t("This browser engine cannot encode H.264 video at {p1} x {p2}.", { p1: width, p2: height }));
}

/** The instants a video shows, one per output frame. */
export function videoFrames(times: number[], options: Pick<VideoOptions, 'from' | 'to' | 'speed'>): number[] {
  const duration = Math.max(0, (options.to - options.from) / options.speed);
  const count = Math.max(1, Math.round(duration * VIDEO_FPS) + 1);
  return Array.from({ length: count }, (_, k) => Math.max(0,
    instantAt(times, (k === count - 1 ? options.to : options.from + (k / VIDEO_FPS) * options.speed) + 1e-6)));
}

export function latestMoment(moments: Moment[], t: number, window: [number, number]): Moment | undefined {
  return moments.filter((m) => m.t >= window[0] && m.t <= window[1] && m.t <= t && t - m.t < 1.5)
    .reduce<Moment | undefined>((best, m) => !best || m.t > best.t ? m : best, undefined);
}

export function checkExportSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException(i18n.t("The export was cancelled."), 'AbortError');
}

/**
 * Encode the composition from `from` to `to` as an MP4. Each instant is drawn once
 * and held for as many frames as the speed gives it.
 */
export async function encodeVideo(
  composer: Composer, times: number[], options: VideoOptions,
  progress: (done: number, total: number) => void, signal?: AbortSignal,
): Promise<Uint8Array> {
  const { width, height } = composer.canvas;
  const bitrate = width >= 1920 ? 10_000_000 : 5_000_000;
  const codec = await pickCodec(width, height, bitrate);
  checkExportSignal(signal);
  const frames = videoFrames(times, options);
  const samples: Mp4Sample[] = [];
  let avcC: Uint8Array | null = null;
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (samples.length && chunk.timestamp <= samples[samples.length - 1].timestamp_us) {
        failure = new Error(i18n.t("The video encoder reordered frames. This export cannot be written as a playable MP4."));
        return;
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, timestamp_us: chunk.timestamp, key: chunk.type === 'key' });
      const description = meta?.decoderConfig?.description;
      if (description && !avcC) {
        avcC = description instanceof ArrayBuffer ? new Uint8Array(description.slice(0))
          : new Uint8Array((description as ArrayBufferView).buffer.slice((description as ArrayBufferView).byteOffset,
            (description as ArrayBufferView).byteOffset + (description as ArrayBufferView).byteLength));
      }
    },
    error: (e) => { failure = e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure({ codec, width, height, bitrate, framerate: VIDEO_FPS, avc: { format: 'avc' }, latencyMode: 'quality' });
  try {
    let drawn = -1;
    for (let k = 0; k < frames.length; k++) {
      checkExportSignal(signal);
      if (failure) throw failure;
      if (frames[k] !== drawn) { await composer.draw(frames[k]); drawn = frames[k]; }
      checkExportSignal(signal);
      const frame = new VideoFrame(composer.canvas, { timestamp: Math.round((k * 1e6) / VIDEO_FPS), duration: Math.round(1e6 / VIDEO_FPS) });
      encoder.encode(frame, { keyFrame: k % (2 * VIDEO_FPS) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6) {
        await new Promise((r) => setTimeout(r, 2));
        checkExportSignal(signal);
        if (failure) throw failure;
      }
      progress(k + 1, frames.length);
    }
    await encoder.flush();
    checkExportSignal(signal);
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw failure;
  if (!avcC) throw new Error(i18n.t("The video encoder gave no decoder configuration."));
  const bytes = muxMp4({ width, height, avcC, fps: VIDEO_FPS, samples });
  checkExportSignal(signal);
  return bytes;
}

export async function encodePng(composer: Composer, index: number, signal?: AbortSignal): Promise<Blob> {
  checkExportSignal(signal);
  await composer.draw(index);
  checkExportSignal(signal);
  const blob = await new Promise<Blob>((resolve, reject) => composer.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG'))), 'image/png'));
  checkExportSignal(signal);
  return blob;
}
