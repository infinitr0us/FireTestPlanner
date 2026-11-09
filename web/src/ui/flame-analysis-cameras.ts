/**
 * The camera tiles of the flame analysis board: each camera's picture at the
 * playback time, as a close-up around the flame or the whole picture, with the
 * flame outline drawn over it on request.
 *
 * Pictures are decoded off the main thread (`createImageBitmap`) into a small
 * cache. A tile keeps its last picture until the next one is decoded, so playback
 * never flashes an empty tile; it shows which instant it holds in its caption.
 */

import {
  fillTemplate, joinPath, type EventImage, type EventManifest, type HullProjection,
} from '../core/flame-analysis';
import type { AnalysisSource } from '../io/flame-analysis-source';
import { h } from './dom';
import * as i18n from './i18n';

export type PictureMode = 'closeup' | 'whole';
export interface TileCamera { id: string; label: string }

const CACHE_LIMIT = 48;

/** Where a picture's pixels sit in the full-resolution frame. */
interface Placement { x: number; y: number; scale: number; width: number; height: number }

export function placement(image: EventImage, mode: PictureMode): Placement {
  if (mode === 'closeup' && image.closeup) {
    const [x, y, w] = image.closeup.rect_px;
    const [dw, dh] = image.closeup.display_px;
    return { x, y, scale: dw / w, width: dw, height: dh };
  }
  const [dw, dh] = image.display_px;
  return { x: 0, y: 0, scale: dw / image.size_px[0], width: dw, height: dh };
}

export class CameraTiles {
  readonly element = h('div', { class: 'flame-analysis__tiles' });
  private tiles = new Map<string, { figure: HTMLElement; canvas: HTMLCanvasElement; caption: HTMLElement; flag: HTMLElement; agreement: HTMLElement; drawn: number }>();
  private cache = new Map<string, Promise<ImageBitmap>>();
  private bitmaps = new Map<string, ImageBitmap>();
  private index = -1;
  private mode: PictureMode;
  private outlinesShown = false;
  private hull: ((camera: string, index: number) => HullProjection | null) | null = null;
  private disposed = false;

  constructor(
    private source: AnalysisSource,
    private event: EventManifest,
    private folder: string,
    private cameras: TileCamera[],
    private outlines: Map<string, Float32Array[][]>,
    private onOpen: (camera: string) => void,
  ) {
    this.mode = cameras.every((c) => event.images[c.id]?.closeup) ? 'closeup' : 'whole';
    for (const camera of cameras) {
      const canvas = h('canvas', { class: 'flame-analysis__picture', role: 'img' });
      const caption = h('span', { class: 'flame-analysis__tile-name' }, [camera.label]);
      const flag = h('span', { class: 'flame-analysis__tile-flag' });
      const agreement = h('span', { class: 'flame-analysis__tile-agreement' });
      const figure = h('figure', { class: 'flame-analysis__tile' }, [
        h('button', {
          type: 'button', class: 'flame-analysis__tile-open',
          title: i18n.t("Show {p1} at full resolution", { p1: camera.label }),
          'aria-label': i18n.t("Show {p1} at full resolution", { p1: camera.label }),
          onclick: () => this.onOpen(camera.id),
        }, [canvas]),
        h('figcaption', {}, [caption, agreement, flag]),
      ]);
      const image = event.images[camera.id];
      figure.style.setProperty('--tile-aspect', String(image.size_px[0] / image.size_px[1]));
      this.tiles.set(camera.id, { figure, canvas, caption, flag, agreement, drawn: -1 });
      this.element.append(figure);
    }
    this.element.dataset.count = String(cameras.length);
  }

  get pictureMode(): PictureMode { return this.mode; }
  get hasCloseups(): boolean { return this.cameras.every((c) => this.event.images[c.id]?.closeup); }

  setMode(mode: PictureMode): void {
    if (mode === 'closeup' && !this.hasCloseups) mode = 'whole';
    if (mode === this.mode) return;
    this.mode = mode;
    for (const tile of this.tiles.values()) tile.drawn = -1;
    this.show(this.index);
  }

