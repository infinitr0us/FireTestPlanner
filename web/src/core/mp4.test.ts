import { describe, expect, it } from 'vitest';

import { muxMp4, type Mp4Sample } from './mp4';

/** Boxes as [type, start, size] down a path of container types. */
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): { type: string; start: number; size: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (let at = start; at < end;) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    expect(size).toBeGreaterThanOrEqual(8);
    out.push({ type, start: at, size });
    at += size;
  }
  return out;
}
function child(bytes: Uint8Array, parent: { start: number; size: number }, type: string, skip = 0) {
  const found = boxes(bytes, parent.start + 8 + skip, parent.start + parent.size).find((b) => b.type === type);
  if (!found) throw new Error('no ' + type);
  return found;
}

const AVCC = Uint8Array.of(1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 2, 0x68, 0xee);
const samples: Mp4Sample[] = Array.from({ length: 90 }, (_, i) => ({
  data: new Uint8Array(10 + (i % 7)).fill(i & 0xff),
  timestamp_us: Math.round((i * 1e6) / 30),
  key: i % 60 === 0,
}));

describe('the MP4 writer', () => {
  const file = muxMp4({ width: 1920, height: 1080, avcC: AVCC, fps: 30, samples });
  const view = new DataView(file.buffer);
  const top = boxes(file);

  it('writes ftyp, then the index, then the data', () => {
    expect(top.map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(top.at(-1)!.start + top.at(-1)!.size).toBe(file.length);
    expect(String.fromCharCode(...file.subarray(8, 12))).toBe('isom');
  });

  it('describes one 1920 x 1080 H.264 track of three seconds', () => {
    const moov = top[1];
    const mvhd = child(file, moov, 'mvhd');
    expect(view.getUint32(mvhd.start + 20)).toBe(1000);       // timescale
    expect(view.getUint32(mvhd.start + 24)).toBe(3000);       // 90 frames at 30 fps, ms
    const trak = child(file, moov, 'trak');
    const tkhd = child(file, trak, 'tkhd');
    expect(view.getUint32(tkhd.start + tkhd.size - 8) / 65536).toBe(1920);
    expect(view.getUint32(tkhd.start + tkhd.size - 4) / 65536).toBe(1080);
    const mdia = child(file, trak, 'mdia');
    const hdlr = child(file, mdia, 'hdlr');
    expect(String.fromCharCode(...file.subarray(hdlr.start + 16, hdlr.start + 20))).toBe('vide');
    const stbl = child(file, child(file, mdia, 'minf'), 'stbl');
    const stsd = child(file, stbl, 'stsd');
    const avc1 = child(file, stsd, 'avc1', 8);
    expect(view.getUint16(avc1.start + 32)).toBe(1920);
    expect(view.getUint16(avc1.start + 34)).toBe(1080);
    const avcC = child(file, avc1, 'avcC', 78);
    expect([...file.subarray(avcC.start + 8, avcC.start + avcC.size)]).toEqual([...AVCC]);
  });

  it('indexes every sample: one duration, the key frames, the sizes and one chunk', () => {
    const stbl = child(file, child(file, child(file, child(file, top[1], 'trak'), 'mdia'), 'minf'), 'stbl');
    const stts = child(file, stbl, 'stts');
    expect([view.getUint32(stts.start + 12), view.getUint32(stts.start + 16), view.getUint32(stts.start + 20)]).toEqual([1, 90, 3000]);
    const stss = child(file, stbl, 'stss');
    expect([view.getUint32(stss.start + 12), view.getUint32(stss.start + 16), view.getUint32(stss.start + 20)]).toEqual([2, 1, 61]);
    const stsz = child(file, stbl, 'stsz');
    expect(view.getUint32(stsz.start + 16)).toBe(90);
    const sizes = Array.from({ length: 90 }, (_, i) => view.getUint32(stsz.start + 20 + 4 * i));
    expect(sizes).toEqual(samples.map((s) => s.data.length));
    const stco = child(file, stbl, 'stco');
    const offset = view.getUint32(stco.start + 16);
    expect(offset).toBe(top[2].start + 8);
    // The data the index points at is the samples, in order.
    let at = offset;
    for (const s of samples) {
      expect([...file.subarray(at, at + s.data.length)]).toEqual([...s.data]);
      at += s.data.length;
    }
    expect(at).toBe(file.length);
  });

  it('refuses what it cannot describe', () => {
    expect(() => muxMp4({ width: 2, height: 2, avcC: AVCC, fps: 30, samples: [] })).toThrow(/no frames/);
    expect(() => muxMp4({ width: 2, height: 2, avcC: AVCC, fps: 30, samples: [{ ...samples[1] }] })).toThrow(/key frame/);
    expect(() => muxMp4({ width: 2, height: 2, avcC: AVCC, fps: 30, samples: [samples[0], { ...samples[1], timestamp_us: 0 }] })).toThrow(/order/);
  });
});
