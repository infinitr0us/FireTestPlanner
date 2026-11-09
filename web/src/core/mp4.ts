/**
 * A minimal MP4 (ISO base media file) writer for one H.264 video track.
 *
 * What WebCodecs' `VideoEncoder` gives with `avc: { format: 'avc' }` is already the
 * MP4 sample format (length-prefixed NAL units) plus the `avcC` decoder record, so
 * writing a file is only the container: `ftyp`, then `moov` (the index, placed first
 * so a player can start at once), then `mdat` with every sample in one chunk.
 * Constant frame duration, frames in presentation order (no B-frames), no audio:
 * the shape PowerPoint and every desktop player read.
 */

export interface Mp4Sample {
  data: Uint8Array;
  /** Microseconds, as WebCodecs reports them. */
  timestamp_us: number;
  key: boolean;
}

export interface Mp4Track {
  width: number;
  height: number;
  /** The `avcC` record: `decoderConfig.description` of the first chunk's metadata. */
  avcC: Uint8Array;
  /** Frames per second; every sample lasts 1/fps. */
  fps: number;
  samples: Mp4Sample[];
}

const TIMESCALE = 90000; // the usual video media timescale; whole ticks for 24, 25, 30, 60 fps

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;
  bytes(data: Uint8Array): this { this.chunks.push(data); this.length += data.length; return this; }
  u8(v: number): this { return this.bytes(Uint8Array.of(v & 0xff)); }
  u16(v: number): this { return this.bytes(Uint8Array.of((v >>> 8) & 0xff, v & 0xff)); }
  u32(v: number): this { return this.bytes(Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)); }
  ascii(text: string): this { return this.bytes(Uint8Array.from(text, (c) => c.charCodeAt(0))); }
  zeros(n: number): this { return this.bytes(new Uint8Array(n)); }
  join(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}

/** A box: 32-bit size, four-character type, contents. */
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const w = new Writer();
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  w.u32(size).ascii(type);
  for (const p of parts) w.bytes(p);
  return w.join();
}
/** A full box: a box whose contents start with a version byte and 24 bits of flags. */
function fullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
  const w = new Writer().u8(version).u8(flags >>> 16).u8(flags >>> 8).u8(flags);
  return box(type, w.bytes(body).join());
}
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

export function muxMp4(track: Mp4Track): Uint8Array {
  const { width, height, avcC, fps, samples } = track;
  if (!samples.length) throw new Error('no frames to write');
  if (!samples[0].key) throw new Error('the first frame must be a key frame');
  for (let i = 1; i < samples.length; i++) {
    if (!(samples[i].timestamp_us > samples[i - 1].timestamp_us)) throw new Error('frames are not in presentation order');
  }
  const delta = Math.round(TIMESCALE / fps);
  const mediaDuration = delta * samples.length;
  const movieDuration = Math.round((mediaDuration / TIMESCALE) * 1000);
  const dataSize = samples.reduce((n, s) => n + s.data.length, 0);
  if (dataSize > 0xffffffff - 4096) throw new Error('the video is too large for a 32-bit MP4');

  const ftyp = box('ftyp', new Writer().ascii('isom').u32(0x200).ascii('isomiso2avc1mp41').join());

  const moov = (chunkOffset: number): Uint8Array => {
    const mvhd = new Writer().u32(0).u32(0).u32(1000).u32(movieDuration).u32(0x00010000).u16(0x0100).zeros(10);
    MATRIX.forEach((v) => mvhd.u32(v));
    mvhd.zeros(24).u32(2);
    const tkhd = new Writer().u32(0).u32(0).u32(1).u32(0).u32(movieDuration).zeros(8).u16(0).u16(0).u16(0).u16(0);
    MATRIX.forEach((v) => tkhd.u32(v));
    tkhd.u32(width * 0x10000).u32(height * 0x10000);
    const mdhd = new Writer().u32(0).u32(0).u32(TIMESCALE).u32(mediaDuration).u16(0x55c4).u16(0); // language 'und'
    const hdlr = new Writer().u32(0).ascii('vide').zeros(12).ascii('VideoHandler').u8(0);
    const vmhd = new Writer().u16(0).zeros(6);
    const dref = fullBox('dref', 0, 0, new Writer().u32(1).bytes(fullBox('url ', 0, 1, new Uint8Array(0))).join());
    const avc1 = new Writer().zeros(6).u16(1).u16(0).u16(0).zeros(12).u16(width).u16(height)
      .u32(0x00480000).u32(0x00480000).u32(0).u16(1).zeros(32).u16(0x0018).u16(0xffff)
      .bytes(box('avcC', avcC));
    const stsd = new Writer().u32(1).bytes(box('avc1', avc1.join()));
    const stts = new Writer().u32(1).u32(samples.length).u32(delta);
    const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter((n) => n > 0);
    const stss = new Writer().u32(keys.length);
    keys.forEach((n) => stss.u32(n));
    const stsc = new Writer().u32(1).u32(1).u32(samples.length).u32(1);
    const stsz = new Writer().u32(0).u32(samples.length);
    samples.forEach((s) => stsz.u32(s.data.length));
    const stco = new Writer().u32(1).u32(chunkOffset);
    const stbl = box('stbl',
      fullBox('stsd', 0, 0, stsd.join()), fullBox('stts', 0, 0, stts.join()), fullBox('stss', 0, 0, stss.join()),
      fullBox('stsc', 0, 0, stsc.join()), fullBox('stsz', 0, 0, stsz.join()), fullBox('stco', 0, 0, stco.join()));
    const minf = box('minf', fullBox('vmhd', 0, 1, vmhd.join()), box('dinf', dref), stbl);
    const mdia = box('mdia', fullBox('mdhd', 0, 0, mdhd.join()), fullBox('hdlr', 0, 0, hdlr.join()), minf);
    const trak = box('trak', fullBox('tkhd', 0, 3, tkhd.join()), mdia);
    return box('moov', fullBox('mvhd', 0, 0, mvhd.join()), trak);
  };
  // The index's size does not depend on the offset it records, so measure, then write.
  const moovSize = moov(0).length;
  const offset = ftyp.length + moovSize + 8;
  const mdat = new Writer().u32(8 + dataSize).ascii('mdat');
  samples.forEach((s) => mdat.bytes(s.data));
  return new Writer().bytes(ftyp).bytes(moov(offset)).bytes(mdat.join()).join();
}
