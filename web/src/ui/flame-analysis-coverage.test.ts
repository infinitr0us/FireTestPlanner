import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coverage, hullSquares, placement } from './flame-analysis-cameras';
import { fillTemplate, joinPath, parseEventManifest, parseOutlines, projectHull } from '../core/flame-analysis';
import { FlameSequence, parseFrameData, surfaceCells } from '../core/flame';
import type { CameraObject } from '../core/types';

// Independent scanline raster double for the production mask path. Sixteen
// subrows approximate canvas antialiasing; browser regressions check real pixels.
function maskCanvas() {
  const sizes: number[][] = [];
  class Path {
    rings: number[][] = [];
    moveTo(x: number, y: number) { this.rings.push([x, y]); }
    lineTo(x: number, y: number) { this.rings.at(-1)!.push(x, y); }
    closePath() {}
    rect(x: number, y: number, w: number, h: number) { this.rings.push([x, y, x + w, y, x + w, y + h, x, y + h]); }
  }
  vi.stubGlobal('Path2D', Path);
  vi.stubGlobal('document', { createElement: () => {
    const canvas: any = { width: 0, height: 0 };
    let data = new Uint8ClampedArray();
    canvas.getContext = () => ({
      clearRect() { data = new Uint8ClampedArray(canvas.width * canvas.height * 4); },
      fill(path: Path, rule: string) {
        const { width: w, height: h } = canvas;
        sizes.push([w, h]);
        const areas = new Float64Array(w * h);
        const rows = 16;
        for (let sy = 0; sy < h * rows; sy++) {
          const y = (sy + 0.5) / rows, row = Math.floor(sy / rows);
          const spans: [number, number][] = [], all: number[] = [];
          for (const ring of path.rings) {
            const xs: number[] = [];
            for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
              const yi = ring[i + 1], yj = ring[j + 1];
              if ((yi > y) !== (yj > y)) xs.push(ring[i] + (y - yi) * (ring[j] - ring[i]) / (yj - yi));
            }
            if (rule === 'evenodd') all.push(...xs);
            else {
              xs.sort((a, b) => a - b);
              for (let k = 0; k < xs.length; k += 2) spans.push([xs[k], xs[k + 1]]);
            }
          }
          if (rule === 'evenodd') {
            all.sort((a, b) => a - b);
            for (let k = 0; k < all.length; k += 2) spans.push([all[k], all[k + 1]]);
          }
          spans.sort((a, b) => a[0] - b[0]);
          const union: [number, number][] = [];
          for (const span of spans) {
            const last = union.at(-1);
            if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
            else union.push([...span]);
          }
          for (const [a, b] of union) for (let x = Math.max(0, Math.floor(a)); x < Math.min(w, Math.ceil(b)); x++) {
            areas[row * w + x] += Math.max(0, Math.min(b, x + 1) - Math.max(a, x)) / rows;
          }
        }
        data = new Uint8ClampedArray(w * h * 4);
        areas.forEach((area, i) => { data[i * 4 + 3] = Math.round(area * 255); });
      },
      getImageData() { return { data }; },
    });
    return canvas;
  } });
  return sizes;
}
afterEach(() => vi.unstubAllGlobals());

