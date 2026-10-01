/**
 * Tracecraft tracing engine (server-only).
 *
 * Raster -> SVG via vtracer (the Rust `visioncortex` vectoriser) through the
 * `@neplex/vectorizer` napi bindings, with a sharp preprocessing stage in front.
 * Colour separation comes from vtracer's hierarchical colour clustering; the
 * preprocessing stage is where most of the perceived quality is won or lost, so
 * every preset bakes its own pipeline (upscale / denoise / colour shaping).
 *
 * Server-only: imported exclusively from the `traceImage` server function, so the
 * client bundle never sees sharp or the native addon.
 */
import { optimize, vectorize, type Config, type Preset } from "@neplex/vectorizer";
import sharp from "sharp";

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
  /** Flatten transparency onto this colour instead of letting it become holes. */
  background?: string;
}

export interface TraceResult {
  svg: string;
  width: number;
  height: number;
  /** Number of <path> elements in the output — the honest "detail" measure. */
  pathCount: number;
  bytes: number;
  ms: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Round to 3 decimals and strip the trailing noise a float would print. */
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A tiny 1-bit + 8-bit check to tell an SVG that actually has vector content. */
export function countPaths(svg: string): number {
  const m = svg.match(/<path\b/g);
  return m ? m.length : 0;
}

/**
 * Per-preset tuning. `detail` is interpolated between the `lo`/`hi` pair of each
 * knob: filterSpeckle falls with detail (less despeckling = more shapes kept),
 * colour precision and layer difference rise with it (more distinct colours).
 */
interface PresetTuning {
  vectorizer: Omit<Config, "filterSpeckle" | "colorPrecision" | "layerDifference">;
  speckle: [number, number]; // [at detail 1, at detail 0]
  precision: [number, number]; // [at detail 1, at detail 0]
  layers: [number, number]; // [at detail 1, at detail 0]
  /** Max edge length fed to the vectoriser. */
  maxDim: number;
  /** Upscale smaller inputs to this edge — curve fitting needs pixels. */
  minDim: number;
  /** Median denoise window (0 = off). Kills sensor/compression speckle. */
  median: number;
  /** Pre-blur sigma; smooths gradients so the clustering makes fewer, cleaner layers. */
  blur: number;
  /** 1 = untouched. Slightly >1 widens the gaps between neighbouring colour clusters. */
  saturation: number;
  /** Line-art only: luminance cut for the 1-bit input, offset by detail. */
  threshold?: number;
}

const TUNING: Record<PresetId, PresetTuning> = {
  // Flat art, few colours, hard edges. Aggressive clustering: any photo-ish noise
  // in a logo upload should collapse into clean flat shapes.
  logo: {
    vectorizer: {
      colorMode: "color" as never,
      hierarchical: "stacked" as never,
      mode: "spline" as never,
      cornerThreshold: 60,
      lengthThreshold: 3.6,
      maxIterations: 10,
      spliceThreshold: 45,
      pathPrecision: 2,
    },
    speckle: [3, 12],
    precision: [7, 4],
    layers: [12, 32],
    maxDim: 1600,
    minDim: 900,
    median: 3,
    blur: 0,
    saturation: 1.05,
  },
  // Ink / pencil drawings: 1-bit input, then a spline trace of the mask.
  lineart: {
    vectorizer: {
      colorMode: "binary" as never,
      hierarchical: "stacked" as never,
      mode: "spline" as never,
      cornerThreshold: 60,
      lengthThreshold: 4,
      maxIterations: 10,
      spliceThreshold: 45,
      pathPrecision: 3,
    },
    speckle: [2, 6],
    precision: [8, 8],
    layers: [16, 16],
    maxDim: 2200,
    minDim: 1100,
    median: 3,
    blur: 0,
    saturation: 1,
    threshold: 140,
  },
  // Photographs: many subtle shades. Blur first so neighbouring clusters merge,
  // cutout layering so the output is not a stack of overlapping translucent blobs.
  photo: {
    vectorizer: {
      colorMode: "color" as never,
      hierarchical: "cutout" as never,
      mode: "spline" as never,
      cornerThreshold: 60,
      lengthThreshold: 4,
      maxIterations: 10,
      spliceThreshold: 45,
      pathPrecision: 2,
    },
    speckle: [4, 24],
    precision: [8, 5],
    layers: [24, 80],
    maxDim: 1100,
    minDim: 800,
    median: 3,
    blur: 0.7,
    saturation: 1.04,
  },
  // Textiles, dress prints, wallpaper: dense mid-size motifs, dozens of colours,
  // fine dots and hairlines. Keep speckle filtering low so the dots survive,
  // keep more colour precision, and upscale so thin lines get real pixels.
  pattern: {
    vectorizer: {
      colorMode: "color" as never,
      hierarchical: "stacked" as never,
      mode: "spline" as never,
      cornerThreshold: 60,
      lengthThreshold: 3.2,
      maxIterations: 10,
      spliceThreshold: 45,
      pathPrecision: 2,
    },
    speckle: [1, 8],
    precision: [8, 5],
    layers: [18, 44],
    maxDim: 1700,
    minDim: 1200,
    median: 3,
    blur: 0,
    saturation: 1.12,
  },
};

function buildConfig(preset: PresetId, detail: number): Config {
  const t = TUNING[preset];
  const d = clamp(detail, 0, 1);
  return {
    ...t.vectorizer,
    filterSpeckle: Math.round(lerp(t.speckle[0], t.speckle[1], d)),
    colorPrecision: Math.round(lerp(t.precision[0], t.precision[1], d)),
    layerDifference: Math.round(lerp(t.layers[0], t.layers[1], d)),
  };
}

/**
 * Preprocess + trace. Never writes to disk: everything happens in buffers, so a
 * visitor's image exists only for the life of the request.
 */
export async function traceImage(input: Buffer, options: TraceOptions): Promise<TraceResult> {
  const started = Date.now();
  const preset = PRESET_IDS.includes(options.preset) ? options.preset : "logo";
  const t = TUNING[preset];
  const detail = clamp(options.detail ?? 0.5, 0, 1);
  const background = options.background ?? "#ffffff";

  // Decode once; `rotate()` bakes in EXIF orientation so the trace is not sideways.
  let pipeline = sharp(input, { limitInputPixels: 64_000_000 }).rotate();
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) throw new Error("Unreadable image data");

