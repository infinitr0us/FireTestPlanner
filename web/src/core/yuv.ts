/**
 * Canvas pixels as the planar YCbCr a video encoder takes: I420 (4:2:0), BT.709,
 * limited range (luma 16 to 235, chroma 16 to 240).
 *
 * Why not hand the encoder the canvas: the browser engine then converts it to
 * full-range YCbCr and says so only beside the stream, not in it. A player takes an
 * H.264 stream that says nothing as limited range, stretches it, and shows the video
 * darker and harsher than the picture it was made from. Limited-range BT.709 is what
 * every player assumes for HD video, so frames converted here look the same wherever
 * they are played. DOM-free.
 */

/** What a frame made by `rgbaToI420` is, in WebCodecs' terms. */
export const I420_COLOUR = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } as const;

export const i420Size = (width: number, height: number): number => width * height + 2 * (width >> 1) * (height >> 1);

/**
 * RGBA rows (as `getImageData` gives them) to I420: the luma plane, then Cb, then Cr,
 * each chroma sample from the mean of its 2 x 2 pixels. Width and height must be even.
 * `out` is reused when it has the right size.
 */
export function rgbaToI420(rgba: ArrayLike<number>, width: number, height: number, out?: Uint8Array): Uint8Array {
  if (width % 2 || height % 2 || width <= 0 || height <= 0) throw new Error('I420 needs an even width and height');
  if (rgba.length < width * height * 4) throw new Error('too few pixels for the picture size');
  const size = i420Size(width, height);
  const planes = out && out.length === size ? out : new Uint8Array(size);
  let u = width * height, v = u + (u >> 2);
  for (let y = 0; y < height; y += 2) {
    let top = y * width * 4, bottom = top + width * 4;
    let lumaTop = y * width, lumaBottom = lumaTop + width;
    for (let x = 0; x < width; x += 2) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < 4; k++) {
        const at = (k < 2 ? top : bottom) + (k & 1) * 4;
        const red = rgba[at], green = rgba[at + 1], blue = rgba[at + 2];
        // 16 + 219 x (0.2126 R + 0.7152 G + 0.0722 B) / 255, rounded.
        const luma = (16.5 + 0.182586 * red + 0.614231 * green + 0.062007 * blue) | 0;
        if (k === 0) planes[lumaTop] = luma;
        else if (k === 1) planes[lumaTop + 1] = luma;
        else if (k === 2) planes[lumaBottom] = luma;
        else planes[lumaBottom + 1] = luma;
        r += red; g += green; b += blue;
      }
      // 128 + 224 x (B - Y) / 1.8556 / 255 and 128 + 224 x (R - Y) / 1.5748 / 255, on the mean of the four.
      planes[u++] = (128.5 + (-0.100644 * r - 0.338572 * g + 0.439216 * b) / 4) | 0;
      planes[v++] = (128.5 + (0.439216 * r - 0.398942 * g - 0.040274 * b) / 4) | 0;
      top += 8; bottom += 8; lumaTop += 2; lumaBottom += 2;
    }
  }
  return planes;
}
