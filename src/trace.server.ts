/**
 * Tracecraft tracing engine (server-only).
 *
 * Raster -> SVG through the sub-pixel tracer in `./trace-core.server`: every
 * upload is preprocessed into a set of flat colour regions (or an ink/paper
 * pair) and each region is then contoured as a *coverage field* — so vertices
 * are sub-pixel accurate, carry no pixel staircase, and a boundary pixel's
 * anti-aliased colour is used as evidence of where inside the pixel the true
 * edge runs. Each contour is fitted with real cubic Béziers between detected
 * corners.
 *
 * The old engine handed a deliberately downscaled bitmap to a tracer that
 * followed pixel boundaries, so its geometry *was* the raster's grid — hence
 * output that pixelated as soon as you zoomed. This one no longer inherits the
 * raster's resolution: the raster is only asked *which* region each pixel
 * belongs to and *how much* of it does.
 *
 * Everything happens in memory buffers — an uploaded image is never written to
 * disk, stored, or logged.
 */
import sharp from "sharp";
import { modalColours, segment } from "./segment";
import {
  contoursForField,
  fieldMargin,
  hex,
  labelStats,
  layerCoverage,
  layerField,
  smoothField,
  type CoreOptions,
  type Contoured,
} from "./trace-core.server";

export const PRESET_IDS = ["logo", "lineart", "photo", "pattern"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export const PRESET_LABELS: Record<PresetId, string> = {
  logo: "Logo",
  lineart: "Line art",
  photo: "Photo",
  pattern: "Seamless pattern",
};

export interface TraceOptions {
  preset: PresetId;
  /** 0 = simplest / smallest file, 1 = most detail. Default 0.5. */
  detail?: number;
  /** Colour transparency is flattened onto. */
  background?: string;
}

export interface TraceResult {
  svg: string;
  width: number;
  height: number;
  /** Distinct contours drawn — the honest "how much vector detail" measure. */
  pathCount: number;
  /** Distinct fill colours — evidence that colour separation actually happened. */
  colourCount: number;
  bytes: number;
  ms: number;
  /** Which preprocessing steps ran, so the UI can describe what it did. */
  steps: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Contours = one `M` per closed subpath inside the emitted path data. */
export function countPaths(svg: string): number {
  let n = 0;
  for (const d of svg.matchAll(/ d="([^"]*)"/g)) n += (d[1].match(/M/g) ?? []).length;
  return n || (svg.match(/<path\b/g) ?? []).length;
}

export function countColours(svg: string): number {
  const seen = new Set<string>();
  for (const m of svg.matchAll(/fill="([^"]+)"/g)) {
    const v = m[1].toLowerCase();
    if (v !== "none") seen.add(v);
  }
  return seen.size;
}

/**
 * Per-preset tuning.
 *
 * `tolerance` is how far a pixel's colour may sit from a region's seed colour
 * and still join it — the segmentation's grain. `regions` is the region budget
 * ([at detail 1, at detail 0]); the tolerance is raised automatically until the
 * image fits inside it, so "detail" is honestly "how many distinct shapes".
 *
 * `sigma` is the coverage-field smoothing in working pixels, deliberately well
 * under a pixel so hairlines and corners survive.
 *
 * `fitError` is the maximum deviation the Bézier fit is allowed, in working
 * pixels — the whole point of a sub-pixel tracer is that this can be tight.
 *
 * `minArea` (px²) drops noise specks; it stays tiny so genuine dots and 1px
 * hairlines are traced rather than filtered away.
 */
interface PresetTuning {
  mode: "binary" | "color";
  /** Chebyshev colour distance for region growing. */
  tolerance: [number, number];
  /** [at detail 1, at detail 0] region budget. */
  regions: [number, number];
  /** Maximum width (px) of a region still considered an anti-aliasing band. */
  bandWidth: number;
  /** Curves are only allowed to merge "blend" regions; photographs keep theirs. */
  mergeBands: boolean;
  /** [at detail 1, at detail 0] curve-fit tolerance, working px. */
  fitError: [number, number];
  /** [at detail 1, at detail 0] minimum contour area, px². */
  minArea: [number, number];
  /** Coverage-field smoothing, working px. */
  sigma: number;
  /** Turn angle (degrees) that counts as a corner. */
  cornerAngle: number;
  /** Longest edge handed to the tracer (time/memory guard). */
  maxDim: number;
  /** Smaller inputs are upscaled to this edge so thin features keep sub-pixel room. */
  minDim: number;
  /** Median denoise window (1 = off). Kills sensor / print / compression speckle. */
  denoise: number;
  /** Pre-blur sigma; merges neighbouring shades so photos yield cleaner regions. */
  blur: number;
  /** 1 = untouched; >1 widens the gaps between neighbouring colour clusters. */
  saturation: number;
  /** Line art only: fallback luminance cut if Otsu finds nothing sensible. */
  threshold: number;
}

export const TUNING: Record<PresetId, PresetTuning> = {
  // Flat art, few colours, hard edges. Tight tolerance and a fine field so
  // corners stay sharp and straight edges stay dead straight.
  logo: {
    mode: "color",
    tolerance: [10, 16],
    regions: [140, 40],
    bandWidth: 3.2,
    mergeBands: true,
    fitError: [0.3, 0.5],
    minArea: [1, 6],
    sigma: 0.45,
    cornerAngle: 30,
    maxDim: 2400,
    minDim: 700,
    denoise: 1,
    blur: 0,
    saturation: 1,
    threshold: 140,
  },
  // Ink / pencil drawings: an ink/paper split whose boundary is taken from the
  // anti-aliasing ramp itself, then traced as a single ink layer over its paper.
  lineart: {
    mode: "binary",
    tolerance: [14, 22],
    regions: [2, 2],
    bandWidth: 3.2,
    mergeBands: true,
    fitError: [0.26, 0.42],
    minArea: [1.2, 5],
    sigma: 0.5,
    cornerAngle: 34,
    maxDim: 2600,
    minDim: 900,
    denoise: 1,
    blur: 0,
    saturation: 1,
    threshold: 140,
  },
  // Photographs: many subtle shades. Region budget stays high because a photo's
  // "colour separation" is genuinely thousands of patches, and the tolerance
  // search is what keeps the file honest.
  photo: {
    mode: "color",
    tolerance: [9, 22],
    regions: [4000, 700],
    bandWidth: 1.8,
    mergeBands: true,
    fitError: [0.5, 0.9],
    minArea: [2, 14],
    sigma: 0.75,
    cornerAngle: 38,
    maxDim: 1600,
    minDim: 600,
    denoise: 3,
    blur: 0.4,
    saturation: 1.03,
    threshold: 140,
  },
  // Textiles, dress prints, wallpaper: dense motifs, hairlines, fine dots.
  // Small sigma and small minArea so dots and 1px lines survive.
  pattern: {
    mode: "color",
    tolerance: [12, 18],
    regions: [900, 200],
    bandWidth: 3.2,
    mergeBands: true,
    fitError: [0.3, 0.55],
    minArea: [1, 6],
    sigma: 0.45,
    cornerAngle: 32,
    maxDim: 2200,
    minDim: 900,
    denoise: 1,
    blur: 0,
    saturation: 1.06,
    threshold: 140,
  },
};

export function coreOptions(preset: PresetId, detail: number): CoreOptions {
  const t = TUNING[preset];
  const d = clamp(detail, 0, 1);
  return {
    sigma: t.sigma,
    fitError: lerp(t.fitError[0], t.fitError[1], d),
    cornerAngle: t.cornerAngle,
    minArea: lerp(t.minArea[0], t.minArea[1], d),
    precision: 3,
  };
}

/** RGB bytes out of whatever channel count sharp handed back. */
function toRgb(data: Buffer, channels: number, pixels: number): Buffer {
  if (channels === 3) return data;
  const out = Buffer.alloc(pixels * 3);
  if (channels === 4) {
    for (let i = 0, s = 0, o = 0; i < pixels; i++, s += 4, o += 3) {
      out[o] = data[s];
      out[o + 1] = data[s + 1];
      out[o + 2] = data[s + 2];
    }
    return out;
  }
  for (let i = 0, o = 0; i < pixels; i++, o += 3) {
    out[o] = data[i];
    out[o + 1] = data[i];
    out[o + 2] = data[i];
  }
  return out;
}

interface Layer {
  d: string;
  colour: [number, number, number];
  area: number;
  contours: number;
  curves: number;
}

/**
 * Otsu's threshold over a luminance histogram: the cut that best separates two
 * tones. Used instead of a fixed luminance because a photographed or scanned
 * drawing is rarely exposed the way a synthetic one is.
 */
export function otsu(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return threshold;
}

/**
 * Preprocess + trace. Buffers only — nothing touches the filesystem.
 */
export async function traceImage(input: Buffer, options: TraceOptions): Promise<TraceResult> {
  const started = Date.now();
  const preset: PresetId = (PRESET_IDS as readonly string[]).includes(options.preset) ? options.preset : "logo";
  const t = TUNING[preset];
  const detail = clamp(options.detail ?? 0.5, 0, 1);
  const background = options.background ?? "#ffffff";
  const steps: string[] = [];
  const core = coreOptions(preset, detail);

  // Decode once. `rotate()` bakes in EXIF orientation so the trace is not sideways.
  let pipeline = sharp(input, { limitInputPixels: 64_000_000 }).rotate();
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) throw new Error("Unreadable image data");
  if (meta.hasAlpha) steps.push(`transparency flattened onto ${background}`);

  // Working resolution. Upscaling a small input is not a trick to hide pixel
  // edges: the contour is sub-pixel either way, but a wider feature gives the
  // smoothing kernel proportionally less bite, so 1px hairlines keep their width.
  const longEdge = Math.max(meta.width, meta.height);
  const target = clamp(longEdge, t.minDim, t.maxDim);
  if (target !== longEdge) {
    pipeline = pipeline.resize({
      width: Math.max(1, Math.round((meta.width * target) / longEdge)),
      height: Math.max(1, Math.round((meta.height * target) / longEdge)),
      fit: "fill",
      kernel: "lanczos3",
    });
    steps.push(
      longEdge < target
        ? `upscaled ${String(meta.width)}×${String(meta.height)} so hairlines keep sub-pixel room`
        : `working resolution ${String(Math.round((meta.width * target) / longEdge))}×${String(Math.round((meta.height * target) / longEdge))}`,
    );
  }

  pipeline = pipeline.flatten({ background }).toColourspace("srgb");
  if (t.denoise > 1) {
    pipeline = pipeline.median(t.denoise);
    steps.push(`despeckled (median ${String(t.denoise)})`);
  }
  if (t.blur > 0) {
    pipeline = pipeline.blur(t.blur);
    steps.push(`softened gradients (blur ${String(t.blur)})`);
  }
  if (t.saturation !== 1) {
    pipeline = pipeline.modulate({ saturation: t.saturation });
    steps.push(`colour separation widened (saturation ×${t.saturation.toFixed(2)})`);
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const pixels = width * height;
  const channels = info.channels;
  const rgb = toRgb(data, channels, pixels);

  const layers: Layer[] = [];
  const paper = "#ffffff";

  if (t.mode === "binary") {
    // --- ink / paper, split at the anti-aliasing ramp -------------------
    const luma = new Uint8Array(pixels);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < pixels; i++, p += 3) {
      const v = (rgb[p] * 299 + rgb[p + 1] * 587 + rgb[p + 2] * 114 + 500) / 1000 | 0;
      luma[i] = v;
      hist[v]++;
    }
    const otsuCut = otsu(hist, pixels);
    const cut = Math.round(clamp(otsuCut + (detail - 0.5) * 30, 32, 224));
    // Ink is the minority tone: dark ink on paper, or light chalk on a board.
    let below = 0;
    for (let i = 0; i < pixels; i++) if (luma[i] < cut) below++;
    const inkIsDark = below <= pixels / 2;
    const labels = new Uint16Array(pixels);
    for (let i = 0; i < pixels; i++) {
      const isInk = inkIsDark ? luma[i] < cut : luma[i] >= cut;
      labels[i] = isInk ? 1 : 0;
    }
    steps.push(`auto-levelled, split ink/paper at luminance ${String(cut)} (Otsu)`);

    const stats = labelStats(labels, width, height, 2);
    if (stats[0].pixels === 0 || stats[1].pixels === 0) {
      // Nothing to separate — emit a single flat rectangle.
      const only = stats[1].pixels === 0 ? paper : "#000000";
      const svg = wrapSvg(width, height, `<rect width="${String(width)}" height="${String(height)}" fill="${only}"/>`);
      return finish(svg, Date.now() - started, steps);
    }
    // The two colours, taken from the *colour* buffer and as the modal tone of
    // each side: white paper stays #ffffff instead of drifting grey.
    const palette = modalColours(labels, rgb, 2);
    // Largest region first, so the paper is the label painted under the ink.
    const paperFirst = stats[0].pixels >= stats[1].pixels;
    const ordered = paperFirst ? [0, 1] : [1, 0];
    const reindex = new Uint16Array(2);
    ordered.forEach((l, i) => {
      reindex[l] = i;
    });
    const ranked = new Uint16Array(pixels);
    for (let i = 0; i < pixels; i++) ranked[i] = reindex[labels[i]];
    const sortedPalette = ordered.map((l) => palette[l]);
    const cov = layerCoverage(ranked, sortedPalette, rgb, 3, width, height);
    const sortedStats = ordered.map((l) => stats[l]);
    for (let label = 0; label < 2; label++) {
      const contoured = contoursForLabel(ranked, cov, label, width, height, sortedStats[label].bbox, core, true);
      if (!contoured.length) continue;
      const packed = sortedPalette[label];
      layers.push(collect(contoured, [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255]));
    }
    steps.push(`ink is ${hex(unpack(sortedPalette[1]))} on ${hex(unpack(sortedPalette[0]))}`);
    const body = layers
      .map((l) => `<path fill="${hex(l.colour)}" d="${l.d}"/>`)
      .join("");
    const rect = `<rect width="${String(width)}" height="${String(height)}" fill="${hex(unpack(sortedPalette[0]))}"/>`;
    const svg = wrapSvg(width, height, rect + body);
    const curves = layers.reduce((s, l) => s + l.curves, 0);
    steps.push(detailStep(layers, curves, core));
    return finish(svg, Date.now() - started, steps);
  }

  // --- colour regions ----------------------------------------------------
  const wanted = Math.round(lerp(t.regions[0], t.regions[1], detail));
  const tolerance = lerp(t.tolerance[0], t.tolerance[1], detail);
  const seg = segment(rgb, 3, width, height, {
    tolerance,
    maxRegions: wanted,
    minArea: lerp(t.minArea[0], t.minArea[1], detail),
    mergeBands: t.mergeBands,
    bandWidth: t.bandWidth,
  });
  steps.push(
    `segmented into ${String(seg.count)} flat colours (tolerance ${String(Math.round(seg.tolerance))}, from ${String(seg.grown)} regions` +
      (seg.bandMerges ? `, ${String(seg.bandMerges)} anti-aliasing bands merged` : "") +
      (seg.smallMerges ? `, ${String(seg.smallMerges)} specks merged` : "") +
      ")",
  );
  const stats = labelStats(seg.labels, width, height, seg.count);
  const cov = layerCoverage(seg.labels, seg.palette, rgb, 3, width, height);
  for (let label = 0; label < seg.count; label++) {
    if (seg.areas[label] === 0) continue;
    const contoured = contoursForLabel(seg.labels, cov, label, width, height, stats[label].bbox, core, true);
    if (!contoured.length) continue;
    const packed = seg.palette[label];
    layers.push(collect(contoured, [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255]));
  }
  steps.push(`traced ${String(layers.length)} colour layers`);

  // Largest layer first: each layer is an opaque, self-contained shape, so
  // painting them biggest-first stacks correctly (holes are winding-cut inside
  // each layer, so whatever is underneath shows through).
  const body = layers.map((l) => `<path fill="${hex(l.colour)}" d="${l.d}"/>`).join("");
  const svg = wrapSvg(width, height, body);

  const curves = layers.reduce((s, l) => s + l.curves, 0);
  steps.push(detailStep(layers, curves, core));
  return finish(svg, Date.now() - started, steps);
}