  /** The hull check: the 3-D flame at an instant through a camera, or null to hide it. */
  setHullCheck(projection: ((camera: string, index: number) => HullProjection | null) | null): void {
    if (projection === this.hull) return;
    this.hull = projection;
    for (const tile of this.tiles.values()) { tile.drawn = -1; tile.agreement.textContent = ''; }
    this.show(this.index);
  }
  get hullCheckOn(): boolean { return this.hull !== null; }

  setOutlines(shown: boolean): void {
    if (shown === this.outlinesShown) return;
    this.outlinesShown = shown;
    for (const tile of this.tiles.values()) tile.drawn = -1;
    this.show(this.index);
  }

  /** The picture of a camera at an instant, as the current mode shows it. */
  private picturePath(camera: string, index: number, mode = this.mode): string {
    const template = mode === 'closeup' ? this.event.files.closeup! : this.event.files.display;
    return joinPath(this.folder, fillTemplate(template, camera, this.event.instants.stem[index]));
  }

  private bitmap(path: string): Promise<ImageBitmap> {
    let pending = this.cache.get(path);
    if (pending) {
      this.cache.delete(path); // most recently used last
      this.cache.set(path, pending);
      return pending;
    }
    pending = this.source.blob(path).then((blob) => createImageBitmap(blob)).then((bitmap) => {
      if (this.disposed || !this.cache.has(path)) { bitmap.close(); throw new Error('evicted'); }
      this.bitmaps.set(path, bitmap);
      return bitmap;
    });
    pending.catch(() => this.cache.delete(path));
    this.cache.set(path, pending);
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
      this.bitmaps.get(oldest)?.close();
      this.bitmaps.delete(oldest);
    }
    return pending;
  }

  /** Show instant `index`; pictures not decoded yet keep the tile's last picture. */
  show(index: number): void {
    this.index = index;
    if (index < 0) return;
    const t = this.event.instants.t_s[index] - this.event.onset_s;
    for (const camera of this.cameras) {
      const tile = this.tiles.get(camera.id)!;
      const outside = this.event.quality?.outsideFrame?.[camera.id]?.includes(index) ?? false;
      tile.flag.textContent = outside ? i18n.t("flame at the picture's edge") : '';
      tile.canvas.setAttribute('aria-label', i18n.t("{p1} at {p2} s from the onset", {
        p1: camera.label, p2: i18n.formatNumber(t, 1),
      }));
      const path = this.picturePath(camera.id, index);
      this.bitmap(path).then((bitmap) => {
        if (this.disposed || this.index !== index || tile.drawn === index) return;
        this.draw(camera.id, index, bitmap);
      }).catch((err: Error) => {
        if (err.message !== 'evicted' && !this.disposed) tile.flag.textContent = err.message;
      });
    }
  }

  /** Decode the pictures of the next instants ahead of the clock. */
  prefetch(indices: number[]): void {
    for (const i of indices) {
      if (i < 0 || i >= this.event.instants.stem.length) continue;
      for (const camera of this.cameras) void this.bitmap(this.picturePath(camera.id, i)).catch(() => undefined);
    }
  }

  private draw(camera: string, index: number, bitmap: ImageBitmap): void {
    const tile = this.tiles.get(camera)!;
    const image = this.event.images[camera];
    const place = placement(image, this.mode);
    const canvas = tile.canvas;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      tile.figure.style.setProperty('--tile-aspect', String(bitmap.width / bitmap.height));
    }
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const rings = this.outlines.get(camera)?.[index] ?? [];
    const projection = this.hull?.(camera, index) ?? null;
    if (projection) {
      drawHull(ctx, projection, place, bitmap.width / place.width);
      const share = coverage(rings, projection, place, bitmap.width / place.width, bitmap.width, bitmap.height);
      tile.agreement.textContent = share === null ? '' : i18n.t("3-D flame covers {p1} of the outline", { p1: i18n.formatQuantity(Math.round(share * 100), '%') });
    }
    if (this.outlinesShown) drawOutline(ctx, rings, place, bitmap.width / place.width, lineWidthFor(canvas));
    tile.drawn = index;
  }

  /** A camera's picture at any instant, as the tiles show it (close-up or whole),
   *  from the same cache: what a video frame or a PNG is composed from. */
  picture(camera: string, index: number): Promise<ImageBitmap> {
    return this.bitmap(this.picturePath(camera, index));
  }
  get outlinesOn(): boolean { return this.outlinesShown; }

  dispose(): void {
    this.disposed = true;
    for (const bitmap of this.bitmaps.values()) bitmap.close();
    this.bitmaps.clear();
    this.cache.clear();
    this.element.remove();
  }
}

