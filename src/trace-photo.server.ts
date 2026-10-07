/**
 * Tracecraft photo engine (server-only) — the previous colour-clustering path.
 *
 * Photographs are continuous tone: there is no "ink/paper" split and no stable
 * flat region to give sub-pixel contours to, so the sub-pixel coverage core is
 * the wrong tool — run on a photo it shatters the gradients into thousands of
 * mid-tone specks (posterised bands and white holes). vtracer's hierarchical
 * colour clustering with cutout layering is, by contrast, exactly built for
 * this: it merges neighbouring shades into a small number of smooth, separable
 * layers and keeps the result flat and faithful.
 *
 * So the photo preset keeps this engine while logo / line art / pattern run the
 * sub-pixel core. The pipeline here is unchanged from the engine that produced
 * the smooth, faithful photo output currently shipped, so this is parity, not a
 * new experiment.
 *
 * Everything happens in memory buffers — an uploaded image is never written to
 * disk, stored, or logged.
 */
import { optimize, vectorizeRaw } from "@neplex/vectorizer";
import sharp from "sharp";
import type { PresetId } from "./trace.server";

// `@neplex/vectorizer` exposes its enums as plain i32s at runtime (the TS
// `declare enum`s are erased), so these constants are the ABI, not a style choice.
const COLOR_MODE = 0; // color
const HIERARCHICAL = 1; // cutout
const SIMPLIFY_SPLINE = 2;
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

/**
 * Photo tuning, carried over verbatim. Blur first so neighbouring shades merge,
 * cutout layering so the result is not a stack of overlapping translucent
 * blobs, a smaller working size because photos explode into paths, and speckle
 * filtering that is generous enough to erase sensor grain.
 */
const PHOTO = {
  speckle: [4, 24] as [number, number],
  precision: [8, 5] as [number, number],
  layers: [20, 72] as [number, number],
  cornerThreshold: 60,
  lengthThreshold: 4,
  spliceThreshold: 45,
  pathPrecision: 2,
  maxDim: 1100,
  minDim: 800,
  median: 3,
  blur: 0.7,
  saturation: 1.04,
};

export interface PhotoTraceResult {
  svg: string;
  width: number;
  height: number;
  pathCount: number;
  colourCount: number;
  bytes: number;
  ms: number;
  steps: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function buildConfig(detail: number): NativeConfig {
  const d = clamp(detail, 0, 1);
  return {
    colorMode: COLOR_MODE,
    hierarchical: HIERARCHICAL,
    filterSpeckle: Math.round(lerp(PHOTO.speckle[0], PHOTO.speckle[1], d)),
    colorPrecision: Math.round(lerp(PHOTO.precision[0], PHOTO.precision[1], d)),
    layerDifference: Math.round(lerp(PHOTO.layers[0], PHOTO.layers[1], d)),
    mode: SIMPLIFY_SPLINE,
    cornerThreshold: PHOTO.cornerThreshold,
    lengthThreshold: PHOTO.lengthThreshold,
    maxIterations: 10,
    spliceThreshold: PHOTO.spliceThreshold,
    pathPrecision: PHOTO.pathPrecision,
  };
}

/** Distinct contours drawn. */
function countPaths(svg: string): number {
  let n = 0;
  for (const d of svg.matchAll(/ d="([^"]*)"/g)) n += (d[1].match(/M/g) ?? []).length;
  return n || (svg.match(/<path\b/g) ?? []).length;
}

function countColours(svg: string): number {
  const seen = new Set<string>();
  for (const m of svg.matchAll(/fill="([^"]+)"/g)) {
    const v = m[1].toLowerCase();
    if (v !== "none") seen.add(v);
  }
  return seen.size;
}

/**
 * Pad/expand any raw sharp buffer to the 4-channel RGBA the napi binding
 * requires. sharp hands back 1 channel after `threshold()` and 3 after a
 * paletted PNG, so a fixed call to `ensureAlpha()` is not enough.
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

export interface PhotoOptions {
  preset?: PresetId;
  detail?: number;
  background?: string;
}

/** Preprocess + trace a photograph. Buffers only — nothing touches the filesystem. */
export async function tracePhoto(input: Buffer, options: PhotoOptions = {}): Promise<PhotoTraceResult> {
  const started = Date.now();
  const detail = clamp(options.detail ?? 0.5, 0, 1);
  const background = options.background ?? "#ffffff";
  const steps: string[] = [];

  // Decode once. `rotate()` bakes in EXIF orientation so the trace is not sideways.
  let pipeline = sharp(input, { limitInputPixels: 64_000_000 }).rotate();
  const meta = await pipeline.metadata();
  if (!meta.width || !meta.height) throw new Error("Unreadable image data");
  if (meta.hasAlpha) steps.push(`transparency flattened onto ${background}`);

  // Photos explode into paths, so the working size is capped rather than raised.
  const longEdge = Math.max(meta.width, meta.height);
  const target = clamp(longEdge, PHOTO.minDim, PHOTO.maxDim);
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

  pipeline = pipeline.flatten({ background }).toColourspace("srgb");
  if (PHOTO.median > 1) {
    pipeline = pipeline.median(PHOTO.median);
    steps.push(`despeckled (median ${String(PHOTO.median)})`);
  }
  if (PHOTO.blur > 0) {
    pipeline = pipeline.blur(PHOTO.blur);
    steps.push(`softened gradients (blur ${String(PHOTO.blur)})`);
  }
  if (PHOTO.saturation !== 1) {
    pipeline = pipeline.modulate({ saturation: PHOTO.saturation });
    steps.push(`colour separation widened (saturation ×${PHOTO.saturation.toFixed(2)})`);
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const rgba = asRgba(data, info.channels);
  const config = buildConfig(detail);
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
