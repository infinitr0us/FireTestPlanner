import { describe, expect, it } from 'vitest';

import { i420Size, rgbaToI420 } from './yuv';

/** A width x height picture of one colour. */
const flat = (width: number, height: number, [r, g, b]: [number, number, number]): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255; }
  return out;
};
/** BT.709 limited range from first principles, for comparison with the fast path. */
const expected = ([r, g, b]: [number, number, number]): [number, number, number] => {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [Math.round(16 + (219 * luma) / 255), Math.round(128 + (224 * (b - luma)) / 1.8556 / 255), Math.round(128 + (224 * (r - luma)) / 1.5748 / 255)];
};

describe('canvas pixels to limited-range BT.709 I420', () => {
  it('keeps black, white and grey inside the limited range with neutral chroma', () => {
    for (const [colour, luma] of [[[0, 0, 0], 16], [[255, 255, 255], 235], [[128, 128, 128], 126]] as [[number, number, number], number][]) {
      const planes = rgbaToI420(flat(4, 2, colour), 4, 2);
      expect([...planes.subarray(0, 8)]).toEqual(new Array(8).fill(luma));
      expect([...planes.subarray(8)]).toEqual([128, 128, 128, 128]);
    }
  });
  it.each([[[255, 0, 0]], [[0, 255, 0]], [[0, 0, 255]], [[15, 23, 42]], [[249, 115, 22]], [[163, 230, 53]]] as [[number, number, number]][])(
    'matches the BT.709 matrix for %j', (colour) => {
      const planes = rgbaToI420(flat(2, 2, colour), 2, 2);
      const [y, cb, cr] = expected(colour);
      expect(planes.length).toBe(6);
      for (let i = 0; i < 4; i++) expect(Math.abs(planes[i] - y)).toBeLessThanOrEqual(1);
      expect(Math.abs(planes[4] - cb)).toBeLessThanOrEqual(1);
      expect(Math.abs(planes[5] - cr)).toBeLessThanOrEqual(1);
      expect(Math.min(...planes)).toBeGreaterThanOrEqual(16);
      expect(Math.max(...planes)).toBeLessThanOrEqual(240);
    });
  it('lays the planes out as luma rows, then Cb, then Cr, with chroma from the mean of 2 x 2', () => {
    // 4 x 2: the left block red and blue in a checker, the right block white.
    const pixels = new Uint8ClampedArray(4 * 2 * 4);
    const set = (x: number, y: number, [r, g, b]: number[]): void => pixels.set([r, g, b, 255], (y * 4 + x) * 4);
    set(0, 0, [255, 0, 0]); set(1, 0, [0, 0, 255]); set(0, 1, [0, 0, 255]); set(1, 1, [255, 0, 0]);
    for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]]) set(x, y, [255, 255, 255]);
    const planes = rgbaToI420(pixels, 4, 2);
    expect(i420Size(4, 2)).toBe(12);
    expect([...planes.subarray(0, 8)]).toEqual([63, 32, 235, 235, 32, 63, 235, 235]);
    const [, cb, cr] = expected([127.5, 0, 127.5]);
    expect(Math.abs(planes[8] - cb)).toBeLessThanOrEqual(1);
    expect(planes[9]).toBe(128);
    expect(Math.abs(planes[10] - cr)).toBeLessThanOrEqual(1);
    expect(planes[11]).toBe(128);
  });
  it('reuses a buffer of the right size and refuses odd sizes', () => {
    const buffer = new Uint8Array(i420Size(2, 2));
    expect(rgbaToI420(flat(2, 2, [1, 2, 3]), 2, 2, buffer)).toBe(buffer);
    expect(rgbaToI420(flat(2, 2, [1, 2, 3]), 2, 2, new Uint8Array(3))).not.toBe(buffer);
    expect(() => rgbaToI420(flat(3, 2, [0, 0, 0]), 3, 2)).toThrow(/even/);
    expect(() => rgbaToI420(new Uint8ClampedArray(4), 2, 2)).toThrow(/too few/);
  });
});
