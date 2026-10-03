/**
 * Tracecraft tracing engine (server-only).
 *
 * Raster -> SVG through the sub-pixel tracer in `./trace-core.server`: every
 * upload is preprocessed into either a set of flat colour regions or a 1-bit ink
 * mask, and each region is then contoured as a *coverage level set* (so vertices
 * are sub-pixel accurate and carry no pixel staircase) and fitted with real cubic
 * Béziers between detected corners.
 *
 * The old engine handed a deliberately downscaled bitmap to a tracer that followed
 * pixel boundaries, so its geometry *was* the raster's grid — hence output that
 * pixelated as soon as you zoomed. The preprocessing here exists only to make the
 * regions the tracer contours correct and flat; the geometry no longer inherits
 * the raster's resolution.
 *
 * Everything happens in memory buffers — an uploaded image is never written to
 * disk, stored, or logged.
 */
import sharp from "sharp";
import { quantiseLabels } from "./quantise";
import { contoursForMask, hex, labelStats, type CoreOptions, type Contoured } from "./trace-core.server";

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
 * `sigma` is the coverage-field smoothing in working pixels: it is what turns a
 * pixel-boundary silhouette into a continuous level set, and it is deliberately
 * well under a pixel so that hairlines and corners survive.
 *
 * `fitError` is the maximum deviation the Bézier fit is allowed, in working
 * pixels — the whole point of a sub-pixel tracer is that this can be tight.
 *
 * `minArea` (px²) drops noise specks; it stays tiny so genuine dots and 1px
 * hairlines are traced rather than filtered away.
 */
interface PresetTuning {
  mode: "binary" | "color";
  /** [at detail 1, at detail 0] palette size for colour presets. */
  colours: [number, number];
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
  /** Line art only: luminance cut for the ink mask. */
  threshold: number;
}