describe('coverage uses its own quantitative mask (B14)', () => {
  it('R14 reports about 35 percent while the visual overlay keeps its 12-pixel square', () => {
    maskCanvas();
    const camera = { transform: { position_m: [0, 0, 0] }, camera: { resolution_px: [200, 200], sensor_mm: [2, 4], focalLength_mm: 10 } } as CameraObject;
    const projection = projectHull(camera, [0, 0, -10], 0.1);
    const rings = [Float32Array.from([93.5, 93.5, 105.5, 93.5, 105.5, 105.5, 93.5, 105.5])];
    const rectangles: number[][] = [];
    hullSquares({ fillRect: (...args: number[]) => rectangles.push(args) } as any, projection,
      placement({ size_px: [200, 200], display_px: [200, 200] }, 'whole'), 1);
    expect(rectangles).toEqual([[94, 94, 12, 12]]);
    expect(coverage(rings, projection)).toBeCloseTo(0.35, 2);
    projection.uv = Float32Array.from([500, 500]); projection.size = 10000;
    expect(coverage(rings, projection)).toBeCloseTo(0.35, 2);
  });
  it('fills outline holes even-odd and unions overlapping rectangles without enlargement', () => {
    maskCanvas();
    const rings = [[0, 0, 10, 0, 10, 10, 0, 10], [2, 2, 8, 2, 8, 8, 2, 8]].map((a) => Float32Array.from(a));
    const projection = { uv: new Float32Array(), size: 0, rectangles: Float64Array.from([0, 0, 5, 10, 0, 0, 5, 10]) };
    const share = coverage(rings, projection)!;
    // Half-pixel boundaries have fractional mask pixels at the hole's corners.
    // Pin the area within one percentage point, not an exact vector intersection.
    expect(Math.abs(share - 0.5)).toBeLessThan(0.01);
    expect(coverage(rings, { ...projection, rectangles: projection.rectangles.slice(0, 4) })).toBe(share);
    expect(coverage([], projection)).toBeNull();
  });
  it('keeps full resolution until the outline bounding box exceeds about one million pixels', () => {
    const sizes: number[][] = [];
    vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} closePath() {} rect() {} });
    vi.stubGlobal('document', { createElement: () => {
      const canvas: any = { width: 0, height: 0, getContext: () => ({ fill() {}, clearRect() {}, getImageData() {
        sizes.push([canvas.width, canvas.height]); return { data: new Uint8Array([0, 0, 0, 255]) };
      } }) }; return canvas;
    } });
    const p = { uv: new Float32Array(), size: 0 };
    coverage([Float32Array.from([100, 100, 110, 100, 110, 120, 100, 120])], p);
    expect(sizes[0]).toEqual([14, 24]);
    coverage([Float32Array.from([0, 0, 4000, 0, 4000, 2000, 0, 2000])], p);
    expect(sizes.at(-1)![0] * sizes.at(-1)![1]).toBeLessThan(1_003_000);
  });
  it('pins E1 at its Largest flame key moment independently of display size', async () => {
    maskCanvas();
    const root = new URL('../../../fixtures/flame-analysis/', import.meta.url);
    const read = (name: string) => readFileSync(new URL(name, root), 'utf8');
    const event = parseEventManifest(read('E1/event.json'));
    const plan = JSON.parse(read('site.ftp.json'));
    const analysis = JSON.parse(read('analysis.json'));
    const moment = event.keyMoments!.find((m) => typeof m.label === 'object' && m.label.en === 'Largest flame')!;
    const i = event.instants.t_s.indexOf(moment.t_s);
    const file = joinPath('E1', fillTemplate(event.files.hull, undefined, event.instants.stem[i]));
    const raw = await parseFrameData(file, new Uint8Array(readFileSync(new URL(file, root))), moment.t_s);
    const sequence = FlameSequence.fromFrames([raw]), frame = sequence.frames[0];
    const cells = surfaceCells(frame), origin = sequence.frameOrigin(frame), pitch = sequence.grid.pitch_m;
    const points = Float64Array.from(cells, (v, n) => origin[n % 3] + v * pitch);
    const shares = event.cameras.map((id) => {
      const camera = plan.objects.find((c: any) => c.id === analysis.cameras.find((c: any) => c.id === id).planCameraId);
      const rings = parseOutlines(read(joinPath('E1', fillTemplate(event.files.outlines, id))), id, event.instants.t_s.length)[i];
      return coverage(rings, projectHull(camera, points, pitch))!;
    });
    // This synthetic carved hull still covers all three outlines with physical
    // cube rectangles. R14 above distinguishes the new metric from display marks.
    expect(shares.map((s) => Math.round(100 * s))).toEqual([100, 100, 100]);
  });
});