/** About two screen pixels whatever the tile's size on screen. */
function lineWidthFor(canvas: HTMLCanvasElement): number {
  const shown = canvas.getBoundingClientRect().width;
  return shown > 0 ? Math.max(1, (2 * canvas.width) / shown) : 2;
}

/**
 * The flame outline over a picture: rings from full-resolution pixel coordinates
 * (pixel centres at integers) into this picture's pixels, filled even-odd with a
 * light tint and stroked. Colours are the `--flame-outline` token.
 */
export function drawOutline(
  ctx: CanvasRenderingContext2D, rings: Float32Array[], place: Placement, extra = 1, lineWidth = 2,
): void {
  if (!rings.length) return;
  const colour = getComputedStyle(document.documentElement).getPropertyValue('--flame-outline').trim();
  const k = place.scale * extra;
  const path = new Path2D();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = (ring[i] - place.x + 0.5) * k, y = (ring[i + 1] - place.y + 0.5) * k;
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
  }
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = colour;
  ctx.fill(path, 'evenodd');
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colour;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.stroke(path);
  ctx.restore();
}


/**
 * The hull check over a picture: every surface cell of the 3-D flame at that instant,
 * projected through the camera's calibrated model, drawn as a square of about one
 * cube's size in `--hull-check` at 50 % (one pass on a scratch canvas, so overlapping
 * cells do not darken). Where it agrees with the picture's flame, the two coincide.
 */
export function drawHull(ctx: CanvasRenderingContext2D, projection: HullProjection, place: Placement, extra = 1): void {
  if (!projection.uv.length) return;
  const { width, height } = ctx.canvas;
  const scratch = scratchCanvas(width, height);
  const g = scratch.getContext('2d')!;
  g.clearRect(0, 0, width, height);
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--hull-check').trim();
  hullSquares(g, projection, place, extra);
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

export function hullSquares(g: CanvasRenderingContext2D, projection: HullProjection, place: Placement, extra: number): void {
  const k = place.scale * extra;
  const side = Math.max(1.5, projection.size * k * 1.2);
  const { uv } = projection;
  for (let i = 0; i < uv.length; i += 2) {
    g.fillRect((uv[i] - place.x + 0.5) * k - side / 2, (uv[i + 1] - place.y + 0.5) * k - side / 2, side, side);
  }
}

let scratch: HTMLCanvasElement | null = null;
function scratchCanvas(width: number, height: number): HTMLCanvasElement {
  scratch ??= document.createElement('canvas');
  if (scratch.width !== width || scratch.height !== height) { scratch.width = width; scratch.height = height; }
  return scratch;
}

/**
 * How much of the camera's flame outline the 3-D flame covers in that picture: both
 * drawn on a small grid (at most 240 px wide), the outline even-odd, the hull as its
 * cells. Null when the outline is empty.
 */
export function coverage(rings: Float32Array[], projection: HullProjection, place: Placement, extra: number,
  width: number, height: number): number | null {
  if (!rings.length) return null;
  const f = Math.min(1, 240 / width);
  const w = Math.max(1, Math.round(width * f)), h = Math.max(1, Math.round(height * f));
  const grid = document.createElement('canvas');
  grid.width = w; grid.height = h;
  const g = grid.getContext('2d', { willReadFrequently: true })!;
  const k = place.scale * extra * f;
  const path = new Path2D();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = (ring[i] - place.x + 0.5) * k, y = (ring[i + 1] - place.y + 0.5) * k;
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
  }
  g.fillStyle = 'white'; // a mask, never shown
  g.fill(path, 'evenodd');
  const outline = g.getImageData(0, 0, w, h).data;
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'white'; // a mask, never shown
  hullSquares(g, projection, place, extra * f);
  const hull = g.getImageData(0, 0, w, h).data;
  let inside = 0, both = 0;
  for (let i = 3; i < outline.length; i += 4) {
    if (outline[i] > 127) { inside++; if (hull[i] > 127) both++; }
  }
  return inside ? both / inside : null;
}
