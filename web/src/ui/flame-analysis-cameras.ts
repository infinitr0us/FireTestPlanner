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

/** Decoded pictures kept at once: the instant on screen and those ahead of the clock. */
const CACHE_LIMIT = 48;
/** How long a picture must stay on screen before its hull-check share is measured:
 *  longer than an instant at real time, so playback never pays for it. */
const SHARE_DELAY_MS = 120;

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

/** Pictures in rows of one height: the largest height at which pictures of these
 *  aspects (width / height, in display order) fit `width` x `height`, filling rows in
 *  order with the same number per row (the last may hold fewer). `caption` is the
 *  text under each row and `gap` the space between pictures and between rows.
 *  Returns that height, the widest row's width and the number per row. */
export function packTiles(aspects: number[], width: number, height: number, caption: number, gap: number): { height: number; width: number; perRow: number } {
  let best = { height: 0, width: 0, perRow: Math.max(aspects.length, 1) };
  for (let rows = 1; rows <= aspects.length; rows++) {
    // As even as the rows can be: four pictures in two rows go two and two.
    const perRow = Math.ceil(aspects.length / rows);
    if (Math.ceil(aspects.length / perRow) !== rows) continue; // that many rows cannot all hold a picture
    let h = (height - (rows - 1) * gap) / rows - caption;
    const sums: number[] = [];
    for (let r = 0; r < rows; r++) {
      const row = aspects.slice(r * perRow, (r + 1) * perRow);
      const sum = row.reduce((a, b) => a + b, 0);
      sums.push(sum);
      h = Math.min(h, (width - (row.length - 1) * gap) / sum);
    }
    h = Math.floor(h);
    if (h > best.height) {
      best = { height: h, perRow, width: Math.ceil(Math.max(...sums.map((s, r) => s * h + (Math.min(perRow, aspects.length - r * perRow) - 1) * gap))) };
    }
  }
  return best;
}