function detailStep(layers: Layer[], curves: number, core: CoreOptions): string {
  return (
    `sub-pixel contours: ${String(layers.reduce((s, l) => s + l.contours, 0))} shapes, ${String(curves)} cubic curves, ` +
    `field \u03c3 ${String(core.sigma)}px, fit \u00b1${core.fitError.toFixed(2)}px`
  );
}

/**
 * Contour one label out of a label map: its coverage field, smoothed, then
 * traced. `withMargin` widens the sample rectangle so the smoothing kernel
 * never reads a neighbouring region's body as if it were this one's edge.
 */
function contoursForLabel(
  labels: Uint16Array,
  cov: ReturnType<typeof layerCoverage>,
  label: number,
  width: number,
  height: number,
  bbox: [number, number, number, number],
  core: CoreOptions,
  withMargin: boolean,
): Contoured[] {
  const [bx0, by0, bx1, by1] = bbox;
  if (bx1 < bx0 || by1 < by0) return [];
  const margin = withMargin ? fieldMargin(core.sigma) : 0;
  const x0 = bx0 - margin;
  const y0 = by0 - margin;
  const fw = bx1 - bx0 + 1 + 2 * margin;
  const fh = by1 - by0 + 1 + 2 * margin;
  const raw = layerField(labels, cov, label, width, height, x0, y0, fw, fh);
  const field = core.sigma > 0 ? smoothField(raw, fw, fh, core.sigma) : raw;
  return contoursForField(field, fw, fh, x0, y0, core);
}

function unpack(packed: number): [number, number, number] {
  return [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
}

function collect(contoured: Contoured[], colour: [number, number, number]): Layer {
  return {
    d: contoured.map((c) => c.d).join(""),
    colour,
    area: contoured.reduce((s, c) => s + c.area, 0),
    contours: contoured.length,
    curves: contoured.reduce((s, c) => s + c.curves, 0),
  };
}

/** A self-describing, scalable SVG: explicit size, matching viewBox, no bitmaps. */
function wrapSvg(width: number, height: number, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" ` +
    `viewBox="0 0 ${String(width)} ${String(height)}">${body}</svg>\n`
  );
}

function finish(svg: string, ms: number, steps: string[]): TraceResult {
  const dims = /width="(\d+)" height="(\d+)"/.exec(svg);
  return {
    svg,
    width: Number(dims?.[1] ?? 0),
    height: Number(dims?.[2] ?? 0),
    pathCount: countPaths(svg),
    colourCount: countColours(svg),
    bytes: Buffer.byteLength(svg, "utf8"),
    ms,
    steps,
  };
}
