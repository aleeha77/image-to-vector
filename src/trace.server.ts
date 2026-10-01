/**
 * Tracecraft tracing engine (server-only).
 *
 * Raster -> SVG via vtracer (the Rust `visioncortex` vectoriser) through the
 * `@neplex/vectorizer` napi bindings, with a sharp preprocessing stage in front.
 * Colour separation comes from vtracer's hierarchical colour clustering; the
 * preprocessing stage is where most of the perceived quality is won or lost, so
 * every preset bakes its own pipeline (upscale / denoise / colour shaping).
 *
 * Everything happens in memory buffers — an uploaded image is never written to
 * disk, stored, or logged.
 */
import { optimize, vectorizeRaw } from "@neplex/vectorizer";
import sharp from "sharp";

// `@neplex/vectorizer` exposes its enums as plain i32s at runtime (the TS
// `declare enum`s are erased), so these constants are the ABI, not a style choice.
const COLOR_MODE: Record<"color" | "binary", number> = { color: 0, binary: 1 };
const HIERARCHICAL: Record<"stacked" | "cutout", number> = { stacked: 0, cutout: 1 };
const SIMPLIFY: Record<"none" | "polygon" | "spline", number> = { none: 0, polygon: 1, spline: 2 };
const OPTIMIZE_PRESET_SAFE = 1;

/** The shape the napi binding actually accepts. */
interface NativeConfig {
  colorMode: number;
  hierarchical: number;
  filterSpeckle: number;
  colorPrecision: number;
  layerDifference: number;
  mode: number;
  cornerThreshold: number;
  lengthThreshold: number;
  maxIterations: number;
  spliceThreshold: number;
  pathPrecision: number;
}

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
  /** Number of <path> elements — the honest "how much vector detail" measure. */
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