export class CameraTiles {
  readonly element = h('div', { class: 'flame-analysis__tiles' });
  private tiles = new Map<string, { figure: HTMLElement; canvas: HTMLCanvasElement; caption: HTMLElement; flag: HTMLElement; agreement: HTMLElement; drawn: number; drawnPath: string; dirty: boolean }>();
  private cache = new Map<string, Promise<ImageBitmap>>();
  private bitmaps = new Map<string, ImageBitmap>();
  /** The pictures of the instant on screen: never evicted, whatever is read ahead. */
  private pinned = new Set<string>();
  /** The hull check's share of the outline per camera and instant: it costs a mask
   *  each, and playback asks for the same ones again. */
  private shares = new Map<string, number | null>();
  private shareTimer: ReturnType<typeof setTimeout> | undefined;
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
          dataset: { camera: camera.id }, onclick: () => this.onOpen(camera.id),
        }, [canvas]),
        h('figcaption', {}, [caption, agreement, flag]),
      ]);
      const image = event.images[camera.id];
      figure.style.setProperty('--tile-aspect', String(image.size_px[0] / image.size_px[1]));
      this.tiles.set(camera.id, { figure, canvas, caption, flag, agreement, drawn: -1, drawnPath: '', dirty: true });
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
    for (const tile of this.tiles.values()) tile.dirty = true;
    this.show(this.index);
  }

  /** The hull check: the 3-D flame at an instant through a camera, or null to hide it. */
  setHullCheck(projection: ((camera: string, index: number) => HullProjection | null) | null): void {
    if (projection === this.hull) return;
    this.hull = projection;
    this.shares.clear();
    for (const tile of this.tiles.values()) tile.dirty = true;
    this.show(this.index);
  }
  get hullCheckOn(): boolean { return this.hull !== null; }

  setOutlines(shown: boolean): void {
    if (shown === this.outlinesShown) return;
    this.outlinesShown = shown;
    for (const tile of this.tiles.values()) tile.dirty = true;
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
      if (this.disposed || this.cache.get(path) !== pending) { bitmap.close(); throw new Error('evicted'); }
      this.bitmaps.set(path, bitmap);
      return bitmap;
    });
    void pending.catch(() => { if (this.cache.get(path) === pending) this.cache.delete(path); });
    this.cache.set(path, pending);
    while (this.cache.size > CACHE_LIMIT) {
      // The least recently used that is neither on screen nor the one just asked for.
      let oldest: string | undefined;
      for (const key of this.cache.keys()) if (key !== path && !this.pinned.has(key)) { oldest = key; break; }
      if (oldest === undefined) break;
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
    this.pinned = new Set(this.cameras.map((camera) => this.picturePath(camera.id, index)));
    for (const camera of this.cameras) {
      const tile = this.tiles.get(camera.id)!;
      const mode = this.mode;
      const path = this.picturePath(camera.id, index, mode);
      const place = placement(this.event.images[camera.id], mode);
      if (!tile.dirty && tile.drawnPath === path) continue;
      tile.caption.textContent = `${this.caption(camera, tile.drawn)} · ${i18n.t("loading")}`;
      this.bitmap(path).then((bitmap) => {
        if (this.disposed || this.index !== index || this.mode !== mode || this.picturePath(camera.id, this.index) !== path) return;
        if (!tile.dirty && tile.drawnPath === path) return;
        this.draw(camera.id, index, bitmap, place);
        tile.drawnPath = path;
        tile.dirty = false;
      }).catch((err: Error) => {
        if (err.message !== 'evicted' && !this.disposed && this.index === index && this.mode === mode) {
          tile.caption.textContent = `${this.caption(camera, tile.drawn)} · ${err.message}`;
        }
      });
    }
  }

  /** Decode the pictures of the next instants ahead of the clock: as many instants
   *  as the cache holds beside the one on screen, so more cameras read less far ahead. */
  prefetch(indices: number[]): void {
    const ahead = Math.max(1, Math.floor(CACHE_LIMIT / this.cameras.length) - 1);
    for (const i of indices.slice(0, ahead)) {
      if (i < 0 || i >= this.event.instants.stem.length) continue;
      for (const camera of this.cameras) void this.bitmap(this.picturePath(camera.id, i)).catch(() => undefined);
    }
  }

  /** Lay the pictures out in rows of one height, as large as `box` allows (the board
   *  without its plots), or back in the one shared row with null. Returns the width
   *  the rows take, for the column around them. */
  pack(box: { width: number; height: number } | null): number {
    const el = this.element;
    if (!box) {
      el.classList.remove('flame-analysis__tiles--packed');
      for (const name of ['--tile-h', '--tiles-w']) el.style.removeProperty(name);
      return 0;
    }
    const aspects = this.cameras.map((c) => { const p = placement(this.event.images[c.id], this.mode); return p.width / p.height; });
    // A caption's lines: the camera's name (with the edge flag beside it) and, with the
    // hull check, the coverage line; plus the figure's gap above them.
    const first = this.tiles.values().next().value?.figure.querySelector('figcaption');
    const line = Math.ceil(parseFloat(first ? getComputedStyle(first).fontSize : '11') * 1.4);
    const fit = packTiles(aspects, box.width, box.height, line * (this.hull ? 2 : 1) + 4, 6);
    el.classList.add('flame-analysis__tiles--packed');
    el.style.setProperty('--tile-h', `${fit.height}px`);
    el.style.setProperty('--tiles-w', `${fit.width + 1}px`);
    this.cameras.forEach((c, n) => this.tiles.get(c.id)!.figure.style.setProperty('--pack-aspect', String(aspects[n])));
    return fit.width;
  }

  private caption(camera: TileCamera, index: number): string {
    return index < 0 ? camera.label : i18n.t("{p1} at {p2} s from the onset", {
      p1: camera.label, p2: i18n.formatNumber(this.event.instants.t_s[index] - this.event.onset_s, 1),
    });
  }

  private draw(camera: string, index: number, bitmap: ImageBitmap, place: Placement): void {
    const tile = this.tiles.get(camera)!;
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
    }
    // A share already worked out is shown at once; a new one waits until the clock
    // rests on the instant, with a caption of the same length meanwhile.
    const known = this.shares.get(`${camera}/${index}`);
    if (!this.hull) tile.agreement.textContent = '';
    else if (known !== undefined) tile.agreement.textContent = coverageCaption(known);
    else {
      tile.agreement.textContent = i18n.t("3-D flame covers {p1} of the outline", { p1: '…' });
      this.measureSoon();
    }
    if (this.outlinesShown) drawOutline(ctx, rings, place, bitmap.width / place.width, lineWidthFor(canvas));
    tile.drawn = index;
    const named = this.cameras.find((c) => c.id === camera)!;
    tile.canvas.setAttribute('aria-label', this.caption(named, index));
    // The board's readout gives the time of a current picture; the caption names the
    // camera, and says which instant it holds only while a newer one is loading.
    tile.caption.textContent = named.label;
    tile.flag.textContent = this.event.quality?.outsideFrame?.[camera]?.includes(index) ? i18n.t("flame at the picture's edge") : '';
  }

  /** A camera's picture at any instant, as the tiles show it (close-up or whole),
   *  owned by the caller, which closes it after composing the frame. */
  picture(camera: string, index: number, mode = this.mode): Promise<ImageBitmap> {
    return this.source.blob(this.picturePath(camera, index, mode)).then((blob) => createImageBitmap(blob));
  }
  get outlinesOn(): boolean { return this.outlinesShown; }

  private measureSoon(): void {
    clearTimeout(this.shareTimer);
    this.shareTimer = setTimeout(() => {
      if (this.disposed || !this.hull) return;
      for (const camera of this.cameras) {
        const tile = this.tiles.get(camera.id)!;
        // The caption belongs to the picture on the tile, also when a newer one never arrived.
        if (tile.drawn >= 0) tile.agreement.textContent = coverageCaption(this.coverageAt(camera.id, tile.drawn));
      }
    }, SHARE_DELAY_MS);
  }

  /** How much of a camera's flame outline the 3-D flame covers at an instant, or
   *  null when the two cannot be compared; worked out once per camera and instant. */
  coverageAt(camera: string, index: number): number | null {
    if (!this.hull) return null;
    const key = `${camera}/${index}`;
    let share = this.shares.get(key);
    if (share === undefined) {
      const projection = this.hull(camera, index);
      share = projection ? coverage(this.outlines.get(camera)?.[index] ?? [], projection) : null;
      this.shares.set(key, share);
    }
    return share;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.shareTimer);
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

