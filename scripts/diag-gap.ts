/**
 * Diagnose missing paint: for each preset, rebuild the label map, then for every
 * label derive the coverage field the tracer actually contours (bbox+margin,
 * smoothed) and count how many pixels the field's iso-0.5 level set covers.
 *
 * Prints, per label, area vs covered, so dropped or vanishing regions are named.
 */
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { TUNING, coreOptions, PRESET_IDS, type PresetId } from "../src/trace.server";
import { segment } from "../src/segment";
import { labelStats, layerCoverage, layerField, smoothField, fieldMargin, contoursForField } from "../src/trace-core.server";

const FIX = "/home/team/shared/trace-lab/fixtures";
const FILES: Record<PresetId, string> = {
  logo: "logo-flat.png",
  lineart: "lineart-thin-diagonal.png",
  photo: "photo-portrait.jpg",
  pattern: "pattern-textile.png",
};

const preset = (process.argv[2] ?? "pattern") as PresetId;
const detail = 0.5;
const t = TUNING[preset];
const core = coreOptions(preset, detail);

const meta = await sharp(`${FIX}/${FILES[preset]}`).metadata();
const longEdge = Math.max(meta.width!, meta.height!);
const target = Math.min(t.maxDim, Math.max(t.minDim, longEdge));
let p = sharp(`${FIX}/${FILES[preset]}`).rotate();
if (target !== longEdge) {
  p = p.resize({ width: Math.round((meta.width! * target) / longEdge), height: Math.round((meta.height! * target) / longEdge), fit: "fill", kernel: "lanczos3" });
}
p = p.flatten({ background: "#ffffff" }).toColourspace("srgb");
if (t.denoise > 1) p = p.median(t.denoise);
if (t.blur > 0) p = p.blur(t.blur);
if (t.saturation !== 1) p = p.modulate({ saturation: t.saturation });
const { data, info } = await p.raw().toBuffer({ resolveWithObject: true });
const width = info.width, height = info.height;
const rgb = Buffer.alloc(width * height * 3);
for (let i = 0; i < width * height; i++) {
  const s = i * info.channels;
  rgb[i * 3] = data[s]; rgb[i * 3 + 1] = data[s + 1]; rgb[i * 3 + 2] = data[s + 2];
}
console.log(`${preset}: working ${width}x${height} (source ${meta.width}x${meta.height}), detail ${detail}`);

const wanted = Math.round((t.regions[0] + (t.regions[1] - t.regions[0]) * detail));
const tol = t.tolerance[0] + (t.tolerance[1] - t.tolerance[0]) * detail;
const seg = segment(rgb, 3, width, height, {
  tolerance: tol, maxRegions: wanted,
  minArea: t.minArea[0] + (t.minArea[1] - t.minArea[0]) * detail,
  mergeBands: t.mergeBands, bandWidth: t.bandWidth,
});
console.log(`grew ${seg.grown} -> ${seg.count} regions (tolerance ${seg.tolerance.toFixed(1)}, wanted ${wanted}), bandMerges ${seg.bandMerges} smallMerges ${seg.smallMerges}`);

const stats = labelStats(seg.labels, width, height, seg.count);
const cov = layerCoverage(seg.labels, seg.palette, rgb, 3, width, height);
const covered = new Uint8Array(width * height);
const rows: string[] = [];
let dropped = 0, droppedPx = 0, vanish = 0, vanishPx = 0;
let totalCover = 0;
for (let label = 0; label < seg.count; label++) {
  const area = seg.areas[label];
  if (area === 0) continue;
  const [bx0, by0, bx1, by1] = stats[label].bbox;
  const margin = fieldMargin(core.sigma);
  const fw = bx1 - bx0 + 1 + 2 * margin, fh = by1 - by0 + 1 + 2 * margin;
  const raw = layerField(seg.labels, cov, label, width, height, bx0 - margin, by0 - margin, fw, fh);
  let rawMax = 0;
  for (const v of raw) if (v > rawMax) rawMax = v;
  const field = smoothField(raw, fw, fh, core.sigma);
  // field >= 0.5 cells
  let n = 0;
  for (let fy = 0; fy < fh; fy++) {
    const sy = by0 - margin + fy;
    if (sy < 0 || sy >= height) continue;
    for (let fx = 0; fx < fw; fx++) {
      const sx = bx0 - margin + fx;
      if (sx < 0 || sx >= width) continue;
      if (field[fy * fw + fx] >= 0.5) { covered[sy * width + sx] = 1; n++; }
    }
  }
  totalCover += n;
  const shapes = contoursForField(field, fw, fh, bx0 - margin, by0 - margin, core);
  if (area >= 20) {
    if (!shapes.length) { dropped++; droppedPx += area; rows.push(`  DROPPED label ${label} area ${area} rawMax ${rawMax.toFixed(2)} bbox ${bx0},${by0},${bx1},${by1} colour #${seg.palette[label].toString(16).padStart(6, "0")}`); }
    else if (n < area * 0.5) { vanish++; vanishPx += area; rows.push(`  SHRUNK  label ${label} area ${area} covered ${n} rawMax ${rawMax.toFixed(2)} colour #${seg.palette[label].toString(16).padStart(6, "0")}`); }
  }
}
let unpainted = 0, sumUnder = 0, sumOver = 0;
for (let i = 0; i < width * height; i++) if (!covered[i]) unpainted++;
console.log(`field>=0.5 covers ${(totalCover / (width * height) * 100).toFixed(2)}% ; pixels with NO covering label: ${unpainted} (${(unpainted / (width * height) * 100).toFixed(2)}%)`);
console.log(`big regions dropped entirely: ${dropped} (${droppedPx}px); shrunk >50%: ${vanish} (${vanishPx}px)`);
console.log(rows.slice(0, 25).join("\n"));
