/**
 * Per-label lost coverage: rebuild the label map, compute each label's field>=0.5
 * mask, and cross-reference with the RENDERED alpha of the emitted SVG. Names the
 * labels whose paint is absent or scrubbed off, plus each one's path-data intro.
 */
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { TUNING, coreOptions, type PresetId } from "../src/trace.server";
import { segment } from "../src/segment";
import { labelStats, layerCoverage, layerField, smoothField, fieldMargin, contoursForField } from "../src/trace-core.server";

const FIX = "/home/team/shared/trace-lab/fixtures";
const FILES: Record<PresetId, string> = { logo: "logo-flat.png", lineart: "lineart-thin-diagonal.png", photo: "photo-portrait.jpg", pattern: "pattern-textile.png" };
const preset = (process.argv[2] ?? "pattern") as PresetId;
const svgPath = process.argv[3] ?? `/home/team/shared/trace-lab/svg/${preset}.svg`;
const detail = 0.5;
const t = TUNING[preset];
const core = coreOptions(preset, detail);

const src = await sharp(`${FIX}/${FILES[preset]}`).metadata();
const longEdge = Math.max(src.width!, src.height!);
const target = Math.min(t.maxDim, Math.max(t.minDim, longEdge));
let p = sharp(`${FIX}/${FILES[preset]}`).rotate();
if (target !== longEdge) p = p.resize({ width: Math.round((src.width! * target) / longEdge), height: Math.round((src.height! * target) / longEdge), fit: "fill", kernel: "lanczos3" });
p = p.flatten({ background: "#ffffff" }).toColourspace("srgb");
if (t.denoise > 1) p = p.median(t.denoise);
if (t.blur > 0) p = p.blur(t.blur);
if (t.saturation !== 1) p = p.modulate({ saturation: t.saturation });
const { data: px, info } = await p.raw().toBuffer({ resolveWithObject: true });
const width = info.width, height = info.height;
const rgb = Buffer.alloc(width * height * 3);
for (let i = 0; i < width * height; i++) { const s = i * info.channels; rgb[i * 3] = px[s]; rgb[i * 3 + 1] = px[s + 1]; rgb[i * 3 + 2] = px[s + 2]; }

const wanted = Math.round(t.regions[0] + (t.regions[1] - t.regions[0]) * detail);
const seg = segment(rgb, 3, width, height, {
  tolerance: t.tolerance[0] + (t.tolerance[1] - t.tolerance[0]) * detail,
  maxRegions: wanted, minArea: t.minArea[0] + (t.minArea[1] - t.minArea[0]) * detail,
  mergeBands: t.mergeBands, bandWidth: t.bandWidth,
});
const stats = labelStats(seg.labels, width, height, seg.count);
const cov = layerCoverage(seg.labels, seg.palette, rgb, 3, width, height);

// rendered alpha of the emitted SVG
const svg = await readFile(svgPath, "utf8");
const { data: ren, info: ri } = await sharp(Buffer.from(svg), { density: 72 * (width / Number(/width="(\d+)"/.exec(svg)![1])) }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
console.log(`render ${ri.width}x${ri.height} for label map ${width}x${height}`);
const painted = new Uint8Array(width * height);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const sx = Math.min(ri.width - 1, Math.round(x * ri.width / width));
  const sy = Math.min(ri.height - 1, Math.round(y * ri.height / height));
  if (ren[(sy * ri.width + sx) * 4 + 3] >= 8) painted[y * width + x] = 1;
}
let totalLost = 0;
const rows: { label: number; area: number; lost: number; colour: string; bbox: number[]; shapes: number; head: string }[] = [];
for (let label = 0; label < seg.count; label++) {
  const area = seg.areas[label];
  if (area === 0) continue;
  const [bx0, by0, bx1, by1] = stats[label].bbox;
  const margin = fieldMargin(core.sigma);
  const fw = bx1 - bx0 + 1 + 2 * margin, fh = by1 - by0 + 1 + 2 * margin;
  const field = smoothField(layerField(seg.labels, cov, label, width, height, bx0 - margin, by0 - margin, fw, fh), fw, fh, core.sigma);
  let n = 0, lost = 0;
  for (let fy = 0; fy < fh; fy++) {
    const sy = by0 - margin + fy; if (sy < 0 || sy >= height) continue;
    for (let fx = 0; fx < fw; fx++) {
      const sx = bx0 - margin + fx; if (sx < 0 || sx >= width) continue;
      if (field[fy * fw + fx] >= 0.5) { n++; if (!painted[sy * width + sx]) lost++; }
    }
  }
  totalLost += lost;
  const shapes = contoursForField(field, fw, fh, bx0 - margin, by0 - margin, core);
  if (lost > Math.max(60, n * 0.3)) rows.push({ label, area, lost, colour: "#" + seg.palette[label].toString(16).padStart(6, "0"), bbox: [bx0, by0, bx1, by1], shapes: shapes.length, head: shapes[0]?.d.slice(0, 90) ?? "" });
}
rows.sort((a, b) => b.lost - a.lost);
console.log(`total field coverage pixels lost in render: ${totalLost} (${(totalLost / (width * height) * 100).toFixed(2)}%) in ${rows.length} labels`);
for (const r of rows.slice(0, 12)) console.log(`  label ${r.label} area ${r.area} lost ${r.lost} shapes ${r.shapes} ${r.colour} bbox ${r.bbox.join(",")}\n      ${r.head}`);
// how many layers were emitted at all
let emitted = 0, rings = 0;
for (let label = 0; label < seg.count; label++) {
  const area = seg.areas[label];
  if (area === 0) continue;
  const [bx0, by0, bx1, by1] = stats[label].bbox;
  const margin = fieldMargin(core.sigma);
  const fw = bx1 - bx0 + 1 + 2 * margin, fh = by1 - by0 + 1 + 2 * margin;
  const field = smoothField(layerField(seg.labels, cov, label, width, height, bx0 - margin, by0 - margin, fw, fh), fw, fh, core.sigma);
  const s = contoursForField(field, fw, fh, bx0 - margin, by0 - margin, core);
  if (s.length) { emitted++; rings += s.length; }
}
console.log(`labels with contours: ${emitted}; rings ${rings}; svg paths ${(svg.match(/<path\b/g) ?? []).length}; svg M ${(svg.match(/M/g) ?? []).length}`);
const byAreaSum = new Int32Array(24);
for (let i = 0; i < width * height; i++) byAreaSum[Math.min(23, seg.areas[seg.labels[i]] >>> 5)]++;
void byAreaSum; void writeFile;
