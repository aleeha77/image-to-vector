/**
 * Median-cut colour quantiser (pure TypeScript, no native deps).
 *
 * Why hand-rolled: vtracer's own clustering is excellent once the *input* is
 * genuinely flat, but print/sensor grain gives it thousands of near-identical
 * micro-clusters, which come out as thousands of tiny paths and a 3 MB SVG.
 * Quantising first is what makes a busy dress print trace as clean colour
 * regions. sharp's `png({palette:true, colours:n})` looks like the obvious tool
 * for it, but on this libvips build it ignores `colours` and always emits a
 * 256-entry palette, so we do it ourselves and get exact control.
 *
 * 5 bits per channel (32³ histogram bins) — fine enough to keep neighbouring
 * inks apart, coarse enough that the whole 1.4 MP pass costs tens of ms.
 */

const BITS = 5;
const LEVELS = 1 << BITS; // 32
const BINS = LEVELS * LEVELS * LEVELS;

interface Box {
  bins: number[]; // histogram bin indices
  count: number; // total pixels
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

function boxOf(bins: number[], hist: Uint32Array): Box {
  let count = 0;
  let rMin = 31;
  let rMax = 0;
  let gMin = 31;
  let gMax = 0;
  let bMin = 31;
  let bMax = 0;
  for (const bin of bins) {
    count += hist[bin];
    const r = (bin >> (BITS * 2)) & 31;
    const g = (bin >> BITS) & 31;
    const b = bin & 31;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  return { bins, count, rMin, rMax, gMin, gMax, bMin, bMax };
}

export interface QuantiseResult {
  /** RGBA, 4 bytes per pixel, ready for the vectoriser. */
  rgba: Buffer;
  /** The palette actually used (packed 0xRRGGBB). */
  palette: number[];
}

/**
 * Reduce an RGBA buffer to at most `colours` flat colours.
 * No dithering: dither noise would land in the trace as speckle.
 */
export function quantise(
  data: Buffer,
  channels: number,
  width: number,
  height: number,
  colours: number,
): QuantiseResult {
  const { lut, palette } = quantiseLut(data, channels, width * height, colours);
  return { rgba: mapTo(data, channels, width * height, lut, palette), palette };
}

export interface LabelResult {
  /** Palette index per pixel, row-major. */
  labels: Uint16Array;
  /** The palette actually used (packed 0xRRGGBB). */
  palette: number[];
}

/**
 * Same quantisation, but returning the *label map* the tracer works from: one
 * flat colour index per pixel. Kept alongside `quantise` so both share a single
 * implementation of the median cut.
 */
export function quantiseLabels(
  data: Buffer,
  channels: number,
  width: number,
  height: number,
  colours: number,
): LabelResult {
  const pixels = width * height;
  const { lut, palette } = quantiseLut(data, channels, pixels, colours);
  const labels = new Uint16Array(pixels);
  for (let i = 0, p = 0; i < pixels; i++, p += channels) {
    const r = data[p];
    const g = channels === 1 ? r : data[p + 1];
    const b = channels === 1 ? r : data[p + 2];
    const bin = ((r >> (8 - BITS)) << (BITS * 2)) | ((g >> (8 - BITS)) << BITS) | (b >> (8 - BITS));
    const idx = lut[bin];
    labels[i] = idx < 0 ? 0 : idx;
  }
  return { labels, palette };
}

/** Median cut over a 5-bit histogram: the shared engine of both exports. */
function quantiseLut(
  data: Buffer,
  channels: number,
  pixels: number,
  colours: number,
): { lut: Int16Array; palette: number[] } {
  const maxColours = Math.max(2, Math.min(256, Math.floor(colours)));

  // 1. Histogram (weighted sums avoid a second pass over the image).
  const hist = new Uint32Array(BINS);
  const sumR = new Float64Array(BINS);
  const sumG = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);
  for (let i = 0, p = 0; i < pixels; i++, p += channels) {
    const r = data[p];
    const g = channels === 1 ? r : data[p + 1];
    const b = channels === 1 ? r : data[p + 2];
    const bin = ((r >> (8 - BITS)) << (BITS * 2)) | ((g >> (8 - BITS)) << BITS) | (b >> (8 - BITS));
    hist[bin]++;
    sumR[bin] += r;
    sumG[bin] += g;
    sumB[bin] += b;
  }

  const present: number[] = [];
  for (let bin = 0; bin < BINS; bin++) if (hist[bin] > 0) present.push(bin);
  if (present.length === 0) throw new Error("Empty image");
  if (present.length <= maxColours) {
    // Already flat enough — keep the exact colours rather than re-averaging them.
    const palette: number[] = [];
    const lut = new Int16Array(BINS).fill(-1);
    for (const bin of present) {
      lut[bin] = palette.length;
      palette.push(
        (Math.round(sumR[bin] / hist[bin]) << 16) |
          (Math.round(sumG[bin] / hist[bin]) << 8) |
          Math.round(sumB[bin] / hist[bin]),
      );
    }
    return { lut, palette };
  }

  // 2. Median cut: repeatedly split the widest/most-populated box at its
  //    population-weighted median until we have `maxColours` boxes.
  let boxes: Box[] = [boxOf(present, hist)];
  while (boxes.length < maxColours) {
    let pick = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const span = Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
      if (box.bins.length < 2) continue;
      // Population × extent: split the box that is both big and spread out.
      const score = box.count * (span + 1);
      if (score > bestScore) {
        bestScore = score;
        pick = i;
      }
    }
    if (pick < 0) break; // every box is a single bin — palette exhausted
    const box = boxes[pick];
    const rSpan = box.rMax - box.rMin;
    const gSpan = box.gMax - box.gMin;
    const bSpan = box.bMax - box.bMin;
    const axis = rSpan >= gSpan && rSpan >= bSpan ? 2 : gSpan >= bSpan ? 1 : 0;
    const shift = axis === 2 ? BITS * 2 : axis === 1 ? BITS : 0;
    const sorted = box.bins.slice().sort((a, b) => ((a >> shift) & 31) - ((b >> shift) & 31));
    const half = box.count / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += hist[sorted[i]];
      if (acc >= half) {
        cut = i + 1;
        break;
      }
    }
    const left = sorted.slice(0, cut);
    const right = sorted.slice(cut);
    boxes.splice(pick, 1, boxOf(left, hist), boxOf(right, hist));
  }

  // 3. Palette = population-weighted mean of each box.
  const palette: number[] = [];
  for (const box of boxes) {
    let n = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const bin of box.bins) {
      n += hist[bin];
      r += sumR[bin];
      g += sumG[bin];
      b += sumB[bin];
    }
    const pr = Math.round(r / n);
    const pg = Math.round(g / n);
    const pb = Math.round(b / n);
    palette.push((pr << 16) | (pg << 8) | pb);
  }

  // 4. Bin -> palette lookup, computed once per bin rather than per pixel.
  const lut = new Int16Array(BINS).fill(-1);
  for (let i = 0; i < boxes.length; i++) {
    for (const bin of boxes[i].bins) lut[bin] = i;
  }
  const boxOfBin = new Int16Array(BINS).fill(-1);
  for (let i = 0; i < boxes.length; i++) for (const bin of boxes[i].bins) boxOfBin[bin] = i;
  for (let bin = 0; bin < BINS; bin++) {
    if (lut[bin] >= 0 || hist[bin] > 0) continue;
    // Empty bin (can happen if the box search missed one): snap to nearest palette.
    const r = ((bin >> (BITS * 2)) & 31) << (8 - BITS);
    const g = ((bin >> BITS) & 31) << (8 - BITS);
    const b = (bin & 31) << (8 - BITS);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const dr = r - ((palette[i] >> 16) & 255);
      const dg = g - ((palette[i] >> 8) & 255);
      const db = b - (palette[i] & 255);
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    lut[bin] = best;
  }

  return { lut, palette };
}

/** Write every pixel as the flat palette colour of its histogram bin. */
function mapTo(
  data: Buffer,
  channels: number,
  pixels: number,
  lut: Int16Array,
  palette: number[],
): Buffer {
  const out = Buffer.alloc(pixels * 4);
  const pc = palette.map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]);
  for (let i = 0, p = 0, o = 0; i < pixels; i++, p += channels, o += 4) {
    const r = data[p];
    const g = channels === 1 ? r : data[p + 1];
    const b = channels === 1 ? r : data[p + 2];
    const bin = ((r >> (8 - BITS)) << (BITS * 2)) | ((g >> (8 - BITS)) << BITS) | (b >> (8 - BITS));
    const idx = lut[bin] < 0 ? 0 : lut[bin];
    const c = pc[idx];
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = 255;
  }
  return out;
}