export const TUNING: Record<PresetId, PresetTuning> = {
  // Flat art, few colours, hard edges. Fine field, tight fit: corners and
  // straight edges have to stay dead straight.
  logo: {
    mode: "color",
    colours: [24, 8],
    fitError: [0.32, 0.5],
    minArea: [1, 6],
    sigma: 0.7,
    cornerAngle: 30,
    maxDim: 2400,
    minDim: 700,
    denoise: 1,
    blur: 0,
    saturation: 1,
    threshold: 140,
  },
  // Ink / pencil drawings: auto-levelled, denoised, cut to an ink mask, then
  // traced as a single ink layer over its own paper colour.
  lineart: {
    mode: "binary",
    colours: [2, 2],
    fitError: [0.28, 0.45],
    minArea: [0.6, 3],
    sigma: 0.6,
    cornerAngle: 34,
    maxDim: 2600,
    minDim: 900,
    denoise: 3,
    blur: 0,
    saturation: 1,
    threshold: 140,
  },
  // Photographs: many subtle shades. More smoothing (grain must not become
  // geometry), fewer, larger regions, and a looser fit because the "edges" are
  // gradients rather than lines.
  photo: {
    mode: "color",
    colours: [40, 12],
    fitError: [0.5, 0.9],
    minArea: [2, 14],
    sigma: 0.9,
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
    colours: [32, 10],
    fitError: [0.3, 0.55],
    minArea: [0.8, 6],
    sigma: 0.6,
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
 * Preprocess + trace. Buffers only — nothing touches the filesystem.
 */
export async function traceImage(input: Buffer, options: TraceOptions): Promise<TraceResult> {
  const started = Date.now();
  const preset: PresetId = (PRESET_IDS as readonly string[]).includes(options.preset) ? options.preset : "logo";
  const t = TUNING[preset];
  const detail = clamp(options.detail ?? 0.5, 0, 1);
  const background = options.background ?? "#ffffff";
  const steps: string[] = [];

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

  const core = coreOptions(preset, detail);
  const layers: Layer[] = [];
  let width = meta.width;
  let height = meta.height;
  let paper = "#ffffff";
  let ink = "#000000";

  if (t.mode === "binary") {
    const cut = clamp(t.threshold + (detail - 0.5) * 40, 40, 236);
    pipeline = pipeline.grayscale().normalise();
    if (t.denoise > 1) pipeline = pipeline.median(t.denoise);
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    width = info.width;
    height = info.height;
    const pixels = width * height;
    const mask = new Uint8Array(pixels);
    let mean = 0;
    for (let i = 0; i < pixels; i++) mean += data[i];
    mean /= pixels;
    // Ink is the minority tone: dark ink on paper, or light chalk on a board.
    const darkIsInk = mean >= 128;
    let inkR = 0;
    let inkG = 0;
    let inkB = 0;
    let inkN = 0;
    let paperR = 0;
    let paperG = 0;
    let paperB = 0;
    let paperN = 0;
    const rgb = toRgb(data, info.channels, pixels);
    for (let i = 0, p = 0; i < pixels; i++, p += 3) {
      const v = data[i];
      const isInk = darkIsInk ? v < cut : v > cut;
      mask[i] = isInk ? 1 : 0;
      if (isInk) {
        inkR += rgb[p];
        inkG += rgb[p + 1];
        inkB += rgb[p + 2];
        inkN++;
      } else {
        paperR += rgb[p];
        paperG += rgb[p + 1];
        paperB += rgb[p + 2];
        paperN++;
      }
    }
    if (inkN > 0) ink = hex([inkR / inkN, inkG / inkN, inkB / inkN]);
    if (paperN > 0) paper = hex([paperR / paperN, paperG / paperN, paperB / paperN]);
    steps.push(`auto-levelled, denoised, 1-bit ink mask at luminance ${String(Math.round(cut))}`);
    if (inkN === 0 || paperN === 0) {
      // Nothing to separate — emit a single flat rectangle.
      const only = inkN === 0 ? paper : ink;
      const svg = wrapSvg(
        width,
        height,
        `<rect width="${String(width)}" height="${String(height)}" fill="${only}"/>`,
      );
      return finish(svg, Date.now() - started, steps);
    }
    const contoured = contoursForMask(mask, width, height, [0, 0, width - 1, height - 1], core);
    layers.push(collect(contoured, rgbOf(ink)));
  } else {
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
    width = info.width;
    height = info.height;
    const pixels = width * height;
    const wanted = Math.round(lerp(t.colours[0], t.colours[1], detail));
    const rgb = toRgb(data, info.channels, pixels);
    const { labels, palette } = quantiseLabels(rgb, 3, width, height, wanted);
    steps.push(`quantised to ${String(palette.length)} flat colours (median cut)`);
    const stats = labelStats(labels, width, height, palette.length);
    const order = stats
      .map((s, i) => ({ i, pixels: s.pixels, bbox: s.bbox }))
      .filter((s) => s.pixels > 0)
      .sort((a, b) => b.pixels - a.pixels);
    const mask = new Uint8Array(pixels);
    let prev: [number, number, number, number] | null = null;
    for (const s of order) {
      // Only the previous layer's bounding box needs clearing, and only this
      // layer's box needs setting: cheap even with 40 layers.
      if (prev) {
        for (let y = prev[1]; y <= prev[3]; y++) mask.fill(0, y * width + prev[0], y * width + prev[2] + 1);
      }
      for (let y = s.bbox[1]; y <= s.bbox[3]; y++) {
        const row = y * width;
        for (let x = s.bbox[0]; x <= s.bbox[2]; x++) if (labels[row + x] === s.i) mask[row + x] = 1;
      }
      prev = s.bbox;
      const contoured = contoursForMask(mask, width, height, s.bbox, core);
      if (!contoured.length) continue;
      const packed = palette[s.i];
      layers.push(collect(contoured, [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255]));
    }
    steps.push(`traced ${String(layers.length)} colour layers`);
  }

  // Largest layer first: each layer is an opaque, self-contained shape, so
  // painting them biggest-first stacks correctly (holes are winding-cut inside
  // each layer, so whatever is underneath shows through).
  const body = layers
    .map((l) => `<path fill="${hex(l.colour)}" d="${l.d}"/>`)
    .join("");
  const rect = t.mode === "binary" ? `<rect width="${String(width)}" height="${String(height)}" fill="${paper}"/>` : "";
  const svg = wrapSvg(width, height, rect + body);

  const curves = layers.reduce((s, l) => s + l.curves, 0);
  steps.push(
    `sub-pixel contours: ${String(layers.reduce((s, l) => s + l.contours, 0))} shapes, ${String(curves)} cubic curves, field \u03c3 ${String(core.sigma)}px, fit \u00b1${core.fitError.toFixed(2)}px`,
  );
  return finish(svg, Date.now() - started, steps);
}

function rgbOf(colour: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour.trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
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