/** Shared caption on camera tiles and in exports, independent of picture crop. */
export function coverageCaption(share: number | null): string {
  return share === null ? i18n.t("3-D flame coverage unavailable")
    : i18n.t("3-D flame covers {p1} of the outline", { p1: i18n.formatQuantity(Math.round(share * 100), '%') });
}

/** Quantitative mask in full-resolution coordinates over the outline's bounds.
 * Cube rectangles use all eight corners, both focal lengths and each corner's
 * depth. The display squares never enter this calculation. Antialiased pixels
 * contribute their fractional area; only boxes above one million pixels shrink.
 */
export function coverage(rings: Float32Array[], projection: HullProjection): number | null {
  if (!rings.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i]); y0 = Math.min(y0, ring[i + 1]);
    x1 = Math.max(x1, ring[i]); y1 = Math.max(y1, ring[i + 1]);
  }
  x0 = Math.floor(x0) - 2; y0 = Math.floor(y0) - 2;
  x1 = Math.ceil(x1) + 2; y1 = Math.ceil(y1) + 2;
  const scale = Math.min(1, Math.sqrt(1_000_000 / ((x1 - x0) * (y1 - y0))));
  const w = Math.max(1, Math.ceil((x1 - x0) * scale)), h = Math.max(1, Math.ceil((y1 - y0) * scale));
  const grid = document.createElement('canvas');
  grid.width = w; grid.height = h;
  const g = grid.getContext('2d', { willReadFrequently: true })!;
  const path = new Path2D();
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      // Stored pixel centres are integers; canvas pixel centres are half-integers.
      const x = (ring[i] - x0 + 0.5) * scale, y = (ring[i + 1] - y0 + 0.5) * scale;
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    path.closePath();
  }
  g.fillStyle = 'white'; // numerical mask, never shown
  g.fill(path, 'evenodd');
  const outline = g.getImageData(0, 0, w, h).data;
  g.clearRect(0, 0, w, h);
  // One union path avoids repeated antialias blending of overlapping rectangles.
  const hullPath = new Path2D();
  const rectangles = projection.rectangles ?? [];
  for (let i = 0; i < rectangles.length; i += 4) {
    hullPath.rect((rectangles[i] - x0 + 0.5) * scale, (rectangles[i + 1] - y0 + 0.5) * scale,
      (rectangles[i + 2] - rectangles[i]) * scale, (rectangles[i + 3] - rectangles[i + 1]) * scale);
  }
  g.fill(hullPath);
  // Intersect the masks before counting: fractional edges stay fractional.
  const hull = g.getImageData(0, 0, w, h).data;
  let inside = 0, both = 0;
  for (let i = 3; i < outline.length; i += 4) {
    inside += outline[i]; both += Math.min(outline[i], hull[i]);
  }
  return inside ? both / inside : null;
}