export function countPaths(svg: string): number {
  const m = svg.match(/<path\b/g);
  return m ? m.length : 0;
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
 * Per-preset tuning. `detail` interpolates each knob between its `hi` (detail 1)
 * and `lo` (detail 0) value: more detail means less speckle filtering (small
 * shapes survive), finer colour precision (more distinct colours) and a smaller
 * layer difference (more colour layers are kept apart).
 */
interface PresetTuning {
  colorMode: "color" | "binary";
  hierarchical: "stacked" | "cutout";
  /** [at detail 1, at detail 0] */
  speckle: [number, number];
  precision: [number, number];
  layers: [number, number];
  cornerThreshold: number;
  lengthThreshold: number;
  spliceThreshold: number;
  pathPrecision: number;
  /** Max edge length handed to the vectoriser (time/memory guard). */
  maxDim: number;
  /** Smaller inputs are upscaled to this edge — curve fitting needs pixels. */
  minDim: number;
  /** Median denoise window (1 = off). Kills sensor / print / compression speckle. */
  median: number;
  /** Pre-blur sigma; merges neighbouring shades so photos yield cleaner layers. */
  blur: number;
  /** 1 = untouched; >1 widens the gaps between neighbouring colour clusters. */
  saturation: number;
  /** Line art only: luminance cut for the 1-bit input mask. */
  threshold?: number;
  /**
   * Quantise to this many colours (libimagequant through sharp) before tracing.
   * This is the single biggest quality lever on textiles and photos: it removes
   * print/sensor grain and forces genuinely flat, separable colour regions, so
   * the vectoriser clusters real shapes instead of noise. 0 = off.
   */
  palette: number;
  /** Palette dither amount: 0 keeps flat regions flat, 1 helps photo gradients. */
  dither: number;
}

export const TUNING: Record<PresetId, PresetTuning> = {
  // Flat art, few colours, hard edges. Aggressive clustering, so photo-ish noise
  // in a logo upload collapses into clean flat shapes instead of confetti.
  logo: {
    colorMode: "color",
    hierarchical: "stacked",
    speckle: [3, 12],
    precision: [7, 4],
    layers: [10, 28],
    cornerThreshold: 60,
    lengthThreshold: 3.6,
    spliceThreshold: 45,
    pathPrecision: 2,
    maxDim: 1600,
    minDim: 900,
    median: 3,
    blur: 0,
    saturation: 1.05,
    palette: 24,
    dither: 0,
  },
  // Ink / pencil drawings: auto-levelled, denoised, hard-thresholded to a 1-bit
  // mask, then spline-traced. Far more predictable than letting the vectoriser
  // pick its own threshold on a photograph of paper.
  lineart: {
    colorMode: "binary",
    hierarchical: "stacked",
    speckle: [2, 6],
    precision: [8, 8],
    layers: [16, 16],
    cornerThreshold: 60,
    lengthThreshold: 4,
    spliceThreshold: 45,
    pathPrecision: 3,
    maxDim: 2200,
    minDim: 1100,
    median: 3,
    blur: 0,
    saturation: 1,
    threshold: 140,
    palette: 0,
    dither: 0,
  },
  // Photographs: many subtle shades. Blur first so neighbouring clusters merge,
  // cutout layering so the result is not a stack of overlapping translucent
  // blobs, and a smaller working size because photos explode into paths.
  photo: {
    colorMode: "color",
    hierarchical: "cutout",
    speckle: [4, 24],
    precision: [8, 5],
    layers: [20, 72],
    cornerThreshold: 60,
    lengthThreshold: 4,
    spliceThreshold: 45,
    pathPrecision: 2,
    maxDim: 1100,
    minDim: 800,
    median: 3,
    blur: 0.7,
    saturation: 1.04,
    palette: 48,
    dither: 0,
  },
  // Textiles, dress prints, wallpaper: dense mid-size motifs, dozens of colours,
  // fine dots and hairlines. Speckle filtering stays low so the dots survive,
  // colour precision stays high, and the input is upscaled so thin lines have
  // real pixels to fit curves to.
  pattern: {
    colorMode: "color",
    hierarchical: "stacked",
    speckle: [1, 8],
    precision: [8, 5],
    layers: [16, 40],
    cornerThreshold: 60,
    lengthThreshold: 3.2,
    spliceThreshold: 45,
    pathPrecision: 2,
    maxDim: 1700,
    minDim: 1200,
    median: 3,
    blur: 0,
    saturation: 1.12,
    palette: 40,
    dither: 0,
  },
};

export function buildConfig(preset: PresetId, detail: number): NativeConfig {
  const t = TUNING[preset];
  const d = clamp(detail, 0, 1);
  return {
    colorMode: COLOR_MODE[t.colorMode],
    hierarchical: HIERARCHICAL[t.hierarchical],
    filterSpeckle: Math.round(lerp(t.speckle[0], t.speckle[1], d)),
    colorPrecision: Math.round(lerp(t.precision[0], t.precision[1], d)),
    layerDifference: Math.round(lerp(t.layers[0], t.layers[1], d)),
    mode: SIMPLIFY.spline,
    cornerThreshold: t.cornerThreshold,
    lengthThreshold: t.lengthThreshold,
    maxIterations: 10,
    spliceThreshold: t.spliceThreshold,
    pathPrecision: t.pathPrecision,
  };
}

/**
 * Pad/expand any raw sharp buffer to the 4-channel RGBA the napi binding requires.
 * sharp hands back 1 channel after `threshold()` and 3 after a paletted PNG, so a
 * fixed call to `ensureAlpha()` is not enough (it is not honoured on 1-bit data).
 */
function asRgba(data: Buffer, channels: number): Buffer {
  if (channels === 4) return data;
  const pixels = data.length / channels;
  const out = Buffer.alloc(pixels * 4);
  if (channels === 1) {
    for (let i = 0, o = 0; i < pixels; i++, o += 4) {
      const v = data[i];
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
      out[o + 3] = 255;
    }
  } else {
    for (let i = 0, o = 0, s = 0; i < pixels; i++, o += 4, s += channels) {
      out[o] = data[s];
      out[o + 1] = data[s + 1];
      out[o + 2] = data[s + 2];
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Rebuild the opening <svg> tag with a known-good header: vtracer's own tag has
 * a version attribute but no viewBox, so the output would not scale.
 */
function normaliseSvgHeader(svg: string, width: number, height: number): string {
  const open = svg.match(/<svg\b[^>]*>/);
  if (!open || open.index === undefined) return svg;
  const extra = open[0]
    .slice(4, -1)
    .replace(/\s(?:width|height|viewBox|xmlns|version|baseProfile)="[^"]*"/g, "")
    .trim();
  const header =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}"${extra ? ` ${extra}` : ""}>`;
  const body = svg
    .slice(open.index + open[0].length)
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return header + body;
}

/**
 * Preprocess + trace. Buffers only — nothing touches the filesystem.
 */
export async function traceImage(input: Buffer, options: TraceOptions): Promise<TraceResult> {
  const started = Date.now();
  const preset: PresetId = (PRESET_IDS as readonly string[]).includes(options.preset)
    ? options.preset
    : "logo";
  const t = TUNING[preset];
  const detail = clamp(options.detail ?? 0.5, 0, 1);
  const background = options.background ?? "#ffffff";
  const steps: string[] = [];

  // Decode once. `rotate()` bakes in EXIF orientation so the trace is not sideways.
  let pipeline = sharp(input, { limitInputPixels: 64_000_000 }).rotate();
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) throw new Error("Unreadable image data");
  if (meta.hasAlpha) steps.push(`transparency flattened onto ${background}`);

  // Upscale small inputs (curve fitting needs pixels), cap big ones (time/memory).
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
        ? `upscaled ${String(meta.width)}×${String(meta.height)} for curve fitting`
        : `downscaled ${String(meta.width)}×${String(meta.height)} to keep the trace crisp`,
    );
  }

  if (preset === "lineart") {
    // Detail raises the cut a little: a higher threshold keeps fainter strokes.
    const cut = clamp((t.threshold ?? 128) + (detail - 0.5) * 40, 60, 220);
    pipeline = pipeline.grayscale().normalise();
    if (t.median > 1) pipeline = pipeline.median(t.median);
    pipeline = pipeline.threshold(cut);
    steps.push(`auto-levelled, despeckled, 1-bit at luminance ${String(Math.round(cut))}`);
  } else {
    pipeline = pipeline.flatten({ background }).toColourspace("srgb");
    if (t.median > 1) {
      pipeline = pipeline.median(t.median);
      steps.push(`despeckled (median ${String(t.median)})`);
    }
    if (t.blur > 0) {
      pipeline = pipeline.blur(t.blur);
      steps.push(`softened gradients (blur ${String(t.blur)})`);
    }
    if (t.saturation !== 1) {
      pipeline = pipeline.modulate({ saturation: t.saturation });
      steps.push(`colour separation widened (saturation ×${t.saturation.toFixed(2)})`);
    }
    if (t.palette > 0) {
      // Round-trip through a palette PNG: libimagequant merges the grain into flat
      // colour regions, which is what makes a busy print trace as clean shapes.
      const quantised = await pipeline
        .png({ palette: true, colours: t.palette, dither: t.dither, effort: 6, compressionLevel: 0 })
        .toBuffer();
      pipeline = sharp(quantised).toColourspace("srgb");
      steps.push(`quantised to ${String(t.palette)} colours (libimagequant)`);
    }
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const rgba = asRgba(data, info.channels);
  const config = buildConfig(preset, detail);
  steps.push(
    `traced ${String(info.width)}×${String(info.height)} · ${String(config.filterSpeckle)}px speckle` +
      ` · ${String(config.colorPrecision)}-bit colour · ${String(config.layerDifference)} layer delta`,
  );

  const raw = await vectorizeRaw(rgba, { width: info.width, height: info.height }, config);

  // Optimise (mostly colour/spacing shortening) for a smaller download. A failure
  // here is never allowed to cost the visitor their trace.
  let svg = raw;
  try {
    svg = await optimize(raw, { preset: OPTIMIZE_PRESET_SAFE, multipass: true });
  } catch {
    svg = raw;
  }
  svg = normaliseSvgHeader(svg, info.width, info.height);
  if (!svg.endsWith("\n")) svg += "\n";

  return {
    svg,
    width: info.width,
    height: info.height,
    pathCount: countPaths(svg),
    colourCount: countColours(svg),
    bytes: Buffer.byteLength(svg, "utf8"),
    ms: Date.now() - started,
    steps,
  };
}