  // Upscale small inputs (curve fitting needs pixels), cap big ones (time/memory).
  const longEdge = Math.max(meta.width, meta.height);
  const target = clamp(longEdge, t.minDim, t.maxDim);
  if (Math.abs(target - longEdge) > 1) {
    pipeline = pipeline.resize({
      width: meta.width >= meta.height ? target : undefined,
      height: meta.height > meta.width ? target : undefined,
      kernel: longEdge < target ? "lanczos3" : "lanczos3",
      fit: "fill",
    });
  }

  if (preset === "lineart") {
    // Auto-level, denoise, then a hard luminance cut — a 1-bit mask traces far
    // cleaner than letting the vectoriser guess a threshold on a photo of paper.
    const cut = clamp((t.threshold ?? 128) + (0.5 - detail) * 40, 60, 220);
    pipeline = pipeline
      .grayscale()
      .normalise()
      .median(t.median || 1)
      .threshold(cut);
  } else {
    // Flatten alpha onto the chosen background: transparent pixels otherwise become
    // ragged holes, which reads as noise in the traced SVG.
    pipeline = pipeline.flatten({ background }).toColourspace("srgb");
    if (t.median > 0) pipeline = pipeline.median(t.median);
    if (t.blur > 0) pipeline = pipeline.blur(t.blur);
    if (t.saturation !== 1) pipeline = pipeline.modulate({ saturation: t.saturation });
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });

  const vectorStart = Date.now();
  const svgRaw = await vectorizeRawPixels(data, info.width, info.height, buildConfig(preset, detail));
  const vectorMs = Date.now() - vectorStart;

  // Optimise (drop stray attributes / metadata) but never round coordinates away —
  // that is where the curve quality lives.
  let svg = svgRaw;
  try {
    svg = await optimize(svgRaw, {
      preset: "safe" as never,
      multipass: true,
      omit: ["removeViewBox", "cleanupNumericValues", "convertPathData", "mergePaths"],
    });
  } catch {
    svg = svgRaw; // optimisation is a bonus; never fail a trace over it
  }

  // Give the SVG the source pixel dimensions so it renders at the right size.
  svg = svg.replace(
    /<svg\b[^>]*>/,
    (tag) =>
      tag
        .replace(/\swidth="[^"]*"/, "")
        .replace(/\sheight="[^"]*"/, "") +
      ` width="${info.width}" height="${info.height}"`,
  );
  svg = svg.replace(
    /<svg\b/,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${info.width} ${info.height}"`,
  );
  // The regex above can double the xmlns if the optimiser kept one — normalise.
  svg = svg.replace(/<svg\b[^>]*>/, (tag) => {
    const hasViewBox = /\sviewBox=/.test(tag);
    let out = tag.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"\s*/g, "").trimEnd();
    out = `<svg xmlns="http://www.w3.org/2000/svg"${hasViewBox ? "" : ` viewBox="0 0 ${info.width} ${info.height}"`} ${out.slice(5).trim()}>`;
    return out.replace(/\s+/g, " ").replace(/ >/, ">");
  });

  const bytes = Buffer.byteLength(svg, "utf8");
  return {
    svg,
    width: info.width,
    height: info.height,
    pathCount: countPaths(svg),
    bytes,
    ms: Date.now() - started + (vectorMs - vectorMs), // total wall time, kept explicit
  };
}

async function vectorizeRawPixels(
  pixels: Buffer,
  width: number,
  height: number,
  config: Config,
): Promise<string> {
  // `vectorize` on the raw RGBA buffer avoids re-encoding the preprocessed image.
  const { vectorizeRaw } = await import("@neplex/vectorizer");
  return vectorizeRaw(pixels, { width, height }, config);
}

export type { Config, Preset };
export { r3 };
